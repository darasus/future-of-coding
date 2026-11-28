import { Context, Effect, Layer, PubSub } from "effect"
import type { AppEvent } from "../../shared/ipc.ts"

/** Everything the main process tells its windows goes through here. */
export class Events extends Context.Service<Events, {
  readonly hub: PubSub.PubSub<AppEvent>
  /** Publishes from plain callbacks, such as the agent's message loop. */
  publish(event: AppEvent): void
}>()("fai/main/Events") {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function*() {
      const hub = yield* PubSub.unbounded<AppEvent>()
      return Events.of({
        hub,
        publish: (event) => {
          PubSub.publishUnsafe(hub, event)
        }
      })
    })
  )
}
