import type { GantryBridge } from '@gantry/shared/ipc'
import { createApiProxy } from '@gantry/shared/rpc'

const transport = () => window.gantryTransport!

export const bridge: GantryBridge = {
  api: createApiProxy((path, args) => transport().invoke(path, args)),
  onPush: (listener) => transport().onPush(listener),
}
export const api = bridge.api
