import { Effect } from "effect"
import { BrowserWindow, dialog } from "electron"
import type { RpcName, RpcPayload, RpcSuccess } from "../shared/ipc.ts"
import { Artifacts } from "./services/Artifacts.ts"
import { Attention } from "./services/Attention.ts"
import { Memory } from "./services/Memory.ts"
import { Projects } from "./services/Projects.ts"
import { Shortcut } from "./services/Shortcut.ts"
import { SettingsStore } from "./services/SettingsStore.ts"
import { type ThreadError, Threads } from "./services/Threads.ts"
import { Updates } from "./services/Updates.ts"
import { Voice, type VoiceError } from "./services/Voice.ts"

export type Services = Threads | Artifacts | SettingsStore | Voice | Updates | Attention | Shortcut | Projects | Memory

type Handlers = {
  readonly [N in RpcName]: (payload: RpcPayload<N>) => Effect.Effect<RpcSuccess<N>, VoiceError | ThreadError, Services>
}

/** One handler per request in `Rpcs`. A missing or extra one does not compile. */
export const handlers: Handlers = {
  "threads.list": () => Threads.use((threads) => threads.list),
  "threads.get": ({ id }) => Threads.use((threads) => threads.get(id)),
  "threads.create": (input) => Threads.use((threads) => threads.create(input)),
  "threads.send": ({ id, screenshot, source, text }) =>
    Threads.use((threads) => threads.send(id, text, source, screenshot === true)),
  "threads.changes": ({ id }) => Threads.use((threads) => threads.changes(id)),
  "threads.stop": ({ id }) => Threads.use((threads) => threads.stop(id)),
  "threads.delete": ({ id }) => Threads.use((threads) => threads.remove(id)),
  "threads.setMode": ({ id, mode, source }) =>
    Threads.use((threads) => threads.setMode(id, mode, source ?? "typed")),
  "threads.setModel": ({ id, model, source }) =>
    Threads.use((threads) => threads.setModel(id, model, source ?? "typed")),
  "threads.resolvePermission": ({ decision, id, requestId, source }) =>
    Threads.use((threads) => threads.resolvePermission(id, requestId, decision, source ?? "typed")),
  "threads.answerQuestion": ({ answers, id, questionId }) =>
    Threads.use((threads) => threads.answerQuestion(id, questionId, answers)),
  "artifacts.read": ({ artifactId, threadId }) =>
    Artifacts.use((artifacts) => artifacts.read(threadId, artifactId)),
  "artifacts.reveal": ({ artifactId, threadId }) =>
    Artifacts.use((artifacts) => artifacts.reveal(threadId, artifactId)),
  "settings.get": () => SettingsStore.use((settings) => settings.get),
  "settings.update": (patch) =>
    SettingsStore.use((settings) => settings.update(patch)).pipe(
      // The shortcut may be what changed; settings then say whether it took.
      Effect.andThen(Shortcut.use((shortcut) => shortcut.sync)),
      Effect.andThen(SettingsStore.use((settings) => settings.get))
    ),
  "account.get": () => Threads.use((threads) => threads.account),
  "dialog.pickFolder": () =>
    Effect.promise(async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> }
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0] ?? null
    }),
  "updates.get": () => Updates.use((updates) => updates.status),
  "updates.check": () => Updates.use((updates) => updates.check),
  "updates.download": () => Updates.use((updates) => updates.download),
  "updates.install": () => Updates.use((updates) => updates.install),
  "updates.setMode": ({ mode }) => Updates.use((updates) => updates.setMode(mode)),
  "projects.find": ({ query }) =>
    Projects.use((projects) =>
      query.trim() === ""
        ? Effect.map(projects.list, (all) => all.slice(0, 40))
        : Effect.map(projects.find(query), (matches) => matches.map((match) => match.project))
    ),
  "memory.list": () => Memory.use((memory) => memory.list),
  "memory.add": ({ text }) => Memory.use((memory) => memory.add(text)),
  "memory.remove": ({ id }) => Memory.use((memory) => memory.remove(id)),
  "memory.recap": () => Memory.use((memory) => memory.recap),
  "memory.setRecap": ({ text }) => Memory.use((memory) => memory.setRecap(text)),
  "voice.status": ({ live }) => Attention.use((attention) => attention.setVoiceLive(live)),
  "voice.connect": ({ sdp }) => Voice.use((voice) => voice.connect(sdp))
}
