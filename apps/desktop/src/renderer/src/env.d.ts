/// <reference types="vite/client" />
import type { GantryTransport } from '@gantry/shared/ipc'

declare global {
  interface Window {
    gantryTransport?: GantryTransport
  }
}
