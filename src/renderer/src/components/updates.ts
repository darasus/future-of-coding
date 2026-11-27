import { Command } from "@effect/ui"
import { Effect, Schema } from "effect"
import { UpdateMode } from "../../../shared/domain.ts"
import { Bridge } from "../services/Bridge.ts"

/**
 * Asks the main process to do something about updates. It reports nothing
 * back: the result arrives as a change in the update's state, which the
 * window already follows.
 */
export class RunUpdate extends Command.Service<RunUpdate>()(
  "updates/RunUpdate",
  { args: { action: Schema.Literals(["check", "download", "install"]) } }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return ({ action }) => Effect.ignore(bridge.call(`updates.${action}`, undefined))
    })
  )
}

/** Chooses how far the app goes with a new version on its own. */
export class SetUpdateMode extends Command.Service<SetUpdateMode>()(
  "updates/SetUpdateMode",
  { args: { mode: UpdateMode } }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return ({ mode }) => Effect.ignore(bridge.call("updates.setMode", { mode }))
    })
  )
}
