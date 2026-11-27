import type { PermissionResult, PermissionUpdate, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Context, Effect, Layer, Option, Predicate, Schema, Stream } from "effect"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  type Account,
  type Artifact,
  type InputSource,
  type Item,
  type PermissionMode,
  Thread,
  type ThreadSummary,
  type Todo
} from "../../shared/domain.ts"
import { type AgentSession, openSession, sdkMode } from "./agent.ts"
import { Events } from "./Events.ts"
import { SettingsStore } from "./SettingsStore.ts"
import { Storage } from "./Storage.ts"

// The transcript is mutated in place while a turn streams, then sent to the
// renderer as snapshots.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type MutableItem = { [K in Item["_tag"]]: Mutable<Extract<Item, { _tag: K }>> }[Item["_tag"]]
type MutableThread = Omit<Mutable<Thread>, "items" | "artifacts" | "stats" | "todos"> & {
  items: Array<MutableItem>
  artifacts: Array<Mutable<Artifact>>
  todos: Array<Mutable<Todo>>
  stats: Mutable<Thread["stats"]>
}

type Decision = "allow" | "always" | "deny"

export class ThreadError extends Schema.TaggedError<ThreadError>()("ThreadError", {
  message: Schema.String
}) {}

/** A folder as someone would say it: absolute, under `~`, or inside the default folder. */
const resolveFolder = (folder: string, base: string) =>
  folder === "~" || folder.startsWith("~/")
    ? path.join(os.homedir(), folder.slice(1))
    : path.resolve(base, folder)

/** What exists only while the app is running. */
interface Live {
  session: AgentSession | null
  stopping: boolean
  /** The session the user stopped. Whatever it reports after that is not an error. */
  interrupted: AgentSession | null
  /** Streaming assistant items by content-block index of the current message. */
  readonly streaming: Map<number, string>
  /** Streaming assistant items not yet confirmed by a complete message. */
  readonly openText: Array<string>
  readonly pending: Map<string, (decision: Decision) => void>
  /** Files a running tool call will write, by tool-use id. */
  readonly writes: Map<string, { readonly path: string; readonly kind: Artifact["kind"] }>
  /** Tasks a running TaskCreate call will add, by tool-use id. */
  readonly creates: Map<string, { readonly content: string; readonly activeForm: string }>
}

const MAX_TOOL_TEXT = 6_000
const clip = (text: string, max = MAX_TOOL_TEXT) =>
  text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text

const oneLine = (text: string, max = 140) => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const stringField = (input: Record<string, unknown>, ...keys: ReadonlyArray<string>): string | null => {
  for (const key of keys) {
    const value = input[key]
    if (Predicate.isString(value) && value !== "") return value
  }
  return null
}

const WRITE_TOOLS: Record<string, Artifact["kind"]> = {
  Write: "created",
  Edit: "edited",
  MultiEdit: "edited",
  NotebookEdit: "edited"
}

const toolSummary = (name: string, input: Record<string, unknown>, cwd: string): string => {
  const file = stringField(input, "file_path", "notebook_path", "path")
  switch (name) {
    case "Bash":
      return oneLine(stringField(input, "command") ?? "")
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file === null ? "" : path.relative(cwd, file) || file
    case "Glob":
    case "Grep":
      return oneLine(stringField(input, "pattern") ?? "")
    case "WebFetch":
      return oneLine(stringField(input, "url") ?? "")
    case "WebSearch":
      return oneLine(stringField(input, "query") ?? "")
    case "Task":
    case "Agent":
      return oneLine(stringField(input, "description", "prompt") ?? "")
    case "TodoWrite":
      return Array.isArray(input.todos) ? `${input.todos.length} tasks` : ""
    default:
      return oneLine(stringField(input, "description", "command", "query", "prompt", "url") ?? "")
  }
}

const resultText = (content: unknown): string => {
  if (Predicate.isString(content)) return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block: unknown) =>
      Predicate.isObject(block) && "text" in block && Predicate.isString(block.text)
        ? block.text
        : Predicate.isObject(block) && "type" in block
        ? `[${String(block.type)}]`
        : ""
    )
    .join("\n")
}

