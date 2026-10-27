import type { Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, DispatchRequest, PermissionPreset } from '@gantry/shared'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeProvider, findClaude, resumeCommand, shellQuote, type ClaudeDeps } from './index'

const SESSION = 'b7e4c1d2-5a3f-4e8b-9c0d-1e2f3a4b5c6d'
const init = { type: 'system', subtype: 'init', session_id: SESSION } as SDKMessage
const result = (subtype: string, text = '') =>
  ({
    type: 'result',
    subtype,
    result: text,
    errors: [],
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    session_id: SESSION,
  }) as unknown as SDKMessage

interface Turn {
  options: Options
  prompt: Promise<string>
  interrupted: Promise<void>
}

function setup(script: (turn: Turn) => AsyncGenerator<SDKMessage>, preset: PermissionPreset = 'edit_test') {
  const events: AgentEvent[] = []
  const turns: Turn[] = []
  const query = vi.fn(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    let interrupt!: () => void
    const turn: Turn = {
      options,
      prompt: prompt[Symbol.asyncIterator]().next().then((next) => next.value.message.content as string),
      interrupted: new Promise((resolve) => (interrupt = resolve)),
    }
    turns.push(turn)
    return Object.assign(script(turn), { interrupt: async () => interrupt() }) as unknown as Query
  })
  const exec = vi.fn<ClaudeDeps['exec']>(async () => ({ stdout: '2.9.4 (Claude Code)\n' }))
  const provider = createClaudeProvider({ query: query as unknown as ClaudeDeps['query'], exec })
  const request: DispatchRequest = {
    actionableId: 'card-1',
    dispatchId: 'dispatch-1',
    instructions: 'Fix CI',
    repository: 'o/r',
    worktreePath: '/tmp/wt',
    branch: 'gantry/GT-1-fix',
    permissionPreset: preset,
  }
  const start = () => provider.start(request, (event) => events.push(event))
  const states = () => events.flatMap((event) => (event.type === 'state' ? [event.state] : []))
  const question = () => vi.waitFor(() => events.findLast((event) => event.type === 'question') ?? Promise.reject())
  return { provider, events, turns, exec, start, states, question }
}

const ask = (turn: Turn, tool: string, input: Record<string, unknown>) =>
  turn.options.canUseTool!(tool, input, { signal: new AbortController().signal } as never) as Promise<PermissionResult>

