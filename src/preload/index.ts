import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { AppEvent, PreloadApi } from "../shared/ipc.ts"

// Channel names are repeated here because a sandboxed preload cannot import
// modules that pull in runtime dependencies.
const RPC_CHANNEL = "fai:rpc"
const EVENT_CHANNEL = "fai:event"

const api: PreloadApi = {
  invoke: (name, payload) => ipcRenderer.invoke(RPC_CHANNEL, name, payload),
  subscribe: (listener) => {
    const handler = (_: IpcRendererEvent, event: AppEvent) => listener(event)
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, handler)
    }
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld("fai", api)
