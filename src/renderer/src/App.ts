import { Command, Component, Mount, Subscription, UiSchema } from "@effect/ui"
import { Html, HtmlSubscription } from "@effect/ui/html"
import { Effect, Schema, Stream } from "effect"
import { AsyncResult } from "effect/reactivity"
import type { ThreadStatus, ThreadSummary } from "../../shared/domain.ts"
import { Icon } from "./components/icons.ts"
import { MarkReady, RowMotion } from "./components/mounts.ts"
import { SettingsPanel } from "./components/SettingsPanel.ts"
import { ThreadPanel } from "./components/ThreadPanel.ts"
import { VoiceOrb } from "./components/VoiceOrb.ts"
import { WatchAccount, WatchSummaries } from "./queries.ts"

export const AppMessage = UiSchema.TaggedEnum({
  PressedThread: { id: Schema.String },
  ClickedThread: { id: Schema.String },
  SettledClose: {},
  ClickedSettings: {},
  RequestedCloseSettings: {},
  RequestedCloseThread: {},
  DeletedThread: {},
  PressedEscape: {},
  VoiceAskedToShow: { id: Schema.NullOr(Schema.String) }
})

/**
 * Opens a thread the way a click does, one frame after its row has been
 * marked as the one about to open, so the row is what grows into the thread.
 */
export class OpenMarkedThread extends Command.Service<OpenMarkedThread>()(
  "app/OpenMarkedThread",
  { args: { id: Schema.String }, success: AppMessage }
) {
  static readonly layer = this.toLayer(
    Effect.succeed(({ id }) => Effect.as(Effect.sleep("60 millis"), AppMessage.ClickedThread({ id })))
  )
}

type H = Html.H<typeof AppMessage.Type>

/** Threads that need the person come first, then the ones working, then the finished. */
const rank: Record<ThreadStatus, number> = { waiting: 0, error: 0, running: 1, idle: 1, done: 2 }

/**
 * The name a row and the open thread's panel share while one turns into the
 * other. Only one element may carry it at a time.
 */
const MORPH = "thread-morph"

/** A thread in two lines and nothing else: what it is, and where it stands. */
const ThreadRow = (h: H, thread: ThreadSummary, morphs: boolean) => {
  const state = thread.activity !== "" ? thread.activity : thread.preview
  return h.li.key(thread.id).children(
    h.button.class("row", `is-${thread.status}`)
      .attr("type", "button")
      .style({ viewTransitionName: morphs ? MORPH : "none" })
      // The press comes before the click, which is when the row has to be
      // marked as the one about to open.
      .on("pointerdown", AppMessage.PressedThread({ id: thread.id }))
      .on("click", AppMessage.ClickedThread({ id: thread.id }))
      .children(
        h.span.class("status-dot", `is-${thread.status}`),
        h.span.class("row-text").children(
          h.span.class("row-title").children(thread.title),
          state !== "" && h.span.class("row-state", thread.activity !== "" && "is-live").children(state)
        )
      )
  )
}

