import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol, session, shell } from "electron"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { PREVIEW_SCHEME } from "../shared/domain.ts"
import { EVENT_CHANNEL, RPC_CHANNEL, type RpcReply, Rpcs } from "../shared/ipc.ts"
import { handlers } from "./handlers.ts"
import { Artifacts } from "./services/Artifacts.ts"
import { Events } from "./services/Events.ts"
import { SettingsStore } from "./services/SettingsStore.ts"
import { Storage } from "./services/Storage.ts"
import { Threads } from "./services/Threads.ts"
import { Voice } from "./services/Voice.ts"

const DEV_URL = process.env.ELECTRON_RENDERER_URL

// A standard scheme, so a previewed page's relative links resolve against it.
// This has to happen before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true } }
])

/**
 * What a previewed page may load: its own files, and remote styles, fonts and
 * images so it looks as it would in a browser. No scripts and no requests of
 * its own, so a page an agent wrote is shown, never run.
 */
const PREVIEW_CSP = [
  "default-src 'none'",
  `style-src 'unsafe-inline' ${PREVIEW_SCHEME}: https:`,
  `font-src ${PREVIEW_SCHEME}: https: data:`,
  `img-src ${PREVIEW_SCHEME}: https: data: blob:`,
  `media-src ${PREVIEW_SCHEME}: https: data:`
].join("; ")

/** Serves a file from inside a thread's folder, and nothing outside it. */
const servePreview = async (cwd: string | null, requestUrl: string): Promise<Response> => {
  if (cwd === null) return new Response("No such thread.", { status: 404 })
  try {
    const url = new URL(requestUrl)
    const root = await fs.realpath(cwd)
    // Resolving symlinks first means a link inside the folder cannot point out of it.
    const file = await fs.realpath(path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, "")))
    const inside = path.relative(root, file)
    if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
      return new Response("Outside the thread's folder.", { status: 403 })
    }
    const response = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(response.headers)
    headers.set("Content-Security-Policy", PREVIEW_CSP)
    headers.set("Cache-Control", "no-store")
    return new Response(response.body, { status: response.status, headers })
  } catch {
    return new Response("Not found.", { status: 404 })
  }
}

const isAppUrl = (url: string) =>
  DEV_URL !== undefined ? url.startsWith(DEV_URL) : url.startsWith("file://")

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#050505",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  window.once("ready-to-show", () => window.show())
  // Links in a transcript open in the browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  if (DEV_URL !== undefined) {
    void window.loadURL(DEV_URL)
  } else {
    void window.loadFile(path.join(import.meta.dirname, "../renderer/index.html"))
  }
  return window
}

const main = async () => {
  await app.whenReady()
  nativeTheme.themeSource = "dark"

  // In development, keys can live in .env or .env.local beside package.json.
  // Variables already set in the environment win.
  if (!app.isPackaged) {
    for (const file of [".env.local", ".env"]) {
      try {
        process.loadEnvFile(path.join(app.getAppPath(), file))
      } catch {
        // The file is optional.
      }
    }
  }

  // The page may use the microphone for live voice, and nothing else.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === "media" && isAppUrl(contents.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    permission === "media" && contents !== null && isAppUrl(contents.getURL())
  )

  const Services = Layer.mergeAll(Artifacts.layer, Voice.layer).pipe(
    Layer.provideMerge(Threads.layer),
    Layer.provideMerge(SettingsStore.layer),
    Layer.provideMerge(Events.layer),
    Layer.provideMerge(Storage.layer(app.getPath("userData")))
  )
  const runtime = ManagedRuntime.make(Services)

  ipcMain.handle(RPC_CHANNEL, async (event, name: unknown, payload: unknown): Promise<RpcReply<unknown>> => {
    if (!isAppUrl(event.senderFrame?.url ?? "")) return { ok: false, error: "Unknown sender." }
    if (typeof name !== "string" || !(name in Rpcs)) return { ok: false, error: `Unknown request: ${String(name)}` }
    const rpc = Rpcs[name as keyof typeof Rpcs]
    const handler = handlers[name as keyof typeof handlers] as (payload: unknown) => Effect.Effect<
      unknown,
      { readonly message: string },
      Threads | Artifacts | SettingsStore | Voice
    >
    return runtime.runPromise(
      Schema.decodeUnknownEffect(rpc.payload as Schema.Codec<unknown>)(payload).pipe(
        Effect.mapError(() => ({ message: `Malformed payload for ${name}.` })),
        Effect.flatMap(handler),
        Effect.match({
          onSuccess: (value): RpcReply<unknown> => ({ ok: true, value }),
          onFailure: (error): RpcReply<unknown> => ({ ok: false, error: error.message })
        }),
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logError(`Request ${name} failed`, cause),
            { ok: false, error: "Something went wrong in the app. See the terminal for details." } as RpcReply<unknown>
          )
        )
      )
    )
  })

  // Forward every event to every window.
  runtime.runFork(
    Events.use((events) =>
      Stream.fromPubSub(events.hub).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            for (const window of BrowserWindow.getAllWindows()) {
              if (!window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, event)
            }
          })
        )
      )
    )
  )
  // Build the services now, so saved threads are loaded before the first request.
  await runtime.runPromise(Effect.void)

  protocol.handle(PREVIEW_SCHEME, async (request) => {
    const threadId = new URL(request.url).hostname
    const cwd = await runtime.runPromise(Threads.use((threads) => threads.cwd(threadId)))
    return servePreview(cwd, request.url)
  })


  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  let disposed = false
  app.on("before-quit", (event) => {
    if (disposed) return
    event.preventDefault()
    disposed = true
    void runtime.dispose().finally(() => app.quit())
  })
}

void main()