describe('claude provider', () => {
  it('runs a turn to completion and reports the parsed result', async () => {
    const { start, events, states, turns } = setup(async function* () {
      yield init
      yield result('success', 'Done.')
    })
    await start()
    await vi.waitFor(() => expect(states()).toEqual(['running', 'completed']))
    expect(await turns[0]!.prompt).toBe('Fix CI')
    expect(turns[0]!.options).toMatchObject({ cwd: '/tmp/wt', permissionMode: 'acceptEdits', resume: undefined })
    expect(events).toContainEqual({ type: 'session', sessionId: SESSION })
    expect(events).toContainEqual({ type: 'result', result: { summary: 'Done.', filesChanged: [], openQuestions: [] } })
  })

  it('fails when the query throws', async () => {
    const { start, events, states } = setup(async function* () {
      throw new Error('auth expired')
    })
    await start()
    await vi.waitFor(() => expect(states()).toEqual(['running', 'failed']))
    expect(events).toContainEqual({ type: 'error', message: 'auth expired' })
  })

  it('round-trips AskUserQuestion through question and answer', async () => {
    let decision: PermissionResult | undefined
    const { provider, start, states, question } = setup(async function* (turn) {
      yield init
      decision = await ask(turn, 'AskUserQuestion', {
        questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'sqlite' }, { label: 'pg' }] }],
      })
      yield result('success')
    })
    await start()
    const asked = await question()
    expect(asked).toMatchObject({ prompt: 'Which DB?', options: ['sqlite', 'pg'] })
    expect(states()).toEqual(['running', 'awaiting_input'])
    await provider.answer('card-1', (asked as { id: string }).id, 'sqlite')
    await vi.waitFor(() => expect(states()).toEqual(['running', 'awaiting_input', 'running', 'completed']))
    expect(decision).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which DB?': 'sqlite' } } })
  })

  it('asks for permission outside the preset and reports a denial to the agent', async () => {
    let decision: PermissionResult | undefined
    const { provider, start, question } = setup(async function* (turn) {
      decision = await ask(turn, 'Bash', { command: 'gh pr merge 3' })
      yield result('success')
    }, 'full')
    await start()
    const asked = (await question()) as { id: string; options: string[] }
    expect(asked.options).toEqual(['Allow', 'Deny'])
    await provider.answer('card-1', asked.id, 'not yet')
    await vi.waitFor(() => expect(decision).toEqual({ behavior: 'deny', message: 'The user denied this: not yet' }))
  })

  it('denies preset violations without asking', async () => {
    let decision: PermissionResult | undefined
    const { start, events } = setup(async function* (turn) {
      decision = await ask(turn, 'Bash', { command: 'git push' })
      yield result('success')
    })
    await start()
    await vi.waitFor(() => expect(decision?.behavior).toBe('deny'))
    expect(events.some((event) => event.type === 'question')).toBe(false)
  })

  it('pauses by interrupting and resumes the same session with feedback', async () => {
    const { provider, start, events, states, turns } = setup(async function* (turn) {
      yield init
      await turn.interrupted
      yield result('error_during_execution')
    })
    await start()
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'session', sessionId: SESSION }))
    await provider.pause('card-1')
    expect(states()).toEqual(['running', 'paused'])
    expect(events.some((event) => event.type === 'error')).toBe(false)

    await provider.resume('card-1', 'Use sqlite')
    expect(turns[1]!.options.resume).toBe(SESSION)
    expect(await turns[1]!.prompt).toBe('Use sqlite')
    await provider.pause('card-1')
    await provider.resume('card-1')
    expect(await turns[2]!.prompt).toBe('Continue.')
  })

  it('cancels a pending question when paused', async () => {
    let decision: PermissionResult | undefined
    const { provider, start, question, states } = setup(async function* (turn) {
      decision = await ask(turn, 'mcp__linear__create_issue', {})
      await turn.interrupted
    })
    await start()
    await question()
    await provider.pause('card-1')
    expect(decision).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(states().at(-1)).toBe('paused')
  })

  it('stops by aborting and forgets the run', async () => {
    const { provider, start, events, states } = setup(async function* (turn) {
      yield init
      await new Promise((resolve) => turn.options.abortController!.signal.addEventListener('abort', resolve))
      throw new Error('aborted')
    })
    await start()
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'session', sessionId: SESSION }))
    await provider.stop('card-1')
    expect(states()).toEqual(['running', 'stopped'])
    expect(events.some((event) => event.type === 'error')).toBe(false)
    await expect(provider.resume('card-1')).rejects.toThrow(/No Claude run/)
  })

  it('stops a paused run without a live query', async () => {
    const { provider, start, states } = setup(async function* (turn) {
      await turn.interrupted
    })
    await start()
    await provider.pause('card-1')
    await provider.stop('card-1')
    expect(states()).toEqual(['running', 'paused', 'stopped'])
  })

  it('rejects calls on unknown ids, idle runs and unknown questions', async () => {
    const { provider, start, states } = setup(async function* () {
      yield result('success')
    })
    await expect(provider.pause('nope')).rejects.toThrow('No Claude run for actionable nope')
    await expect(provider.answer('nope', 'q', 'x')).rejects.toThrow(/No Claude run/)
    await start()
    await vi.waitFor(() => expect(states()).toEqual(['running', 'completed']))
    await expect(provider.pause('card-1')).rejects.toThrow(/not running/)
    await expect(provider.answer('card-1', 'q', 'x')).rejects.toThrow(/No pending question q/)
  })

  it('detects the claude CLI version or reports why it is missing', async () => {
    const { provider, exec } = setup(async function* () {})
    expect(await provider.detect()).toEqual({ available: true, version: '2.9.4 (Claude Code)' })
    expect(exec.mock.calls[0]![2].env.PATH).toMatch(/\.local\/bin.*\/opt\/homebrew\/bin/)
    exec.mockRejectedValueOnce(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
    expect(await provider.detect()).toEqual({ available: false, reason: 'claude was not found on PATH' })
  })

  it('opens Terminal.app with the quoted resume command as an argument', async () => {
    const { provider, exec } = setup(async function* () {})
    await provider.openInTerminal('card-1', '/tmp/my "wt"', SESSION)
    const [file, args] = exec.mock.calls[0]!
    expect(file).toBe('osascript')
    expect(args.at(-1)).toBe(resumeCommand('/tmp/my "wt"', SESSION))
  })
})

describe('shellQuote', () => {
  it.each([['/Users/me/my repo'], [`/tmp/it's "here" $HOME \`x\``], ['']])('round-trips %s through sh', (value) => {
    expect(execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' })).toBe(value)
  })

  it('builds the resume command', () => {
    expect(resumeCommand("/a b/c'd", 'abc')).toBe(`cd '/a b/c'\\''d' && claude --resume 'abc'`)
  })
})

describe('findClaude', () => {
  it('returns the first executable claude on the path and skips non-executables', () => {
    const plain = mkdtempSync(join(tmpdir(), 'claude-'))
    const exec = mkdtempSync(join(tmpdir(), 'claude-'))
    writeFileSync(join(plain, 'claude'), '', { mode: 0o644 })
    writeFileSync(join(exec, 'claude'), '', { mode: 0o755 })
    expect(findClaude(`${plain}:${exec}`)).toBe(join(exec, 'claude'))
    expect(findClaude(plain)).toBeUndefined()
  })
})
