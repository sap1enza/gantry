import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  COMPLETION_INSTRUCTIONS,
  isAgentActive,
  TAGS,
  type Actionable,
  type AgentEvent,
  type AgentProvider,
  type AgentResult,
  type ColumnId,
  type Dispatch,
  type DispatchOverrides,
  type DispatchPreview,
  type Repository,
  type Settings,
} from '@gantry/shared'
import { hasLiveAgent, unique, without } from '@gantry/shared'
import { assertAction, type Actor, type AgentControl, type Board, type EventInput, GANTRY, USER } from '../domain/board'
import { findRepository, inferRepository } from '../domain/repositories'
import { type Exec, expandHome, shellCommand } from '../system/exec'

export interface RunnerDeps {
  board: Board
  providers: Map<string, AgentProvider>
  exec: Exec
  exists(path: string): boolean
  settings(): Settings
  repositories(): Repository[]
  fetchContext(a: Actionable): Promise<string | undefined>
  home?: string
  now?: () => Date
}

export function buildInstructions(a: Actionable, context?: string) {
  const parts = a.instructions
    ? [a.instructions]
    : [
        `# ${a.title}`,
        a.body,
        a.links.length ? `Links:\n${a.links.map((l) => `- ${l.label}: ${l.url}`).join('\n')}` : undefined,
        context ? `Context:\n${context}` : undefined,
      ]
  return [...parts, COMPLETION_INSTRUCTIONS].filter(Boolean).join('\n\n')
}

export const slugify = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '') || 'task'