/**
 * The tools an agent keeps its task list with, and the one it looks other
 * tools up with. They are bookkeeping, not steps of the work.
 */
const TASK_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ToolSearch"])

const todoStatus = (value: unknown): Todo["status"] =>
  value === "in_progress" || value === "completed" ? value : "pending"

/** Applies a task-tool call to the list. `TaskCreate` waits for its result, which carries the id. */
const applyTaskTool = (
  thread: MutableThread,
  live: Live,
  toolUseId: string,
  name: string,
  input: Record<string, unknown>
) => {
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    thread.todos = input.todos.filter(Predicate.isObject).map((todo: Record<string, unknown>, index) => {
      const content = Predicate.isString(todo.content) ? todo.content : ""
      return {
        id: String(index + 1),
        content,
        activeForm: Predicate.isString(todo.activeForm) && todo.activeForm !== "" ? todo.activeForm : content,
        status: todoStatus(todo.status)
      }
    })
  } else if (name === "TaskCreate") {
    const content = stringField(input, "subject") ?? ""
    live.creates.set(toolUseId, { content, activeForm: stringField(input, "activeForm") ?? content })
  } else if (name === "TaskUpdate") {
    const id = stringField(input, "taskId")
    if (input.status === "deleted") {
      thread.todos = thread.todos.filter((todo) => todo.id !== id)
      return
    }
    const todo = thread.todos.find((todo) => todo.id === id)
    if (!todo) return
    const content = stringField(input, "subject")
    if (content !== null) todo.content = content
    todo.activeForm = stringField(input, "activeForm") ?? (content ?? todo.activeForm)
    if (input.status !== undefined) todo.status = todoStatus(input.status)
  }
}

const titleOf = (prompt: string) => oneLine(prompt, 72) || "New thread"

