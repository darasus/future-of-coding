import { Schema } from "effect"
import {
  Account,
  ArtifactContent,
  InputSource,
  PermissionMode,
  Settings,
  SettingsPatch,
  Thread,
  ThreadSummary
} from "./domain.ts"

export const RPC_CHANNEL = "foc:rpc"
export const EVENT_CHANNEL = "foc:event"

const rpc = <P extends Schema.Top, S extends Schema.Top>(payload: P, success: S) => ({ payload, success })

const ThreadRef = Schema.Struct({ id: Schema.String })
const ArtifactRef = Schema.Struct({ threadId: Schema.String, artifactId: Schema.String })

/**
 * Every request the renderer can make of the main process. The main process
 * decodes each payload with its Schema before a handler sees it.
 */
export const Rpcs = {
  "threads.list": rpc(Schema.Void, Schema.Array(ThreadSummary)),
  "threads.get": rpc(ThreadRef, Schema.NullOr(Thread)),
  "threads.create": rpc(
    Schema.Struct({
      prompt: Schema.String,
      cwd: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      permissionMode: Schema.NullOr(PermissionMode),
      source: InputSource
    }),
    ThreadSummary
  ),
  "threads.send": rpc(
    Schema.Struct({ id: Schema.String, text: Schema.String, source: InputSource }),
    Schema.Void
  ),
  "threads.stop": rpc(ThreadRef, Schema.Void),
  "threads.delete": rpc(ThreadRef, Schema.Void),
  "threads.setMode": rpc(
    Schema.Struct({ id: Schema.String, mode: PermissionMode, source: Schema.optionalKey(InputSource) }),
    Schema.Void
  ),
  "threads.setModel": rpc(
    Schema.Struct({ id: Schema.String, model: Schema.String, source: Schema.optionalKey(InputSource) }),
    Schema.Void
  ),
  "threads.resolvePermission": rpc(
    Schema.Struct({
      id: Schema.String,
      requestId: Schema.String,
      decision: Schema.Literals(["allow", "always", "deny"]),
      /** Set when the decision was spoken, so the transcript can say so. */
      source: Schema.optionalKey(InputSource)
    }),
    Schema.Void
  ),
  "threads.answerQuestion": rpc(
    Schema.Struct({
      id: Schema.String,
      questionId: Schema.String,
      /** One answer per question asked, in order: an option's label or the user's own words. */
      answers: Schema.Array(Schema.String)
    }),
    Schema.Void
  ),
  "artifacts.read": rpc(ArtifactRef, ArtifactContent),
  "artifacts.reveal": rpc(ArtifactRef, Schema.Void),
  "settings.get": rpc(Schema.Void, Settings),
  "settings.update": rpc(SettingsPatch, Settings),
  "account.get": rpc(Schema.Void, Account),
  "dialog.pickFolder": rpc(Schema.Void, Schema.NullOr(Schema.String)),
  "voice.connect": rpc(
    Schema.Struct({ sdp: Schema.String }),
    Schema.Struct({ sessionId: Schema.String, sdp: Schema.String })
  )
} as const

export type RpcName = keyof typeof Rpcs
export type RpcPayload<N extends RpcName> = (typeof Rpcs)[N]["payload"]["Type"]
export type RpcSuccess<N extends RpcName> = (typeof Rpcs)[N]["success"]["Type"]

/** What a request resolves with across the IPC boundary. */
export type RpcReply<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string }

/** What the main process pushes to the renderer. */
export const AppEvent = Schema.Union([
  Schema.TaggedStruct("Summaries", { summaries: Schema.Array(ThreadSummary) }),
  Schema.TaggedStruct("Thread", { thread: Thread }),
  Schema.TaggedStruct("ThreadDeleted", { id: Schema.String }),
  Schema.TaggedStruct("Account", { account: Account })
])
export type AppEvent = typeof AppEvent.Type

/** The API the preload script exposes on `window.foc`. */
export interface PreloadApi {
  readonly invoke: (name: string, payload: unknown) => Promise<RpcReply<unknown>>
  readonly subscribe: (listener: (event: AppEvent) => void) => () => void
  readonly platform: string
}
