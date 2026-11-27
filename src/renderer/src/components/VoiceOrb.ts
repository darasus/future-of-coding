import { Command, Component, Mount, Subscription, UiSchema } from "@effect/ui"
import { Html, HtmlSubscription } from "@effect/ui/html"
import { Effect, Layer, Schema, Stream } from "effect"
import { VoiceClient, type VoiceEvent } from "../voice/VoiceClient.ts"
import { Icon } from "./icons.ts"
import { DrawVoice } from "./VoiceMatrix.ts"

const Role = Schema.Literals(["user", "assistant"])

export const VoiceOrbMessage = UiSchema.TaggedEnum({
  ClickedOrb: {},
  PressedSpace: {},
  HeldSpace: {},
  SucceededStartVoice: {},
  FailedStartVoice: { reason: Schema.String },
  StartedSession: {},
  Heard: { role: Role, delta: Schema.String },
  UsedTool: { name: Schema.String },
  AskedToShow: { threadId: Schema.NullOr(Schema.String) },
  EndedSession: { reason: Schema.NullOr(Schema.String) },
  ClickedDismiss: {}
})

/** What the conversation asks of the rest of the window. */
export const VoiceOrbEvents = UiSchema.TaggedEnum({
  /** Put this thread on screen, or the list when there is none. */
  RequestedShow: { threadId: Schema.NullOr(Schema.String) }
})

export class StartVoice extends Command.Service<StartVoice>()(
  "voice/StartVoice",
  { success: VoiceOrbMessage }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const voice = yield* VoiceClient
      return () =>
        voice.start.pipe(
          Effect.match({
            onSuccess: () => VoiceOrbMessage.SucceededStartVoice(),
            onFailure: (error) => VoiceOrbMessage.FailedStartVoice({ reason: error.message })
          })
        )
    })
  )
}

export class StopVoice extends Command.Service<StopVoice>()("voice/StopVoice", {}) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const voice = yield* VoiceClient
      return () => voice.stop
    })
  )
}

const toMessage = (event: VoiceEvent) => {
  switch (event._tag) {
    case "Started":
      return VoiceOrbMessage.StartedSession()
    case "Heard":
      return VoiceOrbMessage.Heard({ role: event.role, delta: event.delta })
    case "UsedTool":
      return VoiceOrbMessage.UsedTool({ name: event.name })
    case "Show":
      return VoiceOrbMessage.AskedToShow({ threadId: event.threadId })
    case "Ended":
      return VoiceOrbMessage.EndedSession({ reason: event.reason })
  }
}

const toolLabels: Record<string, string> = {
  start_thread: "Starting a thread",
  list_threads: "Looking at the board",
  read_thread: "Reading a thread",
  message_thread: "Messaging a thread",
  stop_thread: "Stopping a thread",
  answer_approval: "Answering a request",
  set_permissions: "Changing permissions",
  set_intelligence: "Choosing a model",
  open_thread: "Opening a thread",
  close_thread: "Back to the list",
  delete_threads: "Deleting threads"
}

/**
 * Keeps the conversation told which thread the window is showing, for as long
 * as the voice display is on screen, which is always.
 */
const TrackScreen = Mount.makeStream(
  "TrackScreen",
  { args: { threadId: Schema.NullOr(Schema.String) } },
  (_node: HTMLElement, args, changes) =>
    Stream.unwrap(
      Effect.gen(function*() {
        const voice = yield* VoiceClient
        yield* voice.show(args.threadId)
        return changes.pipe(Stream.tap((next) => voice.show(next.threadId)), Stream.drain)
      })
    )
)

/** How much of the conversation is kept for the running line. */
const MAX_LINES = 6
const SHOWN_WORDS = 48

const VoiceOrbDef = Html.component({
  name: "VoiceOrb",
  /** The thread open in the window, or `null` when the list or settings is showing. */
  props: Schema.Struct({ openThreadId: Schema.NullOr(Schema.String) }),
  model: Schema.Struct({
    state: Schema.Literals(["off", "connecting", "live"]),
    // Each stretch of speech keeps its number, so its words keep their place
    // in the running line as older stretches drop off the front.
    lines: Schema.Array(Schema.Struct({ id: Schema.Number, role: Role, text: Schema.String })),
    spoken: Schema.Number,
    activity: Schema.String,
    error: Schema.NullOr(Schema.String)
  }),
  message: VoiceOrbMessage,
  events: VoiceOrbEvents
})

/** Starts a conversation, or ends the one in progress. A click and Space both do this. */
const toggle = VoiceOrbDef.update(($) =>
  $.model.state === "off"
    ? $.evolve({ state: "connecting" as const, error: null, lines: [], activity: "" }).run(StartVoice.make())
    : $.evolve({ state: "off" as const }).run(StopVoice.make())
)

