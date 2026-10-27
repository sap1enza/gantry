import type { GantryBridge } from '@gantry/shared/ipc'
import { createApiProxy } from '@gantry/shared/rpc'
import { createMockBridge } from './mock'

const transport = window.gantryTransport

export const bridge: GantryBridge = transport
  ? { api: createApiProxy(transport.invoke), onPush: transport.onPush }
  : createMockBridge({ empty: new URLSearchParams(location.search).has('empty') })
export const api = bridge.api
