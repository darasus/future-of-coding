import { Context, Effect, Layer } from "effect"
import { app, BrowserWindow } from "electron"
import electronUpdater from "electron-updater"
import * as fs from "node:fs"
import * as path from "node:path"
import type { UpdateMode, UpdateState, UpdateStatus } from "../../shared/domain.ts"
import { Events } from "./Events.ts"
import { SettingsStore } from "./SettingsStore.ts"
import { Threads } from "./Threads.ts"

/** How long after launch the first check runs, and how often after that. */
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
/** How often an update that installs on its own looks for a quiet moment. */
const QUIET_CHECK_MS = 20_000

/**
 * A feed to use in place of the one built into the app, as the URL of a folder
 * holding `latest-mac.yml` and the build it names. It is for trying an update
 * between two local builds without publishing anything.
 */
const TEST_FEED = process.env.FOC_UPDATE_FEED

/** Release notes as plain text. GitHub sends HTML; a list of versions is joined. */
const notesOf = (notes: unknown): string | null => {
  const text = typeof notes === "string"
    ? notes
    : Array.isArray(notes)
    ? notes.map((entry: { readonly note?: string | null }) => entry.note ?? "").join("\n\n")
    : ""
  const plain = text.replace(/<\/(p|li|h\d)>/g, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim()
  return plain === "" ? null : plain.slice(0, 1500)
}

/** What went wrong, in a sentence someone can act on. */
const failureOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  // The sentence shown is a summary. What the updater actually said goes to the log.
  console.warn(`[updates] ${message}`)
  if (/code signature|not signed|could not get code signature/i.test(message)) {
    return "This copy of the app is not signed, so macOS will not let it replace itself. Download the new version and install it by hand."
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR|getaddrinfo/i.test(message)) {
    return "The update server could not be reached. Check the connection and try again."
  }
  if (/\b404\b|Cannot find .*latest|No published versions|Unable to find latest version|production release exists/i.test(message)) {
    return "No published version could be found to update to."
  }
  return (message.split("\n")[0] ?? message).slice(0, 220)
}

/**
 * Keeps the app up to date, the way Sparkle does for a native app: it checks
 * in the background, says when there is a new version, downloads it, and
 * installs it when the app restarts.
 *
 * How far it goes on its own is the person's choice (`UpdateMode`):
 * - `offer`: say there is a new version and wait to be asked;
 * - `download`: download it in the background, then wait to be asked;
 * - `install`: download it, then restart into it at a moment when the window
 *   is out of sight and no thread is working.
 *
 * A copy run from source has nothing to update, so there it is unavailable.
 */
export class Updates extends Context.Service<Updates, {
  readonly status: Effect.Effect<UpdateStatus>
  /** Looks for a new version now. Does nothing while an update is already under way. */
  readonly check: Effect.Effect<void>
  /** Downloads the version that was found. */
  readonly download: Effect.Effect<void>
  /** Restarts into the version that was downloaded. */
  readonly install: Effect.Effect<void>
  setMode(mode: UpdateMode): Effect.Effect<void>
}>()("foc/main/Updates") {
  static readonly layer = Layer.effect(
    Updates,
    Effect.gen(function*() {
      const events = yield* Events
      const settings = yield* SettingsStore
      const threads = yield* Threads

      // A release build carries a note of where its updates are published. A
      // copy packaged only to be tried out (`pnpm build:unpack`) has none.
      const hasFeed = TEST_FEED !== undefined ||
        (app.isPackaged && fs.existsSync(path.join(process.resourcesPath, "app-update.yml")))
      const available = hasFeed
      let mode: UpdateMode = (yield* settings.get).updateMode
      let state: UpdateState = available
        ? { _tag: "Idle" }
        : {
          _tag: "Unavailable",
          reason: app.isPackaged
            ? "This build has no update feed, so it cannot check for or install updates."
            : "Updates are unavailable when the app runs from source."
        }
      let checkedAt: number | null = null
      let notes: string | null = null

      const status = (): UpdateStatus => ({ current: app.getVersion(), state, mode, checkedAt, notes })
      const set = (next: UpdateState) => {
        state = next
        events.publish({ _tag: "Update", status: status() })
      }
      const updater = electronUpdater.autoUpdater

      /** Nobody is looking and nothing is working: a restart would not be noticed. */
      const quiet = () =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() || window.isMinimized()) &&
        Effect.runSync(threads.list).every((thread) => thread.status !== "running" && thread.status !== "waiting")

      const download = () => {
        if (state._tag !== "Available") return
        set({ _tag: "Downloading", version: state.version, percent: 0 })
        updater.downloadUpdate().catch((error: unknown) => set({ _tag: "Failed", message: failureOf(error) }))
      }

      const install = () => {
        if (state._tag !== "Ready") return
        set({ _tag: "Installing", version: state.version })
        // Let the window hear that it is happening before the app goes away.
        setTimeout(() => updater.quitAndInstall(false, true), 400)
      }

      const check = () => {
        if (!available) return
        // An update that is downloading, downloaded or going in is not thrown away for a newer look.
        if (["Checking", "Downloading", "Ready", "Installing"].includes(state._tag)) return
        set({ _tag: "Checking" })
        updater.checkForUpdates().catch((error: unknown) => set({ _tag: "Failed", message: failureOf(error) }))
      }

      if (available) {
        updater.autoDownload = false
        // A downloaded update also goes in when the app is quit in the ordinary way.
        updater.autoInstallOnAppQuit = true
        updater.logger = null
        if (TEST_FEED !== undefined) {
          updater.forceDevUpdateConfig = true
          updater.setFeedURL({ provider: "generic", url: TEST_FEED })
        }
        updater.on("update-available", (info) => {
          checkedAt = Date.now()
          notes = notesOf(info.releaseNotes)
          set({ _tag: "Available", version: info.version })
          if (mode !== "offer") download()
        })
        updater.on("update-not-available", () => {
          checkedAt = Date.now()
          set({ _tag: "UpToDate" })
        })
        updater.on("download-progress", (progress) => {
          if (state._tag !== "Downloading") return
          const percent = Math.min(100, Math.max(0, Math.round(progress.percent)))
          if (percent !== state.percent) set({ _tag: "Downloading", version: state.version, percent })
        })
        updater.on("update-downloaded", (info) => set({ _tag: "Ready", version: info.version }))
        updater.on("error", (error) => {
          if (state._tag !== "Failed") set({ _tag: "Failed", message: failureOf(error) })
        })

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const first = setTimeout(check, FIRST_CHECK_MS)
            const regular = setInterval(check, CHECK_EVERY_MS)
            const whenQuiet = setInterval(() => {
              if (state._tag === "Ready" && mode === "install" && quiet()) install()
            }, QUIET_CHECK_MS)
            return () => {
              clearTimeout(first)
              clearInterval(regular)
              clearInterval(whenQuiet)
            }
          }),
          (stop) => Effect.sync(stop)
        )
      }

      return Updates.of({
        status: Effect.sync(status),
        check: Effect.sync(check),
        download: Effect.sync(download),
        install: Effect.sync(install),
        setMode: Effect.fn("Updates.setMode")(function*(next) {
          mode = next
          yield* settings.update({ updateMode: next })
          events.publish({ _tag: "Update", status: status() })
          // Asked to do more than offer while a version is waiting: get on with it.
          if (next !== "offer") download()
        })
      })
    })
  )
}
