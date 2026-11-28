import { Context, Effect, Layer, Predicate, PubSub, Schema, Stream } from "effect"
import {
  type Intelligence,
  intelligenceModels,
  type Item,
  type PermissionMode,
  type Question,
  type ThreadStatus,
  type ThreadSummary,
  type Todo,
  type UpdateStatus
} from "../../../shared/domain.ts"
import type { AppEvent } from "../../../shared/ipc.ts"
import { updateLine } from "../format.ts"
import { Bridge } from "../services/Bridge.ts"

export const VoiceEvent = Schema.Union([
  Schema.TaggedStruct("Started", {}),
  Schema.TaggedStruct("Heard", { role: Schema.Literals(["user", "assistant"]), delta: Schema.String }),
  Schema.TaggedStruct("UsedTool", { name: Schema.String }),
  /** The assistant was asked to put a thread on screen, or `null` for the list. */
  Schema.TaggedStruct("Show", { threadId: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("Ended", { reason: Schema.NullOr(Schema.String) })
])
export type VoiceEvent = typeof VoiceEvent.Type

export class VoiceStartError extends Schema.TaggedError<VoiceStartError>()("VoiceStartError", {
  message: Schema.String
}) {}

const ToolCall = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String
})
const decodeToolCall = Schema.decodeUnknownOption(ToolCall)

const iceGathered = (connection: RTCPeerConnection) =>
  new Promise<void>((resolve) => {
    if (connection.iceGatheringState === "complete") return resolve()
    const check = () => {
      if (connection.iceGatheringState !== "complete") return
      connection.removeEventListener("icegatheringstatechange", check)
      resolve()
    }
    connection.addEventListener("icegatheringstatechange", check)
    // A network without a full candidate set still gets an offer.
    setTimeout(resolve, 4000)
  })

/**
 * How loud each pitch is right now, for both sides of the conversation. Each
 * array holds one byte per frequency band, lowest first. `binHz` is the width
 * of a band, so a reader can find a pitch. A side that has no sound yet is `null`.
 */
export interface Spectrum {
  readonly input: Uint8Array | null
  readonly output: Uint8Array | null
  readonly binHz: number
}

const SILENCE: Spectrum = { input: null, output: null, binHz: 0 }

/** Enough resolution to tell a low voice from a high one: about 47Hz a band. */
const FFT_SIZE = 1024

interface Meter {
  readonly analyser: AnalyserNode
  readonly bands: Uint8Array<ArrayBuffer>
}

const meter = (context: AudioContext, stream: MediaStream): Meter => {
  const analyser = context.createAnalyser()
  analyser.fftSize = FFT_SIZE
  analyser.smoothingTimeConstant = 0.55
  // Analysed only: nothing is routed to the speakers from here.
  context.createMediaStreamSource(stream).connect(analyser)
  return { analyser, bands: new Uint8Array(analyser.frequencyBinCount) }
}

interface Session {
  readonly connection: RTCPeerConnection
  readonly channel: RTCDataChannel
  readonly microphone: MediaStream
  readonly audio: HTMLAudioElement
  readonly context: AudioContext
  readonly input: Meter
  /** The other side's voice, once its audio arrives. */
  output: Meter | null
  /** Stops listening to the board. */
  stopWatching: () => void
}

/** What the voice session was last told about a thread. */
interface Seen {
  readonly status: ThreadStatus
  readonly pending: number
  readonly questions: number
  readonly askedAt: number
}

/** A context append is limited to 500 tokens, so updates are kept short. */
const MAX_UPDATE = 900
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A task list in a sentence, for the voice model to pass on. */
const taskProgress = (todos: ReadonlyArray<Todo>) => {
  if (todos.length === 0) return "no task list"
  const done = todos.filter((todo) => todo.status === "completed").length
  const current = todos.find((todo) => todo.status === "in_progress")
  return `${done} of ${todos.length} done` + (current === undefined ? "" : `; now: ${current.activeForm}`)
}

const isIntelligence = (level: string): level is Intelligence => level in intelligenceModels

/** The words the voice tool uses for permission modes. */
const spokenModes: Record<string, PermissionMode> = {
  ask: "default",
  accept_edits: "acceptEdits",
  bypass: "bypassPermissions"
}

const boardBriefing = `While this conversation runs you receive board updates: a thread needs the user's
approval, a thread has a question for them, a thread finished, or a thread failed. Pass each one on to the user
in a sentence or two as soon as it arrives, even if they did not ask. When a thread has a question, read the
question and its options and pass on what they answer; never answer it for them. When a thread needs approval, say what it is asking for and ask the
user whether to allow it. If they answer, delegate their decision to the backend. Never approve or decline on
your own: the decision is always the user's, and this conversation is the only place they can give it.
If the user asks to stop being asked, or to allow everything, delegate that too: the backend can switch one
thread, or every thread in this conversation, to run without asking. Only ever on the user's explicit request.`

