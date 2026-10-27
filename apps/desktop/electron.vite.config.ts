import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const bundleWorkspace = externalizeDepsPlugin({ exclude: ['@gantry/shared'] })

export default defineConfig({
  main: { plugins: [bundleWorkspace] },
  preload: { plugins: [bundleWorkspace], build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: { plugins: [react()] },
})
