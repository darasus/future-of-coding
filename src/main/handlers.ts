import { Effect } from "effect"
import { BrowserWindow, dialog } from "electron"
import type { RpcName, RpcPayload, RpcSuccess } from "../shared/ipc.ts"
import { Artifacts } from "./services/Artifacts.ts"
import { SettingsStore } from "./services/SettingsStore.ts"
import { type ThreadError, Threads } from "./services/Threads.ts"
import { Voice, type VoiceError } from "./services/Voice.ts"

type Services = Threads | Artifacts | SettingsStore | Voice

type Handlers = {
  readonly [N in RpcName]: (payload: RpcPayload<N>) => Effect.Effect<RpcSuccess<N>, VoiceError | ThreadError, Services>
}

/** One handler per request in `Rpcs`. A missing or extra one does not compile. */
export const handlers: Handlers = {
  "threads.list": () => Threads.use((threads) => threads.list),
  "threads.get": ({ id }) => Threads.use((threads) => threads.get(id)),
  "threads.create": (input) => Threads.use((threads) => threads.create(input)),
  "threads.send": ({ id, source, text }) =>
    Threads.use((threads) => threads.send(id, text, source)),
  "threads.stop": ({ id }) => Threads.use((threads) => threads.stop(id)),
  "threads.delete": ({ id }) => Threads.use((threads) => threads.remove(id)),
  "threads.setMode": ({ id, mode, source }) =>
    Threads.use((threads) => threads.setMode(id, mode, source ?? "typed")),
  "threads.setModel": ({ id, model, source }) =>
    Threads.use((threads) => threads.setModel(id, model, source ?? "typed")),
  "threads.resolvePermission": ({ decision, id, requestId, source }) =>
    Threads.use((threads) => threads.resolvePermission(id, requestId, decision, source ?? "typed")),
  "artifacts.read": ({ artifactId, threadId }) =>
    Artifacts.use((artifacts) => artifacts.read(threadId, artifactId)),
  "artifacts.reveal": ({ artifactId, threadId }) =>
    Artifacts.use((artifacts) => artifacts.reveal(threadId, artifactId)),
  "settings.get": () => SettingsStore.use((settings) => settings.get),
  "settings.update": (patch) => SettingsStore.use((settings) => settings.update(patch)),
  "account.get": () => Threads.use((threads) => threads.account),
  "dialog.pickFolder": () =>
    Effect.promise(async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> }
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0] ?? null
    }),
  "voice.connect": ({ sdp }) => Voice.use((voice) => voice.connect(sdp))
}
