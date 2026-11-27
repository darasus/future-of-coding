import { Component, Subscription, UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Effect, Schema, Stream } from "effect"
import { AsyncResult } from "effect/reactivity"
import type { ThreadStatus, ThreadSummary } from "../../shared/domain.ts"
import { Icon } from "./components/icons.ts"
import { MarkReady } from "./components/mounts.ts"
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
  DeletedThread: {}
})

type H = Html.H<typeof AppMessage.Type>

/** Threads that need the person come first, then the ones working, then the finished. */
const rank: Record<ThreadStatus, number> = { waiting: 0, error: 0, running: 1, idle: 1, done: 2 }

/**
 * The name a row and the open thread's panel share while one turns into the
 * other. Only one element may carry it at a time.
 */
const MORPH = "thread-morph"

/** A thread in two lines: what it is, and where it stands. */
const ThreadRow = (h: H, thread: ThreadSummary, selected: boolean, morphs: boolean) => {
  const done = thread.todos.filter((todo) => todo.status === "completed").length
  const busy = thread.status === "running" || thread.status === "waiting"
  const state = thread.activity !== "" ? thread.activity : thread.preview
  return h.li.key(thread.id).children(
    h.button.class("row", `is-${thread.status}`, selected && "selected")
      .attrs({ type: "button", "aria-pressed": String(selected) })
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
        ),
        busy && thread.todos.length > 0 && h.span.class("row-count").children(`${done}/${thread.todos.length}`),
        thread.permissionMode === "bypassPermissions" &&
          h.span.class("bypass").attr("title", "Runs without asking").children("bypass")
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
  // Each change of what is open is one view transition, tagged with what
  // happened so the stylesheet can give each its own motion:
  // - open: a row expands into its panel
  // - close: the panel shrinks back into its row
  // - switch: one panel gives way to another
  update: {
    PressedThread: ($, { id }) => $.evolve({ armedId: id, returnId: null }),
    ClickedThread: ($, { id }) => {
      const open = $.model.settingsOpen ? null : $.model.selectedId
      if (open === id) {
        return $.evolve({ selectedId: null, armedId: null, returnId: id }).viewTransition(["close"])
      }
      const fromList = open === null && !$.model.settingsOpen
      return $.evolve({ selectedId: id, settingsOpen: false, armedId: null, returnId: null })
        .viewTransition([fromList ? "open" : "switch"])
    },
    SettledClose: ($) => $.evolve({ returnId: null }),
    ClickedSettings: ($) =>
      $.evolve({ settingsOpen: !$.model.settingsOpen, armedId: null, returnId: null }).viewTransition(["switch"]),
    RequestedCloseSettings: ($) => $.evolve({ settingsOpen: false }).viewTransition(["switch"]),
    RequestedCloseThread: ($) =>
      $.evolve({ selectedId: null, armedId: null, returnId: $.model.selectedId }).viewTransition(["close"]),
    DeletedThread: ($) => $.evolve({ selectedId: null, armedId: null, returnId: null }).viewTransition(["close"])
  },
  // Once the panel has landed back in its row, the row gives the shared name
  // up, so the next row to open can take it.
  subscriptions: ({ model }) => [
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
    return h.div.class("shell", detail && "has-detail").onMount(MarkReady({ after: 900 })).children(
      h.header.class("topbar").children(
        h.button.class("icon-btn", model.settingsOpen && "active")
          .attrs({ type: "button", title: "Settings", "aria-label": "Settings", "aria-pressed": String(model.settingsOpen) })
          .on("click", AppMessage.ClickedSettings()).children(Icon(h, "settings"))
      ),
      h.main.class("board", threads.length === 0 && "is-empty").children(
        threads.length > 0 &&
          h.ul.class("rows").attr("aria-label", "Threads").children(
            ...threads.map((thread) =>
              ThreadRow(
                h,
                thread,
                thread.id === selectedId && !model.settingsOpen,
                // A pressed row takes the name only when nothing is open: with a
                // panel on screen, the panel already has it.
                (model.armedId === thread.id && !detail) || model.returnId === thread.id
              )
            )
          ),
        VoiceOrb(h, {})
      ),
      detail && h.aside.class("detail").children(
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

export const App = AppNoDeps.pipe(Component.provide([WatchSummaries.layer, WatchAccount.layer]))
