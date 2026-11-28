import { Context, Effect, Layer, Queue, Schema, Stream } from "effect"
import type { AppEvent, PreloadApi, RpcName, RpcPayload, RpcSuccess } from "../../../shared/ipc.ts"

declare global {
  interface Window {
    readonly fai: PreloadApi
  }
}

export class BridgeError extends Schema.TaggedError<BridgeError>()("BridgeError", {
  message: Schema.String
}) {}

/** The renderer's only way to reach the main process. */
export class Bridge extends Context.Service<Bridge, {
  call<N extends RpcName>(name: N, payload: RpcPayload<N>): Effect.Effect<RpcSuccess<N>, BridgeError>
  /** Every event the main process pushes, from the moment the stream starts. */
  readonly events: Stream.Stream<AppEvent>
}>()("fai/renderer/Bridge") {
  static readonly layer = Layer.sync(Bridge, () =>
    Bridge.of({
      call: (name, payload) =>
        Effect.promise(() => window.fai.invoke(name, payload)).pipe(
          Effect.flatMap((reply) =>
            reply.ok
              ? Effect.succeed(reply.value as RpcSuccess<typeof name>)
              : Effect.fail(new BridgeError({ message: reply.error }))
          )
        ),
      events: Stream.callback<AppEvent>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => window.fai.subscribe((event) => Queue.offerUnsafe(queue, event))),
          (unsubscribe) => Effect.sync(unsubscribe)
        )
      )
    }))
}

/**
 * A value the main process keeps current: the events that carry it, then the
 * value fetched once in case no event has arrived yet. An event always wins
 * over the fetched value, which may be older.
 */
export const live = <A>(
  bridge: Bridge["Service"],
  fetch: Effect.Effect<A, BridgeError>,
  pick: (event: AppEvent) => A | undefined
): Stream.Stream<A> =>
  Stream.callback<A>((queue) =>
    Effect.gen(function*() {
      let seen = false
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          window.fai.subscribe((event) => {
            const value = pick(event)
            if (value === undefined) return
            seen = true
            Queue.offerUnsafe(queue, value)
          })
        ),
        (unsubscribe) => Effect.sync(unsubscribe)
      )
      const initial = yield* Effect.orDie(fetch)
      if (!seen) Queue.offerUnsafe(queue, initial)
    })
  )

/** One kind of event from the main process, for a subscription that only cares about that one. */
export const appEvent = <T extends AppEvent["_tag"]>(tag: T): Stream.Stream<Extract<AppEvent, { readonly _tag: T }>> =>
  Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        window.fai.subscribe((event) => {
          if (event._tag === tag) Queue.offerUnsafe(queue, event as Extract<AppEvent, { readonly _tag: T }>)
        })
      ),
      (unsubscribe) => Effect.sync(unsubscribe)
    )
  )
