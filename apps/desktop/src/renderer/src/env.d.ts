import type { GantryBridge } from '@gantry/shared'

declare global {
  interface Window {
    gantry?: GantryBridge
  }
}
