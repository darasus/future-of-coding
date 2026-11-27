import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SettingsStore } from "./SettingsStore.ts"

export class VoiceError extends Schema.TaggedError<VoiceError>()("VoiceError", {
  message: Schema.String
}) {}

const Answer = Schema.Struct({
  session: Schema.Struct({ id: Schema.String }),
  transport: Schema.Struct({ sdp: Schema.String })
})

const instructions = `You are the voice of a local coding workbench. The user runs Claude coding agents in
"threads", each working in a folder on their machine. The app has no text boxes or buttons for directing
threads: this conversation is the only way to start, steer, approve or stop them, so act on what the user
asks instead of sending them to the app. Keep replies short and conversational.
Delegate to the backend whenever the user wants to start work, check on a thread, send a
thread a follow-up, approve or decline what a paused thread is asking for, or change how much a
thread asks before acting. Never approve anything or loosen permissions unless the user has just
told you to. Never read code aloud; summarise it.`

const backendInstructions = `You operate a board of coding-agent threads through tools.
- start_thread: begin new work. Write the prompt as a complete, self-contained task for a coding agent.
  Pass folder when the user names where to work; leave it out to use their default folder.
  Pass intelligence when the user says how demanding the task is: low for simple or mechanical work
  ("this is easy", "little intelligence"), medium for everyday coding, high for hard problems, best
  when they ask for the best or smartest model. Leave it out when they say nothing about it.
- set_intelligence: change the model an existing thread runs on, the same way, when the user asks.
- stop_thread: stop a thread that is working, when the user asks.
- list_threads: see every thread with its status and latest activity.
- read_thread: read the latest messages of one thread.
- message_thread: send a follow-up to an existing thread.
- answer_approval: approve or decline what a paused thread is asking permission for. Call it only
  when the user's own words clearly ask for that decision. Never call it to unblock work on your own
  judgement. If it reports requests the user has not heard yet, describe them and wait for an answer.
- set_permissions: change how much a thread asks before acting. "bypass" stops it asking at all:
  it then runs every command and edit on its own. Use it only when the user's own words ask for
  that, for example "stop asking", "allow everything" or "bypass permissions". Scope "session"
  covers every thread now working or waiting and the threads started later in this conversation.
  When the user asks to be asked again, set the mode back to "ask".
Return short results suited to being spoken. Refer to threads by title, never by id.`

const fn = (name: string, description: string, properties: Record<string, unknown>, required: Array<string>) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required, additionalProperties: false }
})

/** The tools the voice model's backend can call. The renderer runs them. */
export const voiceTools = [
  fn("start_thread", "Start a new coding thread with a Claude agent.", {
    prompt: { type: "string", description: "The full task for the coding agent." },
    folder: {
      type: "string",
      description: "Where to work: an absolute path, a path under ~, or a folder inside the user's default folder."
    },
    intelligence: {
      type: "string",
      enum: ["low", "medium", "high", "best"],
      description: "How much intelligence the task needs. Only when the user says so."
    }
  }, ["prompt"]),
  fn("set_intelligence", "Change how much intelligence an existing thread runs with.", {
    level: { type: "string", enum: ["low", "medium", "high", "best"] },
    thread_id: { type: "string", description: "Leave out when only one thread is working or waiting." }
  }, ["level"]),
  fn("stop_thread", "Stop a thread that is working.", {
    thread_id: { type: "string", description: "Leave out when only one thread is working or waiting." }
  }, []),
  fn(
    "set_permissions",
    "Change how much a thread asks before acting, once the user has asked for that.",
    {
      mode: {
        type: "string",
        enum: ["ask", "accept_edits", "bypass"],
        description: "ask: ask before acting. accept_edits: edit files freely, ask before commands. bypass: never ask."
      },
      scope: {
        type: "string",
        enum: ["thread", "session"],
        description: "thread: one thread. session: every thread now working or waiting, and threads started later in this conversation."
      },
      thread_id: {
        type: "string",
        description: "For scope thread. Leave out when only one thread is working or waiting."
      }
    },
    ["mode"]
  ),
  fn("list_threads", "List the threads on the board with status and latest activity.", {}, []),
  fn("read_thread", "Read the most recent messages of a thread.", {
    thread_id: { type: "string" }
  }, ["thread_id"]),
  fn("message_thread", "Send a follow-up message to an existing thread.", {
    thread_id: { type: "string" },
    text: { type: "string" }
  }, ["thread_id", "text"]),
  fn(
    "answer_approval",
    "Approve or decline what a paused thread is asking permission for, once the user has said which.",
    {
      thread_id: {
        type: "string",
        description: "The paused thread. Leave out when only one thread is waiting for approval."
      },
      decision: { type: "string", enum: ["allow", "deny"] }
    },
    ["decision"]
  )
]

/**
 * Starts a GPT-Live session. The renderer makes the WebRTC offer; the main
 * process posts it with the API key, so the key never reaches the page.
 */
export class Voice extends Context.Service<Voice, {
  connect(sdp: string): Effect.Effect<{ readonly sessionId: string; readonly sdp: string }, VoiceError>
}>()("foc/main/Voice") {
  static readonly layer = Layer.effect(
    Voice,
    Effect.gen(function*() {
      const settings = yield* SettingsStore

      const connect = Effect.fn("Voice.connect")(function*(sdp: string) {
        const key = yield* settings.openAiKey
        if (Option.isNone(key)) {
          return yield* new VoiceError({ message: "Add an OpenAI API key in Settings to use live voice." })
        }
        const { voiceBackendModel, voiceModel } = yield* settings.get
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch("https://api.openai.com/v1/live/sessions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${Redacted.value(key.value)}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                session: {
                  model: voiceModel,
                  instructions,
                  delegation: {
                    type: "responses",
                    responses: {
                      model: voiceBackendModel,
                      instructions: backendInstructions,
                      tools: voiceTools,
                      tool_choice: "auto"
                    }
                  }
                },
                transport: { type: "webrtc", sdp }
              })
            }),
          catch: () => new VoiceError({ message: "Could not reach OpenAI. Check your connection." })
        })
        const body = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () => new VoiceError({ message: `OpenAI answered ${response.status} with no readable body.` })
        })
        if (!response.ok) {
          const detail = Schema.decodeUnknownOption(
            Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })
          )(body)
          return yield* new VoiceError({
            message: Option.match(detail, {
              onNone: () => `OpenAI refused the voice session (${response.status}).`,
              onSome: ({ error }) => error.message
            })
          })
        }
        const answer = yield* Schema.decodeUnknownEffect(Answer)(body).pipe(
          Effect.mapError(() => new VoiceError({ message: "OpenAI sent an answer this app does not understand." }))
        )
        return { sessionId: answer.session.id, sdp: answer.transport.sdp }
      })

      return Voice.of({ connect })
    })
  )
}