const summaryOf = (thread: MutableThread): ThreadSummary => {
  let preview = ""
  let activity = ""
  let pendingPermissions = 0
  let messages = 0
  for (const item of thread.items) {
    if (item._tag === "Assistant" || item._tag === "User") {
      messages++
      if (item.text.trim() !== "") preview = item.text
    }
    if (item._tag === "Permission" && item.status === "pending") pendingPermissions++
  }
  if (thread.status === "waiting") {
    activity = "Needs your approval"
  } else if (thread.status === "running") {
    const last = thread.items.at(-1)
    const current = thread.todos.find((todo) => todo.status === "in_progress")
    // What the agent says it is doing beats the name of the tool it is using.
    activity = current !== undefined
      ? current.activeForm
      : last?._tag === "Tool" && last.status === "running"
      ? `${last.name} ${last.summary}`.trim()
      : last?._tag === "Assistant" && last.streaming
      ? "Writing"
      : "Thinking"
  }
  const { items: _items, ...rest } = thread
  // The board shows plain text, so the common Markdown marks are dropped.
  const plain = preview.replace(/[`*_#>]+/g, "").replace(/\s+/g, " ")
  return { ...rest, preview: oneLine(plain, 220), activity, pendingPermissions, messages }
}

export class Threads extends Context.Service<Threads, {
  readonly list: Effect.Effect<ReadonlyArray<ThreadSummary>>
  get(id: string): Effect.Effect<Thread | null>
  create(input: {
    readonly prompt: string
    readonly cwd: string | null
    readonly model: string | null
    readonly permissionMode: PermissionMode | null
    readonly source: InputSource
  }): Effect.Effect<ThreadSummary, ThreadError>
  send(id: string, text: string, source: InputSource): Effect.Effect<void>
  stop(id: string): Effect.Effect<void>
  remove(id: string): Effect.Effect<void>
  setMode(id: string, mode: PermissionMode, source: InputSource): Effect.Effect<void>
  resolvePermission(id: string, requestId: string, decision: Decision, source: InputSource): Effect.Effect<void>
  artifact(threadId: string, artifactId: string): Effect.Effect<Artifact | null>
  /** The folder a thread works in, or `null` when there is no such thread. */
  cwd(threadId: string): Effect.Effect<string | null>
  /** Changes the model a thread runs on, from its next step. */
  setModel(id: string, model: string, source: InputSource): Effect.Effect<void>
  readonly account: Effect.Effect<Account>
}>()("foc/main/Threads") {
  static readonly layer = Layer.effect(
    Threads,
    Effect.gen(function*() {
      const storage = yield* Storage
      const settings = yield* SettingsStore
      const events = yield* Events
      const scope = yield* Effect.scope

      const threads = new Map<string, MutableThread>()
      const lives = new Map<string, Live>()
      const dirty = new Set<string>()
      const unsaved = new Set<string>()
      let summariesDirty = false
      let account: Account = { state: "unknown", detail: "", claudeVersion: "" }

      const liveOf = (id: string): Live => {
        let live = lives.get(id)
        if (!live) {
          live = {
            session: null,
            stopping: false,
            interrupted: null,
            streaming: new Map(),
            openText: [],
            pending: new Map(),
            writes: new Map(),
            creates: new Map()
          }
          lives.set(id, live)
        }
        return live
      }

      const touch = (thread: MutableThread) => {
        thread.updatedAt = Date.now()
        dirty.add(thread.id)
        unsaved.add(thread.id)
        summariesDirty = true
      }

      const summaries = () =>
        [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summaryOf)

      const snapshot = (thread: MutableThread): Thread => ({
        ...thread,
        items: thread.items.map((item) => ({ ...item })),
        artifacts: thread.artifacts.map((artifact) => ({ ...artifact })),
        todos: thread.todos.map((todo) => ({ ...todo })),
        stats: { ...thread.stats }
      })

      const notice = (thread: MutableThread, level: "info" | "error", text: string) => {
        thread.items.push({ _tag: "Notice", id: randomUUID(), level, text, at: Date.now() })
      }

      const setAccount = (next: Account) => {
        account = next
        events.publish({ _tag: "Account", account })
      }

      // ---------------------------------------------------------------------
      // Restore what the last run saved
      // ---------------------------------------------------------------------

      const decodeThread = Schema.decodeUnknownOption(Thread)
      for (const file of yield* storage.list("threads")) {
        if (!file.endsWith(".json")) continue
        const raw = yield* storage.readJson(path.join("threads", file))
        // Threads saved before task lists existed simply have none.
        const decoded = decodeThread(Predicate.isObject(raw) ? { todos: [], ...raw } : raw)
        if (Option.isNone(decoded)) continue
        const thread = structuredClone(decoded.value) as MutableThread
        // A turn that was running when the app closed is gone.
        const interrupted = thread.status === "running" || thread.status === "waiting"
        for (const item of thread.items) {
          if (item._tag === "Assistant") item.streaming = false
          if (item._tag === "Tool" && item.status === "running") item.status = "error"
          if (item._tag === "Permission" && item.status === "pending") item.status = "denied"
        }
        if (interrupted) {
          thread.status = "error"
          notice(thread, "info", "This turn was interrupted when the app closed. Send a message to continue.")
        }
        threads.set(thread.id, thread)
      }

      // ---------------------------------------------------------------------
      // Publish and persist on a short timer, so streaming stays cheap
      // ---------------------------------------------------------------------

      const flush = Effect.sync(() => {
        for (const id of dirty) {
          const thread = threads.get(id)
          if (thread) events.publish({ _tag: "Thread", thread: snapshot(thread) })
        }
        dirty.clear()
        if (summariesDirty) {
          summariesDirty = false
          events.publish({ _tag: "Summaries", summaries: summaries() })
        }
      })

      const save = Effect.gen(function*() {
        const ids = [...unsaved]
        unsaved.clear()
        for (const id of ids) {
          const thread = threads.get(id)
          if (thread) yield* storage.writeJson(path.join("threads", `${id}.json`), snapshot(thread))
        }
      })

      yield* flush.pipe(Effect.delay("60 millis"), Effect.forever, Effect.forkScoped)
      yield* save.pipe(Effect.delay("1500 millis"), Effect.forever, Effect.forkScoped)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          for (const live of lives.values()) live.session?.query.close()
          yield* save
        })
      )

      // ---------------------------------------------------------------------
      // Turning the agent's messages into the transcript
      // ---------------------------------------------------------------------

      const finishStreaming = (thread: MutableThread, live: Live) => {
        for (const item of thread.items) {
          if (item._tag === "Assistant" && item.streaming) item.streaming = false
        }
        live.streaming.clear()
        live.openText.length = 0
      }

      const recordArtifact = (thread: MutableThread, file: string, kind: Artifact["kind"]) => {
        const absolute = path.resolve(thread.cwd, file)
        const existing = thread.artifacts.find((artifact) => artifact.path === absolute)
        if (existing) {
          existing.edits++
          existing.updatedAt = Date.now()
          return
        }
        thread.artifacts.push({
          id: randomUUID(),
          path: absolute,
          relPath: path.relative(thread.cwd, absolute) || path.basename(absolute),
          kind,
          edits: 1,
          updatedAt: Date.now()
        })
      }

      const handle = (thread: MutableThread, live: Live, message: SDKMessage) => {
        switch (message.type) {
          case "system": {
            if (message.subtype !== "init") return
            thread.sessionId = message.session_id
            setAccount({
              state: message.apiKeySource === "none" ? "subscription" : "apiKey",
              detail: message.apiKeySource === "none" ? account.detail : message.apiKeySource,
              claudeVersion: message.claude_code_version
            })
            break
          }
          case "stream_event": {
            if (message.parent_tool_use_id !== null) return
            const event = message.event
            if (event.type === "message_start") {
              live.streaming.clear()
            } else if (event.type === "content_block_start" && event.content_block.type === "text") {
              const id = randomUUID()
              thread.items.push({ _tag: "Assistant", id, text: "", streaming: true, at: Date.now() })
              live.streaming.set(event.index, id)
              live.openText.push(id)
            } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              const id = live.streaming.get(event.index)
              const item = thread.items.findLast((item) => item.id === id)
              if (item?._tag === "Assistant") item.text += event.delta.text
            } else {
              return
            }
            break
          }
          case "assistant": {
            if (message.parent_tool_use_id !== null) return
            for (const block of message.message.content) {
              if (block.type === "text") {
                const id = live.openText.shift()
                const item = id === undefined ? undefined : thread.items.findLast((item) => item.id === id)
                if (item?._tag === "Assistant") {
                  item.text = block.text
                  item.streaming = false
                } else if (block.text.trim() !== "") {
                  thread.items.push({
                    _tag: "Assistant",
                    id: randomUUID(),
                    text: block.text,
                    streaming: false,
                    at: Date.now()
                  })
                }
              } else if (block.type === "tool_use") {
                const input = Predicate.isObject(block.input) ? block.input as Record<string, unknown> : {}
                if (TASK_TOOLS.has(block.name)) {
                  applyTaskTool(thread, live, block.id, block.name, input)
                  continue
                }
                thread.items.push({
                  _tag: "Tool",
                  id: block.id,
                  name: block.name,
                  summary: toolSummary(block.name, input, thread.cwd),
                  input: clip(JSON.stringify(input, null, 2)),
                  output: null,
                  status: "running",
                  at: Date.now()
                })
                const kind = WRITE_TOOLS[block.name]
                const file = stringField(input, "file_path", "notebook_path")
                if (kind !== undefined && file !== null) live.writes.set(block.id, { path: file, kind })
              }
            }
            if (message.error !== undefined) {
              notice(
                thread,
                "error",
                message.error === "authentication_failed"
                  ? "Claude is not signed in. Run `claude` in a terminal and use /login, then try again."
                  : `Claude reported an error: ${message.error.replaceAll("_", " ")}.`
              )
              if (message.error === "authentication_failed") {
                setAccount({ ...account, state: "signedOut" })
              }
            }
            break
          }
          case "user": {
            if (message.parent_tool_use_id !== null) return
            const content = message.message.content
            if (!Array.isArray(content)) return
            for (const block of content) {
              if (block.type !== "tool_result") continue
              const created = live.creates.get(block.tool_use_id)
              if (created !== undefined) {
                live.creates.delete(block.tool_use_id)
                if (block.is_error !== true) {
                  const output = message.tool_use_result
                  const task = Predicate.isObject(output) && "task" in output ? output.task : undefined
                  const id = Predicate.isObject(task) && "id" in task
                    ? String(task.id)
                    : /#(\d+)/.exec(resultText(block.content))?.[1] ?? String(thread.todos.length + 1)
                  thread.todos.push({ id, ...created, status: "pending" })
                }
                continue
              }
              const item = thread.items.findLast((item) => item.id === block.tool_use_id)
              if (item?._tag !== "Tool") continue
              item.status = block.is_error === true ? "error" : "ok"
              item.output = clip(resultText(block.content))
              const write = live.writes.get(block.tool_use_id)
              live.writes.delete(block.tool_use_id)
              if (write && item.status === "ok") recordArtifact(thread, write.path, write.kind)
            }
            break
          }
          case "result": {
            finishStreaming(thread, live)
            thread.stats.turns += 1
            thread.stats.costUsd = message.total_cost_usd
            thread.stats.durationMs += message.duration_ms
            const queued = (message.queued_turn_count ?? 0) + (live.session?.input.pending ?? 0)
            if (message.subtype !== "success" && !live.stopping) {
              const reason = message.errors.join(" ").trim()
              notice(thread, "error", reason === "" ? `The turn ended early (${message.subtype}).` : reason)
            }
            if (live.stopping) notice(thread, "info", "Stopped.")
            if (queued > 0 && !live.stopping) {
              thread.status = "running"
            } else {
              thread.status = message.subtype === "success" || live.stopping ? "done" : "error"
              live.stopping = false
              // Nothing more to say: let the Claude Code process exit. The next
              // message resumes the session by id.
              live.session?.input.end()
            }
            break
          }
          default:
            return
        }
        touch(thread)
      }

      // ---------------------------------------------------------------------
      // Permissions
      // ---------------------------------------------------------------------

      const settlePending = (thread: MutableThread, live: Live) => {
        if (live.pending.size === 0 && thread.status === "waiting") thread.status = "running"
      }

      const askPermission = (thread: MutableThread, live: Live) =>
      (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal; suggestions?: Array<PermissionUpdate>; toolUseID: string }
      ): Promise<PermissionResult> =>
        new Promise((resolve) => {
          // With permissions bypassed the answer is always yes, and the tool
          // call itself is the record of what ran.
          if (thread.permissionMode === "bypassPermissions") {
            resolve({ behavior: "allow", updatedInput: input })
            return
          }
          const id = `permission-${options.toolUseID}`
          const suggestions = options.suggestions ?? []
          thread.items.push({
            _tag: "Permission",
            id,
            toolName,
            summary: toolSummary(toolName, input, thread.cwd),
            input: clip(JSON.stringify(input, null, 2)),
            status: "pending",
            canAlwaysAllow: suggestions.length > 0,
            at: Date.now()
          })
          thread.status = "waiting"
          const decide = (decision: Decision) => {
            if (!live.pending.delete(id)) return
            const item = thread.items.findLast((item) => item.id === id)
            if (item?._tag === "Permission") item.status = decision === "deny" ? "denied" : "allowed"
            settlePending(thread, live)
            touch(thread)
            resolve(
              decision === "deny"
                ? { behavior: "deny", message: "The user declined this action." }
                : {
                  behavior: "allow",
                  updatedInput: input,
                  ...(decision === "always" ? { updatedPermissions: suggestions } : {})
                }
            )
          }
          live.pending.set(id, decide)
          options.signal.addEventListener("abort", () => decide("deny"), { once: true })
          touch(thread)
        })

      // ---------------------------------------------------------------------
      // Running a session
      // ---------------------------------------------------------------------

      const run = Effect.fnUntraced(function*(thread: MutableThread, live: Live, session: AgentSession) {
        yield* Stream.fromAsyncIterable(session.query, (error) => error).pipe(
          Stream.runForEach((message) => Effect.sync(() => handle(thread, live, message))),
          Effect.catch((error) =>
            Effect.sync(() => {
              if (live.stopping || live.interrupted === session) return
              notice(thread, "error", error instanceof Error ? error.message : String(error))
              thread.status = "error"
            })
          ),
          Effect.ensuring(Effect.sync(() => {
            if (live.session === session) live.session = null
            if (live.interrupted === session) live.interrupted = null
            for (const decide of [...live.pending.values()]) decide("deny")
            finishStreaming(thread, live)
            for (const item of thread.items) {
              if (item._tag === "Tool" && item.status === "running") item.status = "error"
            }
            if (thread.status === "running" || thread.status === "waiting") thread.status = "done"
            live.stopping = false
            if (threads.has(thread.id)) touch(thread)
          }))
        )
      })

      const start = Effect.fnUntraced(function*(thread: MutableThread, text: string) {
        const live = liveOf(thread.id)
        const { preferSubscription } = yield* settings.get
        const session = openSession({
          cwd: thread.cwd,
          model: thread.model,
          permissionMode: thread.permissionMode,
          resume: thread.sessionId,
          preferSubscription,
          canUseTool: askPermission(thread, live)
        })
        live.session = session
        live.stopping = false
        session.input.push(text)
        yield* Effect.forkIn(run(thread, live, session), scope)
      })

      const send = Effect.fn("Threads.send")(function*(id: string, text: string, source: InputSource) {
        const thread = threads.get(id)
        if (!thread || text.trim() === "") return
        const live = liveOf(id)
        thread.items.push({ _tag: "User", id: randomUUID(), text, source, at: Date.now() })
        thread.status = "running"
        touch(thread)
        if (live.session && !live.stopping) {
          live.session.input.push(text)
        } else {
          yield* start(thread, text)
        }
      })

      // ---------------------------------------------------------------------
      // Who is signed in, asked once at startup without spending a turn
      // ---------------------------------------------------------------------

      yield* Effect.gen(function*() {
        const { defaultCwd, preferSubscription } = yield* settings.get
        const probe = openSession({
          cwd: defaultCwd,
          model: null,
          permissionMode: "plan",
          resume: null,
          preferSubscription,
          canUseTool: () => Promise.resolve({ behavior: "deny", message: "Not available." })
        })
        const info = yield* Effect.tryPromise(() => probe.query.accountInfo()).pipe(
          Effect.timeout("20 seconds"),
          Effect.ensuring(Effect.sync(() => probe.query.close()))
        )
        const usesKey = info.apiKeySource !== undefined && info.apiKeySource !== "none" &&
          info.subscriptionType === undefined
        setAccount({
          state: info.email === undefined && !usesKey ? "signedOut" : usesKey ? "apiKey" : "subscription",
          detail: [info.subscriptionType, info.email ?? info.apiKeySource].filter(Boolean).join(" · "),
          claudeVersion: account.claudeVersion
        })
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Could not read the Claude account", cause)),
        Effect.forkScoped
      )
      return Threads.of({
        list: Effect.sync(summaries),
        get: (id) =>
          Effect.sync(() => {
            const thread = threads.get(id)
            return thread ? snapshot(thread) : null
          }),
        create: Effect.fn("Threads.create")(function*(input) {
          const defaults = yield* settings.get
          const cwd = input.cwd === null ? defaults.defaultCwd : resolveFolder(input.cwd, defaults.defaultCwd)
          const exists = yield* Effect.promise(() => fs.stat(cwd).then((stat) => stat.isDirectory(), () => false))
          if (!exists) return yield* new ThreadError({ message: `There is no folder at ${cwd}.` })
          const now = Date.now()
          const thread: MutableThread = {
            id: randomUUID(),
            title: titleOf(input.prompt),
            cwd,
            status: "idle",
            model: input.model ?? defaults.defaultModel,
            permissionMode: input.permissionMode ?? defaults.defaultPermissionMode,
            sessionId: null,
            createdAt: now,
            updatedAt: now,
            stats: { turns: 0, costUsd: 0, durationMs: 0 },
            artifacts: [],
            todos: [],
            items: []
          }
          threads.set(thread.id, thread)
          yield* send(thread.id, input.prompt, input.source)
          return summaryOf(thread)
        }),
        send,
        stop: (id) =>
          Effect.gen(function*() {
            const thread = threads.get(id)
            const live = lives.get(id)
            if (!thread || !live?.session) return
            live.stopping = true
            for (const decide of [...live.pending.values()]) decide("deny")
            const session = live.session
            live.interrupted = session
            yield* Effect.tryPromise(() => session.query.interrupt()).pipe(
              Effect.timeout("3 seconds"),
              // An agent that does not answer the interrupt is closed outright.
              Effect.catch(() => Effect.sync(() => session.query.close()))
            )
            touch(thread)
          }),
        remove: (id) =>
          Effect.gen(function*() {
            const live = lives.get(id)
            if (live) {
              live.stopping = true
              live.interrupted = live.session
              live.session?.query.close()
            }
            threads.delete(id)
            lives.delete(id)
            dirty.delete(id)
            unsaved.delete(id)
            yield* storage.remove(path.join("threads", `${id}.json`))
            events.publish({ _tag: "ThreadDeleted", id })
            summariesDirty = true
          }),
        setMode: (id, mode, source) =>
          Effect.gen(function*() {
            const thread = threads.get(id)
            if (!thread || thread.permissionMode === mode) return
            const wasBypassed = thread.permissionMode === "bypassPermissions"
            thread.permissionMode = mode
            const how = source === "voice" ? " by voice" : ""
            if (mode === "bypassPermissions") {
              notice(thread, "info", `Permissions bypassed${how}. Claude now runs commands and edits files here without asking.`)
            } else if (wasBypassed) {
              notice(thread, "info", `Permissions are back on${how}.`)
            } else if (source === "voice") {
              notice(thread, "info", "Permission mode changed by voice.")
            }
            const live = lives.get(id)
            // Whatever is already waiting is covered by the same decision.
            if (mode === "bypassPermissions" && live) {
              for (const decide of [...live.pending.values()]) decide("allow")
            }
            touch(thread)
            const session = live?.session
            if (session) {
              yield* Effect.tryPromise(() => session.query.setPermissionMode(sdkMode(mode))).pipe(Effect.ignore)
            }
          }),
        resolvePermission: (id, requestId, decision, source) =>
          Effect.sync(() => {
            const thread = threads.get(id)
            const decide = lives.get(id)?.pending.get(requestId)
            if (!thread || !decide) return
            // A spoken decision leaves a line in the transcript, so it can be traced later.
            if (source === "voice") {
              const item = thread.items.findLast((item) => item.id === requestId)
              const what = item?._tag === "Permission" ? `${item.toolName} ${item.summary}`.trim() : "a request"
              notice(thread, "info", `${decision === "deny" ? "Declined" : "Approved"} by voice: ${oneLine(what, 80)}`)
            }
            decide(decision)
          }),
        artifact: (threadId, artifactId) =>
          Effect.sync(() => {
            const artifact = threads.get(threadId)?.artifacts.find((artifact) => artifact.id === artifactId)
            return artifact ? { ...artifact } : null
          }),
        cwd: (threadId) => Effect.sync(() => threads.get(threadId)?.cwd ?? null),
        setModel: (id, model, source) =>
          Effect.gen(function*() {
            const thread = threads.get(id)
            if (!thread || thread.model === model) return
            thread.model = model
            const name = model.replace(/\[.*\]$/, "")
            notice(thread, "info", `Model changed to ${name}${source === "voice" ? " by voice" : ""}.`)
            touch(thread)
            // A turn in flight switches at its next request; otherwise the next message starts on it.
            const session = lives.get(id)?.session
            if (session) yield* Effect.tryPromise(() => session.query.setModel(model)).pipe(Effect.ignore)
          }),
        account: Effect.sync(() => account)
      })
    })
  )
}
