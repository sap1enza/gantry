import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

const commandLineToolsBin = '/Library/Developer/CommandLineTools/usr/bin'
const archIndependentGitPath = existsSync(`${commandLineToolsBin}/git`) ? { PATH: `${commandLineToolsBin}:${process.env.PATH}` } : {}

export default defineConfig({ test: { env: archIndependentGitPath } })
