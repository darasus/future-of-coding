import { Query } from "@effect/ui"
import { Effect, Layer, Schema } from "effect"
import { Account, ArtifactContent, Settings, Thread, ThreadSummary } from "../../shared/domain.ts"
import { Bridge, live } from "./services/Bridge.ts"

export const SettingsTag = Query.Tag("settings")

/** The board: every thread without its transcript, newest activity first. */
export class WatchSummaries extends Query.StreamService<WatchSummaries>()(
  "threads/WatchSummaries",
  { success: Schema.Array(ThreadSummary) }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return () =>
        live(
          bridge,
          bridge.call("threads.list", undefined),
          (event) => event._tag === "Summaries" ? event.summaries : undefined
        )
    })
  ).pipe(Layer.provide(Bridge.layer))
}

/** One thread with its transcript, following it as the agent works. */
export class WatchThread extends Query.StreamService<WatchThread>()(
  "threads/WatchThread",
  {
    args: { id: Schema.String },
    success: Schema.NullOr(Thread),
    idleTimeToLive: "5 seconds"
  }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return ({ id }) =>
        live(
          bridge,
          bridge.call("threads.get", { id }),
          (event) =>
            event._tag === "Thread" && event.thread.id === id
              ? event.thread
              : event._tag === "ThreadDeleted" && event.id === id
              ? null
              : undefined
        )
    })
  ).pipe(Layer.provide(Bridge.layer))
}

/** Which Claude account the agents run as. */
export class WatchAccount extends Query.StreamService<WatchAccount>()(
  "account/WatchAccount",
  { success: Account }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return () =>
        live(
          bridge,
          bridge.call("account.get", undefined),
          (event) => event._tag === "Account" ? event.account : undefined
        )
    })
  ).pipe(Layer.provide(Bridge.layer))
}

export class GetSettings extends Query.Service<GetSettings>()(
  "settings/GetSettings",
  { success: Settings, staleTime: "5 minutes", tags: [SettingsTag] }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return () => Effect.orDie(bridge.call("settings.get", undefined))
    })
  ).pipe(Layer.provide(Bridge.layer))
}

/**
 * A file a thread wrote. `version` is the artifact's edit count, so the file
 * is read again each time the agent changes it.
 */
export class ReadArtifact extends Query.Service<ReadArtifact>()(
  "artifacts/ReadArtifact",
  {
    args: { threadId: Schema.String, artifactId: Schema.String, version: Schema.Number },
    success: ArtifactContent,
    staleTime: "30 seconds"
  }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return ({ artifactId, threadId }) => Effect.orDie(bridge.call("artifacts.read", { threadId, artifactId }))
    })
  ).pipe(Layer.provide(Bridge.layer))
}
