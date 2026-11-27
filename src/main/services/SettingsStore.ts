import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { safeStorage } from "electron"
import * as os from "node:os"
import { PermissionMode, type Settings, type SettingsPatch } from "../../shared/domain.ts"
import { Storage } from "./Storage.ts"

const FILE = "settings.json"

/** What is written to disk. The OpenAI key is encrypted with the OS keychain. */
const Stored = Schema.Struct({
  defaultCwd: Schema.String,
  defaultModel: Schema.NullOr(Schema.String),
  defaultPermissionMode: PermissionMode,
  preferSubscription: Schema.Boolean,
  openAiKeyCipher: Schema.NullOr(Schema.String),
  voiceModel: Schema.String,
  voiceBackendModel: Schema.String
})
type Stored = typeof Stored.Type

const defaults = (): Stored => ({
  defaultCwd: os.homedir(),
  defaultModel: null,
  defaultPermissionMode: "default",
  preferSubscription: true,
  openAiKeyCipher: null,
  voiceModel: "gpt-live-1.1",
  voiceBackendModel: "gpt-5.6-terra"
})

const toPublic = (stored: Stored): Settings => ({
  defaultCwd: stored.defaultCwd,
  defaultModel: stored.defaultModel,
  defaultPermissionMode: stored.defaultPermissionMode,
  preferSubscription: stored.preferSubscription,
  hasOpenAiKey: stored.openAiKeyCipher !== null || Boolean(process.env.OPENAI_API_KEY),
  voiceModel: stored.voiceModel,
  voiceBackendModel: stored.voiceBackendModel
})

const encrypt = (key: string): string | null =>
  safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key).toString("base64") : null

const decrypt = (cipher: string): string | null => {
  try {
    return safeStorage.decryptString(Buffer.from(cipher, "base64"))
  } catch {
    return null
  }
}

export class SettingsStore extends Context.Service<SettingsStore, {
  readonly get: Effect.Effect<Settings>
  update(patch: SettingsPatch): Effect.Effect<Settings>
  /** The stored key, or `OPENAI_API_KEY` from the environment. */
  readonly openAiKey: Effect.Effect<Option.Option<Redacted.Redacted<string>>>
}>()("foc/main/SettingsStore") {
  static readonly layer = Layer.effect(
    SettingsStore,
    Effect.gen(function*() {
      const storage = yield* Storage
      const raw = yield* storage.readJson(FILE)
      let current: Stored = Option.getOrElse(
        Schema.decodeUnknownOption(Stored)({ ...defaults(), ...(raw as object | null) }),
        defaults
      )

      return SettingsStore.of({
        get: Effect.sync(() => toPublic(current)),
        update: Effect.fn("SettingsStore.update")(function*(patch) {
          const { openAiKey, ...rest } = patch
          current = {
            ...current,
            ...rest,
            ...(openAiKey === undefined
              ? {}
              : { openAiKeyCipher: openAiKey.trim() === "" ? null : encrypt(openAiKey.trim()) })
          }
          yield* storage.writeJson(FILE, current)
          return toPublic(current)
        }),
        openAiKey: Effect.sync(() => {
          const stored = current.openAiKeyCipher === null ? null : decrypt(current.openAiKeyCipher)
          const key = stored ?? process.env.OPENAI_API_KEY
          return key ? Option.some(Redacted.make(key)) : Option.none()
        })
      })
    })
  )
}
