import type { AgentEvent, AgentEventSink, AgentProvider, DispatchRequest, GantryPush, IngestSignal } from '@gantry/shared'
import { AgentRunner } from '../agents/runner'
import { openDb } from '../db'
import { createRepositoryStore, createSettingsStore, jsonTable } from '../db/stores'
import type { Exec } from '../system/exec'
import { Board } from './board'
import { Reports } from './reports'

export class FakeProvider implements AgentProvider {
  readonly id = 'claude'
  readonly displayName = 'Claude Code'
  readonly models = [{ id: 'sonnet', label: 'Sonnet' }]
  requests: DispatchRequest[] = []
  calls: string[] = []
  private sinks = new Map<string, AgentEventSink>()

  detect = async () => ({ available: true, version: '1.0.0' })
  async start(request: DispatchRequest, sink: AgentEventSink) {
    this.requests.push(request)
    this.sinks.set(request.actionableId, sink)
    this.sinks.set(request.dispatchId, sink)
  }
  async pause(id: string) {
    this.calls.push(`pause:${id}`)
    this.sinks.get(id)?.({ type: 'state', state: 'paused' })
  }
  async resume(id: string, feedback?: string) {
    this.calls.push(`resume:${id}:${feedback ?? ''}`)
    this.sinks.get(id)?.({ type: 'state', state: 'running' })
  }
  async stop(id: string) {
    this.calls.push(`stop:${id}`)
  }
  async answer(id: string, questionId: string, text: string) {
    this.calls.push(`answer:${id}:${questionId}:${text}`)
  }
  async openInTerminal(id: string, worktreePath: string, sessionId: string) {
    this.calls.push(`terminal:${id}:${worktreePath}:${sessionId}`)
  }
  emit(id: string, event: AgentEvent) {
    this.sinks.get(id)!(event)
  }
}

export const flush = () => new Promise((resolve) => setImmediate(resolve))

export function signal(over: Partial<IngestSignal> = {}): IngestSignal {
  return {
    trigger: 'github.ci_failed',
    source: { kind: 'github', name: 'GitHub' },
    externalKey: 'https://github.com/acme/api/pull/1',
    title: 'Fix CI',
    links: [{ label: 'PR #1', url: 'https://github.com/acme/api/pull/1' }],
    occurredAt: '2026-10-27T12:00:00.000Z',
    ...over,
  }
}

export function setup() {
  const db = openDb(':memory:')
  let now = new Date('2026-10-27T12:00:00.000Z')
  const settings = createSettingsStore(db)
  const repos = createRepositoryStore(db)
  const pushes: GantryPush[] = []
  const board = new Board({
    db,
    meta: jsonTable(db, 'meta'),
    settings: () => settings.get(),
    repositories: () => repos.list(),
    push: (p) => pushes.push(p),
    now: () => new Date(now),
  })
  const reports = new Reports({ db, push: (p) => pushes.push(p), now: () => new Date(now) })
  const provider = new FakeProvider()
  const worktrees = new Map<string, string>()
  const strays = new Set<string>()
  const execCalls: string[][] = []
  const execResults: Record<string, { code: number; output: string }> = {}
  const exec: Exec = async (file, args, cwd) => {
    const call = [file, ...args]
    execCalls.push(cwd ? [...call, `cwd=${cwd}`] : call)
    const key = Object.keys(execResults).find((k) => call.join(' ').includes(k))
    if (key) return execResults[key]!
    if (args.includes('rev-parse')) return { code: 1, output: '' }
    if (args[2] === 'worktree' && args[3] === 'add') worktrees.set(args[4]!, args[1]!)
    if (args[2] === 'worktree' && args[3] === 'remove') worktrees.delete(args.at(-1)!)
    if (args[2] === 'worktree' && args[3] === 'list')
      return { code: 0, output: [...worktrees].filter(([, repo]) => repo === args[1]).map(([path]) => `worktree ${path}\nHEAD abc\n`).join('\n') }
    return { code: 0, output: '' }
  }
  const runner = new AgentRunner({
    board,
    providers: new Map([[provider.id, provider]]),
    exec,
    exists: (path) => worktrees.has(path) || strays.has(path),
    settings: () => settings.get(),
    repositories: () => repos.list(),
    fetchContext: async () => 'PR diff summary',
    home: '/Users/me',
    now: () => new Date(now),
  })
  board.agents = runner
  settings.update({ confirmBeforeDispatch: false })
  const repo = repos.add({ path: '/code/api', remote: 'acme/api', defaultBranch: 'main' })
  return {
    db,
    board,
    runner,
    provider,
    settings,
    repos,
    repo,
    reports,
    pushes,
    worktrees,
    strays,
    execCalls,
    execResults,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    eventTypes: (actionableId?: string) =>
      board
        .events({ actionableId })
        .events.map((e) => e.type)
        .reverse(),
  }
}