/**
 * One live voice conversation over WebRTC. Speech goes straight between this
 * page and OpenAI; the session itself is started by the main process, which
 * holds the API key.
 */
export class VoiceClient extends Context.Service<VoiceClient, {
  readonly start: Effect.Effect<void, VoiceStartError>
  readonly stop: Effect.Effect<void>
  readonly events: Stream.Stream<VoiceEvent>
  /** Says which thread the window is showing now, or `null` for the list. */
  readonly show: (threadId: string | null) => Effect.Effect<void>
  /** Reads the sound of both voices at this instant. Cheap enough to call every frame. */
  readonly spectrum: () => Spectrum
}>()("fai/renderer/VoiceClient") {
  static readonly layer = Layer.effect(
    VoiceClient,
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const hub = yield* PubSub.unbounded<VoiceEvent>()
      const emit = (event: VoiceEvent) => {
        PubSub.publishUnsafe(hub, event)
      }
      let session: Session | null = null
      /**
       * The thread the window is showing, or `null` for the list. The app
       * reports every change, whether or not a conversation is running, so a
       * conversation that starts later knows it too.
       */
      let onScreen: string | null = null

      /**
       * Ends the conversation. From this call on it is over here: the
       * microphone is released, the voice stops, and nothing the old session
       * still sends is listened to, so the next one can start at once.
       *
       * `byUser` is for a stop the person asked for. The server is told, and
       * the connection is held a moment so the message gets there. The
       * interface is not told: it already knows, and a late announcement could
       * land on the next conversation instead.
       */
      const teardown = (reason: string | null, byUser = false) => {
        if (session === null) return
        const ending = session
        session = null
        ending.stopWatching()
        heard.clear()
        asked.clear()
        awaitingDelete = null
        sessionMode = null
        for (const track of ending.microphone.getTracks()) track.stop()
        ending.audio.srcObject = null
        void ending.context.close().catch(() => undefined)
        const hangUp = () => {
          ending.channel.close()
          ending.connection.close()
        }
        if (byUser && ending.channel.readyState === "open") {
          ending.channel.send(JSON.stringify({ type: "session.close" }))
          setTimeout(hangUp, 400)
        } else {
          hangUp()
        }
        if (!byUser) emit({ _tag: "Ended", reason })
      }

      // -------------------------------------------------------------------
      // Approvals: the voice can only answer a request the user has heard
      // -------------------------------------------------------------------

      /** The mode the user asked for this conversation, used for threads it starts. */
      let sessionMode: PermissionMode | null = null

      /**
       * The thread a tool call is about. A real id is used as given. Without
       * one it is the thread on screen, and failing that a thread there can be
       * no doubt about: the only one working, or the only one at all.
       */
      const pick = (threads: ReadonlyArray<ThreadSummary>, threadId: string, orOnlyThread = false) => {
        const active = threads.filter((thread) => thread.status === "running" || thread.status === "waiting")
        return threads.find((thread) => thread.id === threadId) ??
          threads.find((thread) => thread.id === onScreen) ??
          (active.length === 1 ? active[0] : orOnlyThread && threads.length === 1 ? threads[0] : undefined)
      }

      const setPermissions = Effect.fnUntraced(function*(mode: PermissionMode, scope: string, threadId: string) {
        const threads = yield* bridge.call("threads.list", undefined).pipe(Effect.catch(() => Effect.succeed([])))
        const active = threads.filter((thread) => thread.status === "running" || thread.status === "waiting")
        const apply = (thread: ThreadSummary) =>
          Effect.ignore(bridge.call("threads.setMode", { id: thread.id, mode, source: "voice" }))
        if (scope === "session") {
          sessionMode = mode === "default" ? null : mode
          for (const thread of active) yield* apply(thread)
          return {
            mode,
            changed: active.map((thread) => thread.title),
            note: "Threads started later in this conversation use the same mode."
          }
        }
        const target = pick(threads, threadId)
        if (target === undefined) {
          return { error: "Say which thread: call list_threads and pass its thread_id, or use scope session." }
        }
        yield* apply(target)
        return { mode, changed: [target.title] }
      })

      const setIntelligence = Effect.fnUntraced(function*(level: Intelligence, threadId: string) {
        const threads = yield* bridge.call("threads.list", undefined).pipe(Effect.catch(() => Effect.succeed([])))
        const target = pick(threads, threadId, true)
        if (target === undefined) {
          return { error: "Say which thread: call list_threads and pass its thread_id." }
        }
        const model = intelligenceModels[level]
        yield* Effect.ignore(bridge.call("threads.setModel", { id: target.id, model, source: "voice" }))
        return { thread: target.title, level, model, note: "It applies from the thread's next step." }
      })

      const stopThread = Effect.fnUntraced(function*(threadId: string) {
        const threads = yield* bridge.call("threads.list", undefined).pipe(Effect.catch(() => Effect.succeed([])))
        const target = pick(threads, threadId)
        if (target === undefined) {
          return { error: "Say which thread: call list_threads and pass its thread_id." }
        }
        yield* Effect.ignore(bridge.call("threads.stop", { id: target.id }))
        return { stopped: target.title }
      })

      /** Request ids this session has described to the user, by thread. */
      const heard = new Map<string, Set<string>>()
      const markHeard = (threadId: string, requests: ReadonlyArray<{ readonly id: string }>) => {
        const ids = heard.get(threadId) ?? new Set<string>()
        for (const request of requests) ids.add(request.id)
        heard.set(threadId, ids)
      }

      /** What a thread is asking for right now, or `null` when there is no such thread. */
      const lookup = (threadId: string) =>
        bridge.call("threads.get", { id: threadId }).pipe(
          Effect.map((thread) =>
            thread === null ? null : thread.items.flatMap((item) =>
              item._tag === "Permission" && item.status === "pending"
                ? [{ id: item.id, text: `${item.toolName} ${item.summary}`.trim() }]
                : []
            )
          ),
          Effect.catch(() => Effect.succeed(null))
        )

      const pendingRequests = (threadId: string) => Effect.map(lookup(threadId), (requests) => requests ?? [])

      const answerApproval = Effect.fnUntraced(function*(threadId: string, decision: "allow" | "deny") {
        let id = threadId
        let pending = id === "" ? null : yield* lookup(id)
        // The model sometimes passes a title, or nothing, in place of an id.
        // Only then is the thread inferred, and only when exactly one thread
        // the user has heard about is waiting. A real id is never second-guessed.
        if (pending === null) {
          const asking = []
          for (const candidate of heard.keys()) {
            const requests = yield* pendingRequests(candidate)
            if (requests.length > 0) asking.push({ id: candidate, requests })
          }
          const only = asking.length === 1 ? asking[0] : undefined
          if (only === undefined) {
            return { error: "Say which thread: call list_threads and pass the thread_id of the one that needs approval." }
          }
          id = only.id
          pending = only.requests
        }
        if (pending.length === 0) return { error: "Nothing is waiting for approval on that thread." }
        const known = heard.get(id) ?? new Set<string>()
        const described = pending.filter((request) => known.has(request.id))
        const fresh = pending.filter((request) => !known.has(request.id))
        // Whatever comes back in this result is about to be read to the user.
        markHeard(id, fresh)
        if (described.length === 0) {
          return {
            error: "The user has not heard these requests yet. Describe them and ask before answering.",
            requests: fresh.map((request) => request.text)
          }
        }
        for (const request of described) {
          yield* bridge.call("threads.resolvePermission", { id, requestId: request.id, decision, source: "voice" }).pipe(
            Effect.ignore
          )
        }
        return {
          decision,
          answered: described.map((request) => request.text),
          ...(fresh.length > 0 ? { still_waiting_for_the_user: fresh.map((request) => request.text) } : {})
        }
      })

      // -------------------------------------------------------------------
      // Questions: a thread asks, the user answers, nobody answers for them
      // -------------------------------------------------------------------

      /**
       * Questions this conversation has put to the user, by item id, and
       * whether the user has said anything since. An answer is only passed on
       * for a question they have heard and then spoken after, so the model
       * cannot answer a thread out of its own head.
       */
      const asked = new Map<string, { spoke: boolean }>()

      /** What a thread is asking right now, or `null` when it is asking nothing. */
      const openQuestion = (threadId: string) =>
        bridge.call("threads.get", { id: threadId }).pipe(
          Effect.map((thread) =>
            thread?.items.findLast((item): item is Extract<Item, { _tag: "Question" }> =>
              item._tag === "Question" && item.status === "pending"
            ) ?? null
          ),
          Effect.catch(() => Effect.succeed(null))
        )

      /** A question and its choices in words, for the model to read out. */
      const spoken = (questions: ReadonlyArray<Question>) =>
        questions.map((question) => ({
          question: question.question,
          options: question.options.map((option) =>
            option.description === "" ? option.label : `${option.label} (${clip(option.description, 120)})`
          ),
          ...(question.multiSelect ? { may_choose_several: true } : {})
        }))

      const answerQuestion = Effect.fnUntraced(function*(threadId: string, answers: ReadonlyArray<string>) {
        const threads = yield* bridge.call("threads.list", undefined).pipe(Effect.catch(() => Effect.succeed([])))
        const asking = threads.filter((thread) => thread.pendingQuestions > 0)
        // A real id is used as given. Without one it is the thread on screen
        // if that one is asking, or the only thread that is.
        const target = threads.find((thread) => thread.id === threadId) ??
          asking.find((thread) => thread.id === onScreen) ??
          (asking.length === 1 ? asking[0] : undefined)
        if (target === undefined) {
          return {
            error: asking.length === 0
              ? "No thread is waiting on a question."
              : "Several threads have questions. Call list_threads and pass the thread_id of the one this answers."
          }
        }
        const item = yield* openQuestion(target.id)
        if (item === null) return { error: `The thread "${target.title}" is not waiting on a question.` }
        const state = asked.get(item.id)
        if (state === undefined || !state.spoke) {
          // Whatever comes back here is about to be read to the user.
          if (state === undefined) asked.set(item.id, { spoke: false })
          return {
            error: state === undefined
              ? "The user has not heard this question yet. Read it to them with its options and wait for their answer."
              : "The user has not answered yet. Ask them, and call this again only with what they say.",
            thread: target.title,
            questions: spoken(item.questions)
          }
        }
        if (answers.length !== item.questions.length) {
          return {
            error: `This thread asked ${item.questions.length} questions. Pass one answer for each, in order.`,
            questions: spoken(item.questions)
          }
        }
        yield* Effect.ignore(bridge.call("threads.answerQuestion", { id: target.id, questionId: item.id, answers }))
        asked.delete(item.id)
        return {
          thread: target.title,
          answered: item.questions.map((question, index) => ({ question: question.question, answer: answers[index] })),
          note: "The thread is carrying on with that answer."
        }
      })

      // -------------------------------------------------------------------
      // Deleting: one quiet thread on request, anything more after a yes
      // -------------------------------------------------------------------

      /**
       * A deletion the user has been asked to confirm: which threads, and
       * whether they have said anything since. The model cannot confirm for
       * them by calling twice in a row; only speech from the user unlocks it.
       */
      let awaitingDelete: { readonly key: string; spoke: boolean } | null = null

      const deleteThreads = Effect.fnUntraced(function*(ids: ReadonlyArray<string>) {
        const threads = yield* bridge.call("threads.list", undefined).pipe(Effect.catch(() => Effect.succeed([])))
        const wanted = [...new Set(ids)]
        const targets = threads.filter((thread) => wanted.includes(thread.id))
        if (targets.length === 0 || targets.length < wanted.length) {
          return { error: "Some of those are not thread ids. Call list_threads and pass thread_id values from it." }
        }
        const busy = targets.filter((thread) => thread.status === "running" || thread.status === "waiting")
        const key = targets.map((thread) => thread.id).sort().join(",")
        // One thread that is doing nothing goes on the user's word alone.
        // Several at once, or one still at work, is read back to them first.
        if (targets.length > 1 || busy.length > 0) {
          const confirmed = awaitingDelete !== null && awaitingDelete.key === key && awaitingDelete.spoke
          if (!confirmed) {
            awaitingDelete = { key, spoke: false }
            return {
              deleted: [],
              needs_confirmation: "Tell the user which threads these are and ask whether to delete them. " +
                "Call delete_threads again with the same thread_ids only after they have said yes.",
              threads: targets.map((thread) => ({ title: thread.title, status: thread.status }))
            }
          }
        }
        awaitingDelete = null
        for (const thread of targets) {
          yield* Effect.ignore(bridge.call("threads.delete", { id: thread.id }))
          heard.delete(thread.id)
        }
        return {
          deleted: targets.map((thread) => thread.title),
          ...(busy.length > 0 ? { stopped_first: busy.map((thread) => thread.title) } : {}),
          note: "The files these threads wrote are still on disk."
        }
      })

      // -------------------------------------------------------------------
      // The screen: which thread the window shows
      // -------------------------------------------------------------------

      const openThread = Effect.fnUntraced(function*(threadId: string) {
        const threads = yield* bridge.call("threads.list", undefined).pipe(Effect.catch(() => Effect.succeed([])))
        const target = threads.find((thread) => thread.id === threadId) ?? (threads.length === 1 ? threads[0] : undefined)
        if (target === undefined) {
          return { error: "Say which thread: call list_threads and pass its thread_id." }
        }
        emit({ _tag: "Show", threadId: target.id })
        return { showing: target.title }
      })

      /** Sends a follow-up to the thread named, or to the one on screen, and says which it was. */
      const sendToThread = Effect.fnUntraced(function*(threadId: string, message: string) {
        const threads = yield* bridge.call("threads.list", undefined).pipe(Effect.catch(() => Effect.succeed([])))
        const target = threads.find((thread) => thread.id === threadId) ??
          (threadId === "" ? threads.find((thread) => thread.id === onScreen) : undefined)
        if (target === undefined) {
          return {
            error: threadId === ""
              ? "No thread is open on screen. Call list_threads and pass the thread_id of the one this is for."
              : "No thread with that id. Call list_threads and pass a thread_id from it."
          }
        }
        return yield* bridge.call("threads.send", { id: target.id, text: message, source: "voice" }).pipe(
          Effect.as({
            sent_to: target.title,
            on_screen: target.id === onScreen,
            note: "The thread is working on it. You are told when it finishes."
          }),
          Effect.catch((error) => Effect.succeed({ error: error.message }))
        )
      })

      // -------------------------------------------------------------------
      // The app's own updates
      // -------------------------------------------------------------------

      const appUpdate = Effect.fnUntraced(function*(action: string) {
        const read = bridge.call("updates.get", undefined).pipe(Effect.catch(() => Effect.succeed(null)))
        const before = yield* read
        if (before === null) return { error: "The app could not say where its updates stand." }
        if (action === "install" && before.state._tag !== "Ready") {
          return { error: "No update is downloaded and waiting to be installed.", version: before.current, update: updateLine(before) }
        }
        if (action === "download" && before.state._tag !== "Available") {
          return { error: "There is no new version waiting to be downloaded.", version: before.current, update: updateLine(before) }
        }
        if (action === "check" || action === "download" || action === "install") {
          yield* Effect.ignore(bridge.call(`updates.${action}`, undefined))
          // A check takes a moment to come back with an answer.
          if (action === "check") yield* Effect.sleep("3 seconds")
        }
        const now = (yield* read) ?? before
        return {
          version: now.current,
          update: updateLine(now),
          ...(action === "install" ? { note: "The app is restarting now. This conversation ends with it." } : {})
        }
      })

      // -------------------------------------------------------------------
      // Tools the voice model can call to drive the board
      // -------------------------------------------------------------------

      const runTool = (name: string, args: Record<string, unknown>): Effect.Effect<unknown> => {
        const text = (key: string) => (Predicate.isString(args[key]) ? args[key] : "")
        switch (name) {
          case "start_thread":
            return bridge.call("threads.create", {
              prompt: text("prompt"),
              cwd: text("folder") === "" ? null : text("folder"),
              model: isIntelligence(text("intelligence")) ? intelligenceModels[text("intelligence") as Intelligence] : null,
              permissionMode: sessionMode,
              source: "voice"
            }).pipe(
              Effect.map((thread) => ({
                thread_id: thread.id,
                title: thread.title,
                status: thread.status,
                model: thread.model ?? "default"
              })),
              Effect.catch((error) => Effect.succeed({ error: error.message }))
            )
          case "set_intelligence": {
            const level = text("level")
            return isIntelligence(level)
              ? setIntelligence(level, text("thread_id"))
              : Effect.succeed({ error: "level must be low, medium, high or best." })
          }
          case "list_threads":
            return bridge.call("threads.list", undefined).pipe(
              Effect.map((threads) =>
                threads.slice(0, 60).map((thread) => ({
                  thread_id: thread.id,
                  title: thread.title,
                  status: thread.status,
                  activity: thread.activity,
                  latest: thread.preview,
                  artifacts: thread.artifacts.length,
                  needs_approval: thread.pendingPermissions > 0,
                  ...(thread.pendingQuestions > 0 ? { has_a_question_for_the_user: true } : {}),
                  tasks: taskProgress(thread.todos),
                  ...(thread.id === onScreen ? { on_screen: true } : {})
                }))
              ),
              Effect.catch((error) => Effect.succeed({ error: error.message }))
            )
          case "read_thread":
            return bridge.call("threads.get", { id: text("thread_id") || (onScreen ?? "") }).pipe(
              Effect.map((thread) =>
                thread === null
                  ? { error: "No thread with that id, and none is open on screen. Call list_threads." }
                  : {
                    title: thread.title,
                    status: thread.status,
                    messages: thread.items
                      .filter((item) => item._tag === "User" || item._tag === "Assistant")
                      .slice(-6)
                      .map((item) => ({ from: item._tag === "User" ? "user" : "claude", text: item.text.slice(0, 1200) })),
                    files_changed: thread.artifacts.map((artifact) => artifact.relPath),
                    tasks: thread.todos.map((todo) => `${todo.status}: ${todo.content}`)
                  }
              ),
              Effect.catch((error) => Effect.succeed({ error: error.message }))
            )
          case "message_thread":
            return sendToThread(text("thread_id"), text("text"))
          case "stop_thread":
            return stopThread(text("thread_id"))
          case "app_update":
            return appUpdate(text("action"))
          case "open_thread":
            return openThread(text("thread_id"))
          case "close_thread":
            return Effect.sync(() => {
              emit({ _tag: "Show", threadId: null })
              return { showing: "the list of threads" }
            })
          case "delete_threads": {
            const ids = Array.isArray(args.thread_ids) ? args.thread_ids.filter(Predicate.isString) : []
            return ids.length === 0
              ? Effect.succeed({ error: "Pass thread_ids: the thread_id of each thread to delete." })
              : deleteThreads(ids)
          }
          case "set_permissions": {
            const mode = spokenModes[text("mode")]
            return mode === undefined
              ? Effect.succeed({ error: "mode must be ask, accept_edits or bypass." })
              : setPermissions(mode, text("scope"), text("thread_id"))
          }
          case "answer_question": {
            const answers = Array.isArray(args.answers) ? args.answers.filter(Predicate.isString) : []
            return answers.length === 0
              ? Effect.succeed({ error: "Pass answers: what the user said, one entry per question." })
              : answerQuestion(text("thread_id"), answers)
          }
          case "answer_approval":
            return args.decision === "allow" || args.decision === "deny"
              ? answerApproval(text("thread_id"), args.decision)
              : Effect.succeed({ error: "decision must be allow or deny." })
          default:
            return Effect.succeed({ error: `Unknown tool ${name}.` })
        }
      }

      // -------------------------------------------------------------------
      // Board updates the voice model speaks without being asked
      // -------------------------------------------------------------------

      let updates = 0
      const say = (channel: RTCDataChannel, content: string) => {
        if (channel.readyState !== "open") return
        channel.send(JSON.stringify({
          type: "session.commentary.append",
          event_id: `board_${++updates}`,
          delegation_id: null,
          content: clip(content, MAX_UPDATE)
        }))
      }

      const watchBoard = (channel: RTCDataChannel): (() => void) => {
        const seen = new Map<string, Seen>()
        const askTimers = new Map<string, ReturnType<typeof setTimeout>>()
        let primed = false

        // Several requests in a row are one interruption: an ask is announced
        // after a short settle, and at most once every few seconds per thread.
        const scheduleAsk = (id: string, title: string) => {
          if (askTimers.has(id)) return
          const sinceLast = Date.now() - (seen.get(id)?.askedAt ?? 0)
          const wait = Math.max(1200, 8000 - sinceLast)
          askTimers.set(
            id,
            setTimeout(() => {
              askTimers.delete(id)
              const now = seen.get(id)
              if (now === undefined || now.pending === 0) return
              seen.set(id, { ...now, askedAt: Date.now() })
              void Effect.runPromise(pendingRequests(id)).then((requests) => {
                if (requests.length === 0) return
                const described = requests.slice(0, 3)
                markHeard(id, described)
                say(
                  channel,
                  `Board update: the thread "${title}" is paused and needs the user's approval. Claude wants to use ` +
                    `${described.map((request) => request.text).join("; ")}. Ask the user whether to allow it.`
                )
              })
            }, wait)
          )
        }

        /** Puts a thread's question to the user, once. */
        const relayQuestion = (id: string, title: string) => {
          void Effect.runPromise(openQuestion(id)).then((item) => {
            if (item === null || asked.has(item.id)) return
            asked.set(item.id, { spoke: false })
            say(
              channel,
              `Board update: the thread "${title}" has stopped to ask the user a question and is waiting. ` +
                spoken(item.questions).map((entry) =>
                  `${entry.question} Options: ${entry.options.join("; ")}.` +
                  ("may_choose_several" in entry ? " They may choose more than one." : "")
                ).join(" ") +
                " Read it to the user and pass their answer on with answer_question. Do not answer for them."
            )
          })
        }

        const consider = (threads: ReadonlyArray<ThreadSummary>) => {
          for (const thread of threads) {
            const before = seen.get(thread.id)
            seen.set(thread.id, {
              status: thread.status,
              pending: thread.pendingPermissions,
              questions: thread.pendingQuestions,
              askedAt: before?.askedAt ?? 0
            })
            if (!primed) continue
            const title = clip(thread.title, 90)
            if (thread.pendingQuestions > 0 && (before === undefined || before.questions === 0)) {
              relayQuestion(thread.id, title)
            } else if (thread.pendingPermissions > 0 && (before === undefined || before.pending === 0)) {
              scheduleAsk(thread.id, title)
            } else if (before !== undefined && before.status !== thread.status && thread.status === "done") {
              const files = thread.artifacts.length
              say(
                channel,
                `Board update: the thread "${title}" finished.` +
                  (files > 0 ? ` It changed ${files} ${files === 1 ? "file" : "files"}.` : "") +
                  (thread.preview === "" ? "" : ` Claude's last message: ${clip(thread.preview, 400)}`)
              )
            } else if (before !== undefined && before.status !== thread.status && thread.status === "error") {
              say(channel, `Board update: the thread "${title}" stopped with an error and needs a look.`)
            }
          }
        }

        // A new version is said once, when there is something for the user to decide.
        let toldUpdate = ""
        const considerUpdate = (status: UpdateStatus) => {
          const state = status.state
          if (state._tag !== "Ready" && state._tag !== "Available") return
          const key = `${state._tag} ${state.version}`
          if (key === toldUpdate) return
          // A version that downloads on its own is worth saying once it is ready, not before.
          if (state._tag === "Available" && status.mode !== "offer") return
          toldUpdate = key
          say(
            channel,
            state._tag === "Ready"
              ? `Board update: version ${state.version} of this app has been downloaded and is ready. Tell the user. ` +
                "It goes in when the app restarts: restart it with app_update only if they ask you to."
              : `Board update: version ${state.version} of this app is available. Tell the user and ask whether to download it.`
          )
        }

        const unsubscribe = window.fai.subscribe((event: AppEvent) => {
          if (event._tag === "Summaries") consider(event.summaries)
          if (event._tag === "Update") considerUpdate(event.status)
        })
        // What was already finished before the session began is not news, but a
        // thread that is waiting for approval right now is worth saying.
        void window.fai.invoke("threads.list", undefined).then((reply) => {
          const threads = reply.ok ? reply.value as ReadonlyArray<ThreadSummary> : []
          consider(threads)
          primed = true
          for (const thread of threads) {
            if (thread.pendingQuestions > 0) relayQuestion(thread.id, clip(thread.title, 90))
            else if (thread.pendingPermissions > 0) scheduleAsk(thread.id, clip(thread.title, 90))
          }
        })
        return () => {
          unsubscribe()
          for (const timer of askTimers.values()) clearTimeout(timer)
          askTimers.clear()
        }
      }

      // -------------------------------------------------------------------
      // The screen: telling the conversation what the user is looking at
      // -------------------------------------------------------------------

      let screenNotes = 0
      /** Tells the conversation, without it speaking, which thread is open. */
      const tellScreen = async (channel: RTCDataChannel) => {
        const showing = onScreen
        const reply = showing === null ? null : await window.fai.invoke("threads.list", undefined)
        const threads = reply !== null && reply.ok ? reply.value as ReadonlyArray<ThreadSummary> : []
        const thread = threads.find((candidate) => candidate.id === showing)
        // Stale by the time the list came back: a newer note is on its way.
        if (showing !== onScreen || channel.readyState !== "open") return
        channel.send(JSON.stringify({
          type: "session.instructions.append",
          event_id: `screen_${++screenNotes}`,
          delegation_id: null,
          content: thread === undefined
            ? "Screen: the user is now looking at the list of threads. No thread is open. Do not mention this."
            : `Screen: the user now has the thread "${clip(thread.title, 90)}" open (thread_id ${thread.id}, ` +
              `${thread.status}). Until told otherwise, what they say is about this thread unless it clearly is ` +
              "not: follow-ups for it go to this thread, not to a new one. Do not mention this."
        }))
      }

      const show = (threadId: string | null) =>
        Effect.sync(() => {
          if (threadId === onScreen) return
          onScreen = threadId
          if (session !== null) void tellScreen(session.channel)
        })

      // Results are sent back together, then the backend is resumed once.
      let calls: Array<Promise<{ readonly callId: string; readonly output: string }>> = []
      let flushTimer: ReturnType<typeof setTimeout> | null = null
      const flushCalls = async (channel: RTCDataChannel) => {
        const batch = calls
        calls = []
        const results = await Promise.all(batch)
        if (channel.readyState !== "open") return
        for (const result of results) {
          channel.send(JSON.stringify({
            type: "response.item.create",
            item: { type: "function_call_output", call_id: result.callId, output: result.output }
          }))
        }
        channel.send(JSON.stringify({ type: "response.create" }))
      }

      const onServerEvent = (channel: RTCDataChannel, data: unknown) => {
        // A conversation that has been closed has nothing more to say.
        if (session?.channel !== channel) return
        if (!Predicate.isString(data)) return
        let event: unknown
        try {
          event = JSON.parse(data)
        } catch {
          return
        }
        if (!Predicate.isObject(event) || !("type" in event)) return
        switch (event.type) {
          case "session.started":
            channel.send(JSON.stringify({
              type: "session.instructions.append",
              event_id: "board_briefing",
              delegation_id: null,
              content: boardBriefing
            }))
            if (session !== null) session.stopWatching = watchBoard(channel)
            if (onScreen !== null) void tellScreen(channel)
            emit({ _tag: "Started" })
            break
          case "session.input_transcript.delta":
          case "session.output_transcript.delta":
            // Anything the user says after being asked counts as their answer
            // having been given; what they said is for the model to judge.
            if (event.type === "session.input_transcript.delta") {
              if (awaitingDelete !== null) awaitingDelete.spoke = true
              for (const question of asked.values()) question.spoke = true
            }
            if ("delta" in event && Predicate.isString(event.delta)) {
              emit({
                _tag: "Heard",
                role: event.type === "session.input_transcript.delta" ? "user" : "assistant",
                delta: event.delta
              })
            }
            break
          case "response.event": {
            const inner = "event" in event ? event.event : undefined
            if (!Predicate.isObject(inner) || !("type" in inner) || inner.type !== "response.output_item.done") break
            const call = decodeToolCall("item" in inner ? inner.item : undefined)
            if (call._tag === "None") break
            let args: Record<string, unknown> = {}
            try {
              const parsed: unknown = JSON.parse(call.value.arguments)
              if (Predicate.isObject(parsed)) args = parsed as Record<string, unknown>
            } catch {
              // An empty argument object is a valid call for the tools without parameters.
            }
            emit({ _tag: "UsedTool", name: call.value.name })
            calls.push(
              Effect.runPromise(runTool(call.value.name, args)).then((output) => ({
                callId: call.value.call_id,
                output: JSON.stringify(output)
              }))
            )
            if (flushTimer !== null) clearTimeout(flushTimer)
            flushTimer = setTimeout(() => void flushCalls(channel), 150)
            break
          }
          case "error": {
            const detail = "error" in event && Predicate.isObject(event.error) && "message" in event.error
              ? String(event.error.message)
              : "The voice session reported an error."
            teardown(detail)
            break
          }
          case "session.closed":
            teardown(null)
            break
        }
      }

      /**
       * Every press of the control, start or stop, is counted. Starting takes
       * several steps that wait on the microphone and the network, and the next
       * press can land between any two of them. A start remembers its number
       * and gives up quietly as soon as the count has moved on, so the latest
       * press always wins, however quickly they come.
       */
      let presses = 0

      const connect = async (stale: () => boolean) => {
        if (session !== null) return
        // Ask for the key before the microphone, so nobody grants access for nothing.
        const settings = await window.fai.invoke("settings.get", undefined)
        if (stale()) return
        if (settings.ok && !(settings.value as { readonly hasOpenAiKey: boolean }).hasOpenAiKey) {
          throw new Error("Add an OpenAI API key in Settings to use live voice.")
        }
        const microphone = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (stale()) {
          // Stopped while the microphone was being opened: let go of it again.
          for (const track of microphone.getTracks()) track.stop()
          return
        }
        const connection = new RTCPeerConnection()
        const audio = new Audio()
        audio.autoplay = true
        const context = new AudioContext()
        const input = meter(context, microphone)
        for (const track of microphone.getAudioTracks()) connection.addTrack(track, microphone)
        // The event channel has to exist before the offer is made.
        const channel = connection.createDataChannel("oai-events")
        const mine: Session = { connection, channel, microphone, audio, context, input, output: null, stopWatching: () => undefined }
        session = mine
        connection.addEventListener("track", (event) => {
          if (session !== mine) return
          const remote = new MediaStream([event.track])
          audio.srcObject = remote
          void audio.play().catch(() => undefined)
          mine.output = meter(context, remote)
        })
        channel.addEventListener("message", ({ data }) => onServerEvent(channel, data))
        connection.addEventListener("connectionstatechange", () => {
          if (session !== mine) return
          if (connection.connectionState === "failed" || connection.connectionState === "disconnected") {
            teardown("The voice connection dropped.")
          }
        })
        try {
          await connection.setLocalDescription(await connection.createOffer())
          await iceGathered(connection)
          // Stopped already: do not open a session on the server for nobody.
          if (session !== mine) return
          const reply = await window.fai.invoke("voice.connect", { sdp: connection.localDescription?.sdp ?? "" })
          if (session !== mine) return
          if (!reply.ok) throw new Error(reply.error)
          const answer = reply.value as { readonly sdp: string }
          await connection.setRemoteDescription({ type: "answer", sdp: answer.sdp })
        } catch (error) {
          // Stopped while it was still connecting: that was asked for, and
          // everything is already closed. It is not a failure to report.
          if (session !== mine) return
          session = null
          for (const track of microphone.getTracks()) track.stop()
          connection.close()
          void context.close().catch(() => undefined)
          throw error
        }
      }

      const start = Effect.tryPromise({
        try: async () => {
          const press = ++presses
          const stale = () => press !== presses
          try {
            await connect(stale)
          } catch (error) {
            // Whatever went wrong belongs to a conversation nobody wants any more.
            if (stale()) return
            throw error
          }
        },
        catch: (error) =>
          new VoiceStartError({
            message: error instanceof DOMException && error.name === "NotAllowedError"
              ? "Microphone access was declined. Allow it in System Settings, Privacy, Microphone."
              : error instanceof Error
              ? error.message
              : "Live voice could not start."
          })
      })

      const stop = Effect.sync(() => {
        // Counted first, so a start that is still on its way gives up.
        presses++
        teardown(null, true)
      })

      yield* Effect.addFinalizer(() => Effect.sync(() => teardown(null)))

      const spectrum = (): Spectrum => {
        if (session === null) return SILENCE
        session.input.analyser.getByteFrequencyData(session.input.bands)
        session.output?.analyser.getByteFrequencyData(session.output.bands)
        return {
          input: session.input.bands,
          output: session.output?.bands ?? null,
          binHz: session.context.sampleRate / FFT_SIZE
        }
      }

      return VoiceClient.of({ start, stop, events: Stream.fromPubSub(hub), show, spectrum })
    })
  ).pipe(Layer.provide(Bridge.layer))
}