const realPath = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const AGENT_UPDATE_INTERVAL_MS = 20_000
const FRESH_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class AgentRunner implements AgentControl {
  private updates = new Map<string, { at: number; text?: string; timer?: ReturnType<typeof setTimeout> }>()

  constructor(private deps: RunnerDeps) {}

  private get board() {
    return this.deps.board
  }

  private iso() {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  private provider(id: string) {
    const provider = this.deps.providers.get(id)
    if (!provider) throw new Error(`Agent provider "${id}" is unavailable`)
    return provider
  }

  private agentActor(a: Actionable): Actor {
    return { kind: 'agent', name: this.deps.providers.get(a.dispatch?.provider ?? '')?.displayName ?? a.dispatch?.provider ?? 'Agent' }
  }

  private git(repositoryPath: string, args: string[]) {
    return this.deps.exec('git', ['-C', repositoryPath, ...args])
  }

  private async ghAuthenticated() {
    return (await this.deps.exec('gh', ['auth', 'status'])).code === 0
  }

  async preview(id: string): Promise<DispatchPreview> {
    const a = this.board.must(id)
    const s = this.deps.settings()
    const repos = this.deps.repositories()
    const repo = inferRepository(a, repos)
    const provider = this.deps.providers.get(s.defaultProvider)
    const [context, fullPresetAvailable] = await Promise.all([this.deps.fetchContext(a).catch(() => undefined), this.ghAuthenticated()])
    return {
      instructions: buildInstructions(a, context),
      repository: repo?.remote,
      repositoryCandidates: repos.map((r) => r.remote),
      provider: s.defaultProvider,
      model: s.defaultModel ?? provider?.models[0]?.id,
      models: provider?.models ?? [],
      permissionPreset: s.defaultPermissionPreset,
      fullPresetAvailable,
      mustConfirm: s.confirmBeforeDispatch || !repo,
    }
  }

  async start(id: string, overrides: DispatchOverrides = {}, auto = false) {
    const a = this.board.must(id)
    assertAction(a, 'start')
    const s = this.deps.settings()
    const repos = this.deps.repositories()
    const repo = findRepository(repos, overrides.repository) ?? inferRepository(a, repos)
    if (!repo) throw new Error('Choose a repository before starting')
    const permissionPreset = overrides.permissionPreset ?? s.defaultPermissionPreset
    if (permissionPreset === 'full' && !(await this.ghAuthenticated())) throw new Error('The Full preset requires `gh auth login`')
    const provider = this.provider(s.defaultProvider)
    const instructions = overrides.instructions ?? buildInstructions(a, await this.deps.fetchContext(a).catch(() => undefined))
    const reuse = a.dispatch?.repository === repo.remote ? a.dispatch : undefined
    const slug = a.dispatch && !reuse ? `${a.displayId}-${slugify(repo.remote)}-${slugify(a.title)}` : `${a.displayId}-${slugify(a.title)}`
    const dispatch: Dispatch = {
      id: randomUUID(),
      provider: provider.id,
      model: overrides.model ?? s.defaultModel ?? provider.models[0]?.id,
      repository: repo.remote,
      repositoryPath: repo.path,
      worktreePath: reuse?.worktreePath ?? join(expandHome(s.workspaceLocation, this.deps.home ?? homedir()), slug),
      branch: reuse?.branch ?? `gantry/${slug}`,
      sessionId: a.agentState === 'paused' ? reuse?.sessionId : undefined,
      permissionPreset,
      instructions,
      startedAt: this.iso(),
      startedBy: auto ? 'api' : 'user',
      ...FRESH_USAGE,
    }
    this.enqueue(id, dispatch, { type: 'dispatched', detail: `${provider.displayName} · ${repo.remote}`, actor: auto ? GANTRY : USER })
  }

  private enqueue(id: string, dispatch: Dispatch, event: EventInput) {
    this.board.update(
      id,
      (a) => {
        a.column = 'in_progress'
        a.agentState = 'queued'
        a.dispatch = dispatch
        a.tags = unique([...without(a.tags, TAGS.stopped, TAGS.failed, TAGS.needsRepository), TAGS.queued])
        delete a.result
        delete a.error
        delete a.pendingQuestion
      },
      event,
    )
    this.drain()
  }

  private drain() {
    const cards = this.board.all()
    let active = cards.filter(isAgentActive).length
    const queued = cards
      .filter((c) => c.column === 'in_progress' && c.agentState === 'queued' && !c.snoozedUntil && !c.dismissedAt)
      .sort((x, y) => (x.dispatch?.startedAt ?? '').localeCompare(y.dispatch?.startedAt ?? ''))
    const max = this.deps.settings().maxConcurrentAgents
    for (const card of queued) {
      if (active >= max) break
      active++
      void this.launch(card.id)
    }
  }

  private async launch(id: string) {
    const a = this.board.update(id, (c) => {
      c.agentState = 'running'
      c.tags = without(c.tags, TAGS.queued)
    })
    const d = a.dispatch!
    try {
      await this.prepareWorktree(a, d)
      const current = this.board.get(id)
      if (current?.dispatch?.id !== d.id || current.agentState !== 'running') return
      await this.provider(d.provider).start(
        {
          actionableId: id,
          dispatchId: d.id,
          instructions: d.instructions,
          repository: d.repository,
          worktreePath: d.worktreePath,
          branch: d.branch,
          permissionPreset: d.permissionPreset,
          model: d.model,
          resumeSessionId: d.sessionId,
        },
        (event) => this.handle(id, d.id, event),
      )
    } catch (err) {
      this.handle(id, d.id, { type: 'error', message: message(err) })
    }
  }

  private async isRegisteredWorktree(d: Dispatch) {
    const list = await this.git(d.repositoryPath, ['worktree', 'list', '--porcelain'])
    const target = realPath(d.worktreePath)
    return list.code === 0 && list.output.split('\n').some((line) => line.startsWith('worktree ') && realPath(line.slice(9)) === target)
  }

  private async prepareWorktree(a: Actionable, d: Dispatch) {
    if (await this.isRegisteredWorktree(d)) return
    if (this.deps.exists(d.worktreePath))
      throw new Error(`${d.worktreePath} already exists but is not a worktree of ${d.repository}. Move it away or change the workspace location.`)
    await this.createWorktree(a, d)
  }

  private async createWorktree(a: Actionable, d: Dispatch) {
    const repo = this.deps.repositories().find((r) => r.path === d.repositoryPath)
    const branchExists = (await this.git(d.repositoryPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${d.branch}`])).code === 0
    const added = await this.git(
      d.repositoryPath,
      branchExists ? ['worktree', 'add', d.worktreePath, d.branch] : ['worktree', 'add', d.worktreePath, '-b', d.branch, repo?.defaultBranch ?? 'HEAD'],
    )
    if (added.code !== 0) throw new Error(`git worktree add failed: ${added.output.trim()}`)
    if (!repo?.setupCommand) return
    const setup = await this.deps.exec(...shellCommand(repo.setupCommand), d.worktreePath)
    this.board.appendTranscript(a.id, d.id, { type: 'tool', name: 'setup', summary: setup.output })
    if (setup.code === 0) return
    await this.removeWorktree(d, true)
    throw new Error(`Setup command exited with code ${setup.code}`)
  }

  handle(id: string, dispatchId: string, event: AgentEvent) {
    const card = this.board.get(id)
    if (card?.dispatch?.id !== dispatchId) return
    this.board.appendTranscript(id, dispatchId, event)
    const live = hasLiveAgent(card)
    switch (event.type) {
      case 'message':
        if (live) this.agentUpdate(id, event.text)
        break
      case 'session':
        this.board.update(id, (a) => (a.dispatch!.sessionId = event.sessionId))
        break
      case 'usage':
        this.board.update(id, (a) => {
          a.dispatch!.inputTokens += event.inputTokens
          a.dispatch!.outputTokens += event.outputTokens
          a.dispatch!.costUsd += event.costUsd
        })
        break
      case 'question':
        if (live)
          this.board.update(
            id,
            (a) => {
              a.agentState = 'awaiting_input'
              a.pendingQuestion = { id: event.id, prompt: event.prompt, options: event.options }
            },
            { type: 'awaiting_input', detail: event.prompt, actor: this.agentActor(card) },
          )
        break
      case 'state':
        if (!live) break
        if (event.state === 'completed') this.complete(id, this.agentActor(card))
        else if (event.state === 'failed') this.fail(id, this.agentActor(card), 'Agent reported failure')
        else if (event.state === 'paused' && card.agentState !== 'paused')
          this.board.update(id, (a) => (a.agentState = 'paused'), { type: 'paused', actor: this.agentActor(card) })
        else if (event.state === 'running' || event.state === 'paused' || event.state === 'awaiting_input')
          this.board.update(id, (a) => (a.agentState = event.state))
        break
      case 'result':
        if (live) this.complete(id, this.agentActor(card), event.result)
        break
      case 'error':
        if (live) this.fail(id, this.agentActor(card), event.message)
        break
    }
  }

  private agentUpdate(id: string, text: string) {
    const u = this.updates.get(id) ?? { at: 0 }
    this.updates.set(id, u)
    u.text = text
    const wait = u.at + AGENT_UPDATE_INTERVAL_MS - Date.now()
    if (wait <= 0) this.flushUpdate(id)
    else u.timer ??= setTimeout(() => this.flushUpdate(id), wait)
  }

  private flushUpdate(id: string) {
    const u = this.updates.get(id)
    if (!u) return
    clearTimeout(u.timer)
    this.updates.set(id, { at: Date.now() })
    const card = this.board.get(id)
    if (u.text && card) this.board.log({ type: 'agent_update', detail: u.text, actor: this.agentActor(card) }, card)
  }

  private finishUpdates(id: string) {
    this.flushUpdate(id)
    this.updates.delete(id)
  }

  private complete(id: string, actor: Actor, result?: AgentResult) {
    this.finishUpdates(id)
    this.board.update(
      id,
      (a) => {
        a.column = 'review'
        a.agentState = 'completed'
        delete a.pendingQuestion
        if (result) a.result = result
        if (result?.prUrl && !a.links.some((l) => l.url === result.prUrl)) a.links.push({ label: 'Pull request', url: result.prUrl })
      },
      { type: 'completed', detail: result?.summary, actor },
    )
    this.drain()
  }

  private fail(id: string, actor: Actor, error: string) {
    this.finishUpdates(id)
    this.board.update(
      id,
      (a) => {
        a.column = 'review'
        a.agentState = 'failed'
        a.error = error
        a.tags = unique([...without(a.tags, TAGS.queued), TAGS.failed])
        delete a.pendingQuestion
      },
      { type: 'failed', detail: error, actor },
    )
    this.drain()
  }

  async pause(id: string) {
    const a = this.board.must(id)
    assertAction(a, 'pause')
    this.board.update(id, (c) => (c.agentState = 'paused'), { type: 'paused', actor: USER })
    try {
      await this.provider(a.dispatch!.provider).pause(id)
    } catch (err) {
      this.board.update(id, (c) => (c.agentState = a.agentState))
      throw err
    }
    this.drain()
  }

  async resume(id: string, feedback?: string) {
    const a = this.board.must(id)
    assertAction(a, 'resume')
    if (this.board.all().filter(isAgentActive).length >= this.deps.settings().maxConcurrentAgents) {
      this.board.update(
        id,
        (c) => {
          c.agentState = 'queued'
          c.tags = unique([...c.tags, TAGS.queued])
          const note = feedback?.trim()
          if (c.dispatch!.sessionId) c.dispatch!.instructions = note || 'Continue.'
          else if (note) c.dispatch!.instructions += `\n\n${note}`
        },
        { type: 'resumed', detail: feedback, actor: USER },
      )
      return
    }
    await this.provider(a.dispatch!.provider).resume(id, feedback)
    this.board.update(id, (c) => (c.agentState = 'running'), { type: 'resumed', detail: feedback, actor: USER })
  }

  async stop(id: string, detail?: string) {
    const a = this.board.must(id)
    assertAction(a, 'stop')
    if (a.agentState !== 'queued' && a.dispatch)
      await this.deps.providers
        .get(a.dispatch.provider)
        ?.stop(id)
        .catch((err) => console.error('provider stop failed', err))
    this.markStopped(id, detail, USER)
    this.drain()
  }

  private markStopped(id: string, detail: string | undefined, actor: Actor) {
    this.finishUpdates(id)
    this.board.update(
      id,
      (c) => {
        c.column = 'todo'
        c.agentState = 'stopped'
        c.tags = unique([...without(c.tags, TAGS.queued), TAGS.stopped])
        delete c.pendingQuestion
      },
      { type: 'stopped', detail, actor },
    )
  }

  async answer(id: string, questionId: string, text: string) {
    const a = this.board.must(id)
    if (a.agentState !== 'awaiting_input' || a.pendingQuestion?.id !== questionId) throw new Error(`${a.displayId} is not waiting for that answer`)
    await this.provider(a.dispatch!.provider).answer(id, questionId, text)
    this.board.update(
      id,
      (c) => {
        c.agentState = 'running'
        delete c.pendingQuestion
      },
      { type: 'answered', detail: text, actor: USER },
    )
  }

  async reopen(id: string, feedback?: string) {
    const a = this.board.must(id)
    if (a.column === 'done') return void this.board.reopenToTodo(id, feedback)
    assertAction(a, 'reopen')
    const previous = a.dispatch
    if (!previous) throw new Error(`${a.displayId} has no dispatch to reopen`)
    const dispatch: Dispatch = {
      ...previous,
      id: randomUUID(),
      instructions: previous.sessionId ? feedback?.trim() || 'Continue working on this task.' : previous.instructions,
      startedAt: this.iso(),
      startedBy: 'user',
      ...FRESH_USAGE,
    }
    this.enqueue(id, dispatch, { type: 'reopened', detail: feedback, actor: USER })
  }

  async done(id: string, cleanup?: 'delete' | 'keep') {
    const a = this.board.must(id)
    if (a.column === 'done') throw new Error(`${a.displayId} is already done`)
    this.board.assertMove(a, 'done')
    const choice = cleanup ?? (this.deps.settings().workspaceCleanup === 'delete' ? 'delete' : 'keep')
    let detail = 'Workspace kept'
    if (choice === 'delete' && a.dispatch && this.deps.exists(a.dispatch.worktreePath)) {
      const removed = await this.removeWorktree(a.dispatch)
      detail = removed.code === 0 ? 'Workspace removed' : `Workspace not removed: ${removed.output.trim()}`
    }
    this.board.markDone(id, detail)
  }

  async move(id: string, column: ColumnId, position: number) {
    const a = this.board.must(id)
    if (column === 'done' && a.column !== 'done') await this.done(id)
    else {
      this.board.assertMove(a, column)
      if (a.column === 'in_progress' && column !== 'in_progress') await this.release(a)
    }
    this.board.move(id, column, position)
  }

  private async release(a: Actionable) {
    if (a.agentState !== 'paused' || !a.dispatch) return
    await this.deps.providers
      .get(a.dispatch.provider)
      ?.stop(a.id)
      .catch((err) => console.error('provider stop failed', err))
  }

  private removeWorktree(d: Pick<Dispatch, 'repositoryPath' | 'worktreePath'>, force = false) {
    return this.git(d.repositoryPath, ['worktree', 'remove', ...(force ? ['--force'] : []), d.worktreePath])
  }

  async openInTerminal(id: string) {
    const a = this.board.must(id)
    assertAction(a, 'open_terminal')
    await this.provider(a.dispatch!.provider).openInTerminal(id, a.dispatch!.worktreePath, a.dispatch!.sessionId!)
  }

  recover() {
    for (const a of this.board.all())
      if (a.column === 'in_progress' && a.agentState !== 'queued' && a.agentState !== 'stopped') this.markStopped(a.id, 'Gantry restarted', GANTRY)
    this.drain()
  }

  async stopAll() {
    for (const a of this.board.all())
      if (hasLiveAgent(a)) await this.stop(a.id, 'Deleting all data')
  }

  async removeAllWorktrees() {
    for (const w of this.board.recordedWorktrees()) if (this.deps.exists(w.worktreePath)) await this.removeWorktree(w, true)
  }
}
