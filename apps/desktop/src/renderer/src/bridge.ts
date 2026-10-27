import { createMockBridge } from './mock'

export const bridge = window.gantry ?? createMockBridge({ empty: new URLSearchParams(location.search).has('empty') })
export const api = bridge.api
