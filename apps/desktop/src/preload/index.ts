import { IPC_EVENT, IPC_INVOKE, type GantryBridge, type GantryPush } from '@gantry/shared/ipc'
import { createApiProxy } from '@gantry/shared/rpc'
import { contextBridge, ipcRenderer } from 'electron'

const bridge: GantryBridge = {
  api: createApiProxy((path, args) => ipcRenderer.invoke(IPC_INVOKE, path, args)),
  onPush(listener) {
    const handler = (_: unknown, push: GantryPush) => listener(push)
    ipcRenderer.on(IPC_EVENT, handler)
    return () => ipcRenderer.off(IPC_EVENT, handler)
  },
}

contextBridge.exposeInMainWorld('gantry', bridge)
