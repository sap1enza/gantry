import { IPC_EVENT, IPC_INVOKE, type GantryPush, type GantryTransport } from '@gantry/shared/ipc'
import { contextBridge, ipcRenderer } from 'electron'

const transport: GantryTransport = {
  invoke: (path, args) => ipcRenderer.invoke(IPC_INVOKE, path, args),
  onPush(listener) {
    const handler = (_: unknown, push: GantryPush) => listener(push)
    ipcRenderer.on(IPC_EVENT, handler)
    return () => ipcRenderer.off(IPC_EVENT, handler)
  },
}

contextBridge.exposeInMainWorld('gantryTransport', transport)
