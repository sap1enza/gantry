import { execFile } from 'node:child_process'

export type Exec = (file: string, args: string[], cwd?: string) => Promise<{ code: number; output: string }>

export const exec: Exec = (file, args, cwd) =>
  new Promise((resolve) =>
    execFile(file, args, { cwd, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout}${stderr}` || (err?.message ?? '') }),
    ),
  )

export const shellCommand = (command: string): [string, string[]] => [process.env.SHELL ?? '/bin/zsh', ['-lc', command]]