export const AppNoDeps = Html.component({
  name: "App",
  model: Schema.Struct({
    selectedId: Schema.NullOr(Schema.String),
    settingsOpen: Schema.Boolean,
    /** The row under the pointer's press: the one that will expand into a panel. */
    armedId: Schema.NullOr(Schema.String),
    /** The thread that just closed: its panel shrinks back into this row. */
    returnId: Schema.NullOr(Schema.String)
  }),
  message: AppMessage,
  queries: {
    summaries: { query: WatchSummaries, args: () => ({}) },
    account: { query: WatchAccount, args: () => ({}) }
  }
}).make({
  init: () => ({ selectedId: null, settingsOpen: false, armedId: null, returnId: null }),
  // The window shows one thing at a time: the list, an open thread, or
  // settings. Each change is one view transition, tagged with what happened so
  // the stylesheet can give each its own motion:
  // - open: a row expands into the whole window
  // - close: the thread shrinks back into its row
  // - switch: settings gives way to what is under it, or the other way round
  update: {
    PressedThread: ($, { id }) => $.evolve({ armedId: id, returnId: null }),
    ClickedThread: ($, { id }) =>
      $.evolve({ selectedId: id, settingsOpen: false, armedId: null, returnId: null }).viewTransition(["open"]),
    SettledClose: ($) => $.evolve({ returnId: null }),
    ClickedSettings: ($) =>
      $.evolve({ settingsOpen: !$.model.settingsOpen, armedId: null, returnId: null }).viewTransition(["switch"]),
    RequestedCloseSettings: ($) => $.evolve({ settingsOpen: false }).viewTransition(["switch"]),
    RequestedCloseThread: ($) =>
      $.evolve({ selectedId: null, armedId: null, returnId: $.model.selectedId }).viewTransition(["close"]),
    // Deleted while open: there is no row to shrink back into, so the thread is erased where it stands.
    DeletedThread: ($) => $.evolve({ selectedId: null, armedId: null, returnId: null }).viewTransition(["delete"]),
    // The assistant puts a thread on screen, or goes back to the list, with
    // the same motion a click or Escape would have.
    VoiceAskedToShow: ($, { id }) => {
      const open = $.model.settingsOpen || $.model.selectedId !== null
      if (id === null) {
        if (!open) return $.model
        return $.model.settingsOpen
          ? $.evolve({ settingsOpen: false, selectedId: null, armedId: null, returnId: null }).viewTransition(["switch"])
          : $.evolve({ selectedId: null, armedId: null, returnId: $.model.selectedId }).viewTransition(["close"])
      }
      if (open) {
        return $.model.selectedId === id && !$.model.settingsOpen
          ? $.model
          : $.evolve({ selectedId: id, settingsOpen: false, armedId: null, returnId: null }).viewTransition(["switch"])
      }
      return $.evolve({ armedId: id, returnId: null }).run(OpenMarkedThread.make({ id }))
    },
    // Escape goes back one step: out of settings, then out of the thread.
    PressedEscape: ($) =>
      $.model.settingsOpen
        ? $.evolve({ settingsOpen: false }).viewTransition(["switch"])
        : $.evolve({ selectedId: null, armedId: null, returnId: $.model.selectedId }).viewTransition(["close"])
  },
  // Once the panel has landed back in its row, the row gives the shared name
  // up, so the next row to open can take it.
  subscriptions: ({ model }) => [
    (model.settingsOpen || model.selectedId !== null) &&
    HtmlSubscription.onDocument("keydown", ({ key }) => key === "Escape" ? AppMessage.PressedEscape() : undefined),
    model.returnId !== null &&
    Subscription.make(
      "settle-close",
      model.returnId,
      () => Stream.fromEffect(Effect.as(Effect.sleep("700 millis"), AppMessage.SettledClose()))
    )
  ],
  view: (h, model) => {
    const loaded = AsyncResult.isSuccess(h.queries.summaries) ? h.queries.summaries.value : []
    const threads = [...loaded].sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt)
    const account = AsyncResult.isSuccess(h.queries.account) ? h.queries.account.value : null
    // A thread that was deleted elsewhere leaves nothing to show.
    const selectedId = threads.some((thread) => thread.id === model.selectedId) ? model.selectedId : null
    const detail = model.settingsOpen || selectedId !== null
    return h.div.class("shell", detail && "has-detail", threads.length === 0 && "is-empty")
      .onMount(MarkReady({ after: 900 })).children(
      h.header.class("topbar").children(
        h.button.class("icon-btn", model.settingsOpen && "active")
          .attrs({ type: "button", title: "Settings", "aria-label": "Settings", "aria-pressed": String(model.settingsOpen) })
          .on("click", AppMessage.ClickedSettings()).children(Icon(h, "settings"))
      ),
      // Voice runs under the list and the open thread alike. It comes first
      // so that it stays the same element while they trade places.
      VoiceOrb(h, {
        // The conversation is told which thread is in front of the user.
        props: { openThreadId: model.settingsOpen ? null : selectedId },
        onEmit: { RequestedShow: ({ threadId }) => AppMessage.VoiceAskedToShow({ id: threadId }) }
      }),
      // The list is only there when nothing is open: an open thread has the
      // window to itself.
      !detail && h.main.class("board").children(
        threads.length === 0
          ? AsyncResult.isSuccess(h.queries.summaries) && h.div.class("board-hint").children(
            h.p.class("board-hint-title").children("No threads yet"),
            h.p("Press Space and say what you want built.")
          )
          : h.ul.class("rows").attr("aria-label", "Threads")
            .onMount(RowMotion({ list: "threads" }).pipe(Mount.map((never) => never)))
            .children(
            ...threads.map((thread) =>
              ThreadRow(h, thread, model.armedId === thread.id || model.returnId === thread.id)
            )
          )
      ),
      detail && h.main.class("detail").children(
        model.settingsOpen
          ? SettingsPanel(h, {
            props: { account },
            onEmit: { RequestedClose: () => AppMessage.RequestedCloseSettings() }
          })
          : selectedId !== null && ThreadPanel(h, {
            // A different thread is a fresh panel, with its own view.
            key: selectedId,
            props: { id: selectedId },
            onEmit: {
              RequestedClose: () => AppMessage.RequestedCloseThread(),
              Deleted: () => AppMessage.DeletedThread()
            }
          })
      )
    )
  }
})

export const App = AppNoDeps.pipe(
  Component.provide([WatchSummaries.layer, WatchAccount.layer, OpenMarkedThread.layer])
)
