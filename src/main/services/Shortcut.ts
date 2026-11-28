import { Context, Effect, Layer } from "effect"
import { globalShortcut } from "electron"
import { Events } from "./Events.ts"
import { SettingsStore } from "./SettingsStore.ts"

/**
 * The key combination that starts and stops a conversation from any app. It
 * is the Space key of the window, made to work when the window is not in
 * front: the window is not brought forward, only told to toggle voice.
 */
export class Shortcut extends Context.Service<Shortcut, {
  /** Registers the combination now in settings, letting go of the last one. */
  readonly sync: Effect.Effect<void>
}>()("fai/main/Shortcut") {
  static readonly layer = Layer.effect(
    Shortcut,
    Effect.gen(function*() {
      const settings = yield* SettingsStore
      const events = yield* Events
      let held: string | null = null

      const sync = Effect.gen(function*() {
        const { voiceShortcut } = yield* settings.get
        if (voiceShortcut !== held) {
          if (held !== null) globalShortcut.unregister(held)
          held = null
          if (voiceShortcut !== null) {
            try {
              if (globalShortcut.register(voiceShortcut, () => events.publish({ _tag: "ToggleVoice" }))) held = voiceShortcut
            } catch {
              // Not a combination the system understands: it stays unregistered.
            }
          }
        }
        yield* settings.setShortcutActive(held !== null)
      })

      yield* sync
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (held !== null) globalShortcut.unregister(held)
        })
      )

      return Shortcut.of({ sync })
    })
  )
}
