import { query as sdkQuery, type CanUseTool, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools'
import { errorMessage, type AgentEventSink, type AgentProvider, type AgentState, type DispatchRequest } from '@gantry/shared'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { summarizeTool, toEvents } from './events'
import { installGuard, isExecutable, scrubEnv, shellQuote, type Guard } from './guard'
import { presetOptions } from './policy'

export { shellQuote }

export interface ClaudeDeps {
  query: typeof sdkQuery
  exec: (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>
  claudePath?: () => string | undefined
  guard: typeof installGuard
}

interface Run {
  request: DispatchRequest
  sink: AgentEventSink
  sessionId?: string
  query?: Query
  abort: AbortController
  close: () => void
  active: boolean
  halt?: 'paused' | 'stopped'
  questions: Map<string, (text: string | undefined) => void>
  done: Promise<void>
}

const agentEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: [process.env.PATH, `${homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':'),
})

export const findClaude = (path = agentEnv().PATH ?? '') =>
  path
    .split(':')
    .filter(Boolean)
    .map((dir) => join(dir, 'claude'))
    .find(isExecutable)

const defaultDeps: ClaudeDeps = { query: sdkQuery, exec: promisify(execFile), claudePath: findClaude, guard: installGuard }

export const resumeCommand = (worktreePath: string, sessionId: string) =>
  `cd ${shellQuote(worktreePath)} && claude --resume ${shellQuote(sessionId)}`

async function* userInput(text: string, closed: Promise<void>): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
  await closed
}

export function createClaudeProvider(deps: ClaudeDeps = defaultDeps): AgentProvider {
  const runs = new Map<string, Run>()

  function get(actionableId: string): Run {
    const run = runs.get(actionableId)
    if (!run) throw new Error(`No Claude run for actionable ${actionableId}`)
    return run
  }

  function ask(run: Run, prompt: string, options?: string[]): Promise<string | undefined> {
    const id = randomUUID()
    const answered = new Promise<string | undefined>((resolve) => run.questions.set(id, resolve))
    run.sink({ type: 'question', id, prompt, options })
    run.sink({ type: 'state', state: 'awaiting_input' })
    return answered.finally(() => {
      run.questions.delete(id)
      if (!run.questions.size && !run.halt) run.sink({ type: 'state', state: 'running' })
    })
  }

  function cancelQuestions(run: Run) {
    for (const resolve of run.questions.values()) resolve(undefined)
  }

  const interrupted = { behavior: 'deny', message: 'Interrupted by the user.', interrupt: true } as const

  const canUseTool = (run: Run, approvals: Set<string>): CanUseTool => async (toolName, input, { toolUseID }) => {
    if (toolName === 'AskUserQuestion') {
      const answers: Record<string, string> = {}
      for (const question of (input as unknown as AskUserQuestionInput).questions) {
        const text = await ask(run, question.question, question.options.map((option) => option.label))
        if (text === undefined) return interrupted
        answers[question.question] = text
      }
      return { behavior: 'allow', updatedInput: { ...input, answers } }
    }
    if (!approvals.delete(toolUseID)) return { behavior: 'allow' }
    const text = await ask(run, `Allow ${toolName}: ${summarizeTool(input)}?`, ['Allow', 'Deny'])
    if (text === undefined) return interrupted
    return text === 'Allow' ? { behavior: 'allow' } : { behavior: 'deny', message: `The user denied this: ${text}` }
  }

  async function execute(run: Run, prompt: string) {
    const closed = new Promise<void>((resolve) => (run.close = resolve))
    run.abort = new AbortController()
    run.halt = undefined
    run.active = true
    run.sink({ type: 'state', state: 'running' })
    let outcome: AgentState | undefined
    let guard: Guard | undefined
    const approvals = new Set<string>()
    try {
      const { permissionPreset, worktreePath } = run.request
      guard = await deps.guard(run.request)
      run.query = deps.query({
        prompt: userInput(prompt, closed),
        options: {
          cwd: run.request.worktreePath,
          model: run.request.model,
          resume: run.sessionId,
          abortController: run.abort,
          env: scrubEnv(agentEnv(), permissionPreset, guard),
          pathToClaudeCodeExecutable: deps.claudePath?.(),
          canUseTool: canUseTool(run, approvals),
          ...presetOptions(permissionPreset, worktreePath, guard, approvals),
        },
      })
      for await (const message of run.query) {
        if (message.type === 'system' && message.subtype === 'init') run.sessionId = message.session_id
        for (const event of toEvents(message)) {
          if (!(run.halt && (event.type === 'result' || event.type === 'error'))) run.sink(event)
        }
        if (message.type === 'result') {
          outcome = message.subtype === 'success' ? 'completed' : 'failed'
          run.close()
        }
      }
    } catch (error) {
      if (!run.halt) run.sink({ type: 'error', message: errorMessage(error) })
      outcome = 'failed'
    } finally {
      run.close()
      run.query = undefined
      await guard?.release()
      run.active = false
      if (!run.halt && runs.get(run.request.actionableId) === run) runs.delete(run.request.actionableId)
    }
    if (!run.halt && !outcome) run.sink({ type: 'error', message: 'Claude exited without a result.' })
    run.sink({ type: 'state', state: run.halt ?? outcome ?? 'failed' })
  }

  return {
    id: 'claude',
    displayName: 'Claude Code',
    models: [
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    ],

    async detect() {
      try {
        const { stdout } = await deps.exec('claude', ['--version'], { env: agentEnv() })
        return { available: true, version: stdout.trim() }
      } catch (error) {
        const notFound = (error as NodeJS.ErrnoException).code === 'ENOENT'
        return { available: false, reason: notFound ? 'claude was not found on PATH' : errorMessage(error) }
      }
    },

    async start(request, sink) {
      if (runs.get(request.actionableId)?.active) throw new Error(`Claude is already running for actionable ${request.actionableId}`)
      const run: Run = {
        request,
        sink,
        sessionId: request.resumeSessionId,
        abort: new AbortController(),
        close: () => {},
        active: false,
        questions: new Map(),
        done: Promise.resolve(),
      }
      runs.set(request.actionableId, run)
      run.done = execute(run, request.instructions)
    },

    async pause(actionableId) {
      const run = get(actionableId)
      if (!run.active) throw new Error(`Claude is not running for actionable ${actionableId}`)
      run.halt = 'paused'
      cancelQuestions(run)
      await run.query?.interrupt()
      run.close()
      await run.done
    },

    async resume(actionableId, feedback) {
      const run = get(actionableId)
      if (run.active) throw new Error(`Claude is already running for actionable ${actionableId}`)
      run.done = execute(run, feedback?.trim() || 'Continue.')
    },

    async stop(actionableId) {
      const run = get(actionableId)
      runs.delete(actionableId)
      run.halt = 'stopped'
      if (!run.active) return run.sink({ type: 'state', state: 'stopped' })
      cancelQuestions(run)
      run.abort.abort()
      run.close()
      await run.done
    },

    async answer(actionableId, questionId, text) {
      const resolve = get(actionableId).questions.get(questionId)
      if (!resolve) throw new Error(`No pending question ${questionId} for actionable ${actionableId}`)
      resolve(text)
    },

    async openInTerminal(_actionableId, worktreePath, sessionId) {
      const script = ['on run argv', 'tell application "Terminal"', 'activate', 'do script (item 1 of argv)', 'end tell', 'end run']
      await deps.exec('osascript', [...script.flatMap((line) => ['-e', line]), resumeCommand(worktreePath, sessionId)], { env: agentEnv() })
    },
  }
}
