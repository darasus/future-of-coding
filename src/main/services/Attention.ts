import { Context, Effect, Layer, Stream } from "effect"
import { app, BrowserWindow, Notification } from "electron"
import type { ThreadStatus, ThreadSummary } from "../../shared/domain.ts"
import { Events } from "./Events.ts"

/** What was last known about a thread, to tell what changed. */
interface Seen {
  readonly status: ThreadStatus
  readonly approvals: number
  readonly questions: number
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Gets the person's attention when a thread needs them and nothing else is
 * telling them. While a conversation is live the assistant says it aloud, and
 * while the window is in front they can see it, so a notification is only
 * shown when neither is true. The Dock icon always carries the number of
 * threads waiting on an approval or an answer.
 */
export class Attention extends Context.Service<Attention, {
  /** Whether a voice conversation is running, as the window reports it. */
  setVoiceLive(live: boolean): Effect.Effect<void>
}>()("fai/main/Attention") {
  static readonly layer = Layer.effect(
    Attention,
    Effect.gen(function*() {
      const events = yield* Events
      let voiceLive = false
      const seen = new Map<string, Seen>()
      // A notification that is let go of before it is clicked loses its click.
      const shown = new Set<Notification>()

      const attended = () =>
        voiceLive || BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused())

      const reveal = (threadId: string) => {
        const [window] = BrowserWindow.getAllWindows()
        if (window !== undefined) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
        app.focus({ steal: true })
        events.publish({ _tag: "Reveal", threadId })
      }

      const notify = (thread: ThreadSummary, subtitle: string, body: string) => {
        if (attended() || !Notification.isSupported()) return
        const notification = new Notification({ title: thread.title, subtitle, body })
        shown.add(notification)
        notification.on("click", () => {
          shown.delete(notification)
          reveal(thread.id)
        })
        notification.on("close", () => shown.delete(notification))
        notification.show()
      }

      const onSummaries = (summaries: ReadonlyArray<ThreadSummary>) => {
        const waiting = summaries.filter((thread) => thread.pendingPermissions > 0 || thread.pendingQuestions > 0).length
        app.dock?.setBadge(waiting === 0 ? "" : String(waiting))
        for (const thread of summaries) {
          const before = seen.get(thread.id)
          seen.set(thread.id, {
            status: thread.status,
            approvals: thread.pendingPermissions,
            questions: thread.pendingQuestions
          })
          // A thread seen for the first time has no change to report.
          if (before === undefined) continue
          if (thread.pendingQuestions > before.questions) {
            notify(thread, "Has a question for you", "It is waiting for your answer.")
          } else if (thread.pendingPermissions > 0 && before.approvals === 0) {
            notify(thread, "Needs your approval", oneLine(thread.activity, 140) || "It is waiting for you to allow a step.")
          } else if (thread.status !== before.status && thread.status === "done") {
            notify(thread, "Finished", oneLine(thread.preview, 180))
          } else if (thread.status !== before.status && thread.status === "error") {
            notify(thread, "Stopped with an error", oneLine(thread.preview, 180))
          }
        }
        const present = new Set(summaries.map((thread) => thread.id))
        for (const id of seen.keys()) if (!present.has(id)) seen.delete(id)
      }

      yield* Stream.fromPubSub(events.hub).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "Summaries") onSummaries(event.summaries)
          })
        ),
        Effect.forkScoped
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => app.dock?.setBadge("")))

      return Attention.of({
        setVoiceLive: (live) =>
          Effect.sync(() => {
            voiceLive = live
          })
      })
    })
  )
}
