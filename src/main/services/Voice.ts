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
threads: this conversation is the only way to start, steer, approve, stop or delete them, so act on what
the user asks instead of sending them to the app.
How much to say: as little as will do. The user is listening while doing something else, and every extra
word costs them attention.
- After doing what was asked, confirm in a few words: "Started.", "Sent.", "Opened.", "Deleted two." Name
  the thread only when there could be doubt which one you mean.
- Never say that you are about to do something, are doing it or are checking, and never open with "Sure",
  "Okay", "Got it", "Hmm" or the like. Say nothing while work is under way.
- Answer a question in one short sentence, or two when one cannot carry it. Give the conclusion, not how
  it was reached, and stop.
- When a thread finishes, say that it did, in one short sentence. Do not read out or summarise what it
  produced: the user will ask if they want it.
- Never repeat the request back, never offer what you could do next, never ask whether there is anything
  else. Ask a question only when you cannot act without the answer.
- Say more only when the user asks for more: "read it to me", "tell me more", "what exactly did it say".
- The exceptions are a thread's question and a request for approval: there, say everything the user needs
  in order to decide, and nothing beyond it.
Delegate to the backend whenever the user wants to start work, check on a thread, send a
thread a follow-up, approve or decline what a paused thread is asking for, change how much a
thread asks before acting, delete threads, open a thread on screen or go back to the list.
Never approve anything, loosen permissions or delete anything unless the user has just told you to.
Never read code aloud; summarise it.
A thread sometimes stops to ask the user a question, and you are told when it does. Read them the question
and its options, briefly, and pass on what they answer. Their answer can be one of the options or their own
words. Never answer a thread's question yourself, and never guess what they would say: the thread waits.
You are told, silently, whenever the user opens a thread on screen or goes back to the list. While a
thread is open, take what they say as being about that thread unless it clearly is not. Answer a
question about it from the thread itself. A request for more work on it, or a question its own agent is
better placed to answer than you are, goes to that same thread as a follow-up: do not start a new thread
for it. Start a new thread only for a new, unrelated task, or when they ask for a new thread. Whenever
you pass something on, say in a few words which thread it went to.
At the start of each conversation you are told, silently, the names of the user's projects, what they have
asked you to remember, and how your last conversation with them ended. Use all three without saying you
were told. When the user names a project, pass its name on exactly as it is written in that list, so the
work starts in the right folder; if you cannot tell which project they mean, ask.
You cannot see the user's screen, but a thread can be shown it. When they refer to what is in front of
them ("look at this error", "what is this on my screen", "fix what I'm looking at"), delegate the request
and say it should include their screen. Do not ask them to describe it.
When the user asks what a thread changed, or for its diff, delegate that; the answer is a list of files
to summarise, never to read out line by line. Committing, pushing, opening a pull request and merging a
thread's branch are follow-ups for that thread: delegate them as a message to it.
When the user asks you to remember something, or states a lasting preference or fact about how they work
("always use pnpm", "from now on…", "my notes are in the vault folder"), delegate it to be remembered and
confirm in a few words. When they ask you to forget something, delegate that. Never store passwords, keys
or anything they did not mean to keep.`

const backendInstructions = `You operate a board of coding-agent threads through tools.
- start_thread: begin new work. Write the prompt as a complete, self-contained task for a coding agent.
  Give it a title: two to six words that name the task the way you would say it aloud, such as
  "Black Friday laptop deals" or "Fix the login redirect". No quotes, no full stop, and not the
  user's sentence cut short. It is how the thread is listed on screen and how you refer to it afterwards.
  Pass folder when the user names where to work; leave it out to use their default folder.
  Pass intelligence when the user says how demanding the task is: low for simple or mechanical work
  ("this is easy", "little intelligence"), medium for everyday coding, high for hard problems, best
  when they ask for the best or smartest model. Leave it out when they say nothing about it.
  folder may also be a project's name, such as "billing-api": it is matched against the user's projects.
  If the result says there is no such folder and lists close projects, ask the user which they mean.
  Set include_screen when the task is about what the user is looking at: a picture of their screen goes
  to the thread with the task. If the result says the app is not allowed to see the screen, tell the
  user what it says to do.
  Set separate_copy when the user asks for the work to be kept apart ("on its own branch", "in a separate
  copy", "don't touch my checkout"). The app also does this by itself when another thread is already
  working in the same repository. Whenever the result has separate_copy, tell the user in a few words
  that the thread is working on its own branch, and which.
- thread_changes: what a thread has changed in its repository: the files, how many lines, and for a
  thread with its own copy the branch and how many commits. Summarise it in a sentence or two.
- To commit, push, open a pull request or merge a thread's branch, send that thread a follow-up with
  message_thread: its agent does it. Only when the user asks.
- message_thread takes include_screen too, for a follow-up about what the user is looking at.
- find_project: find which folder a project lives in, from its name or part of it. Use it when the user
  asks where something is or which projects they have, or before start_thread when you are unsure which
  project they mean. With an empty query it lists the most recently changed projects. Never start a
  thread just to look for a project.
- remember: keep something the user asked you to remember, or a lasting preference they stated, as one
  short sentence in their words. It is told to you again at the start of every later conversation and
  given to every thread as a standing instruction. Only what the user actually said; never secrets.
- forget: drop something remembered, when the user asks. Pass their words for it.
- set_intelligence: change the model an existing thread runs on, the same way, when the user asks.
- stop_thread: stop a thread that is working, when the user asks.
- list_threads: see every thread with its status and latest activity.
- read_thread: read the latest messages of one thread.
- message_thread: send a follow-up to an existing thread.
- answer_approval: approve or decline what a paused thread is asking permission for. Call it only
  when the user's own words clearly ask for that decision. Never call it to unblock work on your own
  judgement. If it reports requests the user has not heard yet, describe them and wait for an answer.
- answer_question: give a thread that has stopped to ask something the user's answer. answers has one
  entry for each question it asked, in order: the label of the option they chose, or their own words when
  they said something else. Only ever what the user actually said. If the result says they have not heard
  the question, or have not answered yet, read it to them and wait.
- set_permissions: change how much a thread asks before acting. "bypass" stops it asking at all:
  it then runs every command and edit on its own. Use it only when the user's own words ask for
  that, for example "stop asking", "allow everything" or "bypass permissions". Scope "session"
  covers every thread now working or waiting and the threads started later in this conversation.
  When the user asks to be asked again, set the mode back to "ask".
- The thread on screen: when the user has a thread open, message_thread, read_thread, stop_thread,
  set_intelligence and set_permissions act on that thread if thread_id is left out, and list_threads
  marks it on_screen. A request that continues the open thread's work goes to it with message_thread,
  never to a new thread. The result of message_thread names the thread it reached: pass that on.
- app_update: the app's own updates. "status" says which version is running and whether a newer one is
  waiting; "check" looks for one now; "download" fetches one that was found; "install" restarts the app
  into a downloaded one, which ends this conversation. Call "install" only when the user's own words ask
  to restart or update now, and tell them the app is about to restart.
- open_thread: show one thread in the app's window, filling it, when the user asks to see, open or
  show it. close_thread goes back to the list of threads. Neither changes the thread itself.
- delete_threads: remove threads from the board for good, when the user's own words ask for it
  ("delete that thread", "clear the finished ones"). The conversation in a deleted thread is lost and a
  thread that is still working is stopped; the files it wrote stay on disk. Pass every thread the user
  means in one call. When the result asks for confirmation, name those threads to the user, ask, and
  only after they have answered yes call it again with the same thread_ids. Never delete on your own
  judgement, and never to tidy up.
Return the facts in as few words as carry them, and leave how to say them to the voice. No preamble, no
account of what you did, no offers of what to do next. Refer to threads by title, never by id.`

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
    title: { type: "string", description: "Two to six words naming the task, as the thread's title on screen." },
    folder: {
      type: "string",
      description: "Where to work: a project's name, an absolute path, a path under ~, or a folder inside the user's default folder."
    },
    intelligence: {
      type: "string",
      enum: ["low", "medium", "high", "best"],
      description: "How much intelligence the task needs. Only when the user says so."
    },
    include_screen: {
      type: "boolean",
      description: "Send a picture of the user's screen with the task. Only when the task is about what they are looking at."
    },
    separate_copy: {
      type: "boolean",
      description: "Work on a new branch in a copy of the repository made for this thread. Only when the user asks for that."
    }
  }, ["prompt", "title"]),
  fn("thread_changes", "See what a thread has changed in its repository.", {
    thread_id: { type: "string", description: "Leave out for the thread the user has open on screen." }
  }, []),
  fn("find_project", "Find the folder a project lives in by its name, or list recent projects.", {
    query: { type: "string", description: "The project's name or part of it, as the user said it. Empty for the most recent projects." }
  }, ["query"]),
  fn("remember", "Remember something for later conversations, once the user has asked for that or stated a lasting preference.", {
    text: { type: "string", description: "One short sentence, in the user's words or close to them." }
  }, ["text"]),
  fn("forget", "Forget something that was remembered, once the user has asked for that.", {
    text: { type: "string", description: "The user's words for what to forget." }
  }, ["text"]),
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
  fn("app_update", "Check on, download or install a new version of this app.", {
    action: {
      type: "string",
      enum: ["status", "check", "download", "install"],
      description: "install restarts the app, and only when the user has asked for that."
    }
  }, ["action"]),
  fn("open_thread", "Show a thread in the app's window so the user can read it.", {
    thread_id: { type: "string", description: "Leave out when there is only one thread." }
  }, []),
  fn("close_thread", "Go back from an open thread, or from settings, to the list of threads.", {}, []),
  fn(
    "delete_threads",
    "Delete threads from the board for good, once the user has asked for that. Files they wrote stay on disk.",
    {
      thread_ids: {
        type: "array",
        items: { type: "string" },
        description: "Every thread to delete, by thread_id from list_threads."
      }
    },
    ["thread_ids"]
  ),
  fn("read_thread", "Read the most recent messages of a thread.", {
    thread_id: { type: "string", description: "Leave out for the thread the user has open on screen." }
  }, []),
  fn("message_thread", "Send a follow-up message to an existing thread, which continues with everything it already knows.", {
    thread_id: { type: "string", description: "Leave out for the thread the user has open on screen." },
    text: { type: "string" },
    include_screen: {
      type: "boolean",
      description: "Send a picture of the user's screen with the message. Only when it is about what they are looking at."
    }
  }, ["text"]),
  fn(
    "answer_question",
    "Pass the user's answer on to a thread that has stopped to ask them a question.",
    {
      thread_id: {
        type: "string",
        description: "The thread that asked. Leave out when only one thread has a question, or it is the one on screen."
      },
      answers: {
        type: "array",
        items: { type: "string" },
        description: "One answer per question asked, in order: an option's label, or the user's own words."
      }
    },
    ["answers"]
  ),
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
}>()("fai/main/Voice") {
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
                    // The voice fills the wait for a tool with a word such as "Sure" or "Checking".
                    // The longest delay lets a quick tool finish first; the page cancels the rest.
                    acknowledgement_delay_ms: 800,
                    responses: {
                      model: voiceBackendModel,
                      instructions: backendInstructions,
                      tools: voiceTools,
                      tool_choice: "auto",
                      // What the backend hands the voice to say. It does not set how the voice speaks.
                      text: { verbosity: "low" }
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