export const VoiceOrbNoDeps = VoiceOrbDef.make({
  init: () => ({ state: "off" as const, lines: [], spoken: 0, activity: "", error: null }),
  update: {
    ClickedOrb: toggle,
    PressedSpace: toggle,
    // Holding the key changes nothing. It is still a message, so that the
    // repeats are cancelled too and do not press whichever button has focus.
    HeldSpace: ($) => $.model,
    SucceededStartVoice: ($) => $.model,
    FailedStartVoice: ($, { reason }) => $.evolve({ state: "off" as const, error: reason }),
    StartedSession: ($) => $.evolve({ state: "live" as const }),
    Heard: ($, { delta, role }) => {
      const last = $.model.lines.at(-1)
      const lines = last?.role === role
        ? [...$.model.lines.slice(0, -1), { ...last, text: last.text + delta }]
        : [...$.model.lines, { id: $.model.spoken, role, text: delta.trimStart() }]
      return $.evolve({
        lines: lines.slice(-MAX_LINES),
        spoken: last?.role === role ? $.model.spoken : $.model.spoken + 1,
        activity: ""
      })
    },
    UsedTool: ($, { name }) => $.evolve({ activity: toolLabels[name] ?? "Working" }),
    AskedToShow: ($, { threadId }) => $.emit(VoiceOrbEvents.RequestedShow({ threadId })),
    EndedSession: ($, { reason }) => $.evolve({ state: "off" as const, error: reason, activity: "" }),
    ClickedDismiss: ($) => $.evolve({ error: null })
  },
  subscriptions: ({ model }) => [
    // Space talks from anywhere in the window, except while typing in a field.
    // Its default is cancelled, so a focused button is not pressed as well.
    HtmlSubscription.onDocument(
      "keydown",
      ({ alt, ctrl, editable, key, meta, repeat }) =>
        key !== " " || editable || alt || ctrl || meta
          ? undefined
          : repeat
          ? VoiceOrbMessage.HeldSpace()
          : VoiceOrbMessage.PressedSpace(),
      { preventDefault: true }
    ),
    // The session's events are heard for as long as a session is wanted.
    model.state !== "off" &&
    Subscription.make(
      "voice",
      Stream.unwrap(VoiceClient.use((voice) => Effect.succeed(voice.events))).pipe(Stream.map(toMessage))
    )
  ],
  view: (h, model) => {
    // The conversation as one run of words. A word keeps its key while the
    // speaker is still on it, so only words that are new fade in.
    const words = model.lines.flatMap((line) =>
      line.text.split(/\s+/).filter((word) => word !== "").map((word, index) => ({
        key: `${line.id}-${index}`,
        role: line.role,
        word
      }))
    ).slice(-SHOWN_WORDS)
    const label = model.state === "off"
      ? "Press space to talk"
      : model.state === "connecting"
      ? "Connecting"
      : model.activity !== ""
      ? model.activity
      : "Listening"
    return h.div.class("voice", `is-${model.state}`)
      .onMount(TrackScreen({ threadId: h.props.openThreadId }).pipe(Mount.map((never) => never)))
      .children(
      h.button.class("voice-screen").attrs({
        type: "button",
        "aria-pressed": String(model.state !== "off"),
        "aria-label": model.state === "off" ? "Start talking" : "Stop talking",
        "aria-keyshortcuts": "Space",
        title: model.state === "off" ? "Start talking (Space)" : "Stop talking (Space)"
      }).on("click", VoiceOrbMessage.ClickedOrb()).children(
        h.canvas.class("voice-matrix").attr("aria-hidden", "true")
          .onMount(DrawVoice({ state: model.state }).pipe(Mount.map((never) => never)))
      ),
      model.error !== null
        ? h.div.class("voice-error").attrs({ role: "alert", title: model.error }).children(
          h.p(model.error),
          h.button.class("icon-btn").attrs({ type: "button", "aria-label": "Dismiss" })
            .on("click", VoiceOrbMessage.ClickedDismiss()).children(Icon(h, "close"))
        )
        : h.div.class("voice-line").children(
          h.span.class("voice-label").children(model.state !== "off" && h.span.class("live-dot"), label),
          // Newest words sit at the right edge; older ones run off to the left and fade.
          h.div.class("ticker").attrs({ role: "log", "aria-live": "off", "aria-label": "Conversation" }).children(
            h.div.class("ticker-run").children(
              ...words.map((entry) => h.span.key(entry.key).class("word", `is-${entry.role}`).children(`${entry.word} `))
            )
          )
        )
    )
  }
})

export const VoiceOrb = VoiceOrbNoDeps.pipe(
  Component.provide(
    Layer.mergeAll(StartVoice.layer, StopVoice.layer).pipe(Layer.provideMerge(VoiceClient.layer))
  )
)
