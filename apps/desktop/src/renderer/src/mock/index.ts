import {
  TAGS,
  canMove,
  isAgentActive,
  isCustomColumn,
  type Actionable,
  type ActivityEvent,
  type ActivityQuery,
  type AgentEvent,
  type BoardFilter,
  type BoardSnapshot,
  type ColumnId,
  type GantryApi,
  type GantryBridge,
  type GantryPush,
  type TranscriptEntry,
} from '@gantry/shared'
import { emptyState, seededState, type MockState } from './seed'

const IN_PROGRESS_ORDER = ['awaiting_input', 'running', 'queued', 'paused']
const SOURCE_LABEL = { github: 'GitHub', slack: 'Slack', email: 'Email', api: 'API', manual: 'Manual' } as const

const AGENT_SCRIPT: AgentEvent[] = [
  { type: 'message', text: 'Created isolated workspace' },
  { type: 'tool', name: 'Read', summary: 'Reading related source files' },
  { type: 'tool', name: 'Edit', summary: 'Applying fix' },
  { type: 'tool', name: 'Bash', summary: 'Running tests' },
  { type: 'usage', inputTokens: 120_000, outputTokens: 6_000, costUsd: 0.31 },
]

export interface MockOptions {
  empty?: boolean
  agentStepMs?: number
  now?: () => Date
}

export function createMockBridge(opts: MockOptions = {}): GantryBridge & { state: MockState } {
  const now = opts.now ?? (() => new Date())
  const stepMs = opts.agentStepMs ?? 2500
  let state = opts.empty ? emptyState() : seededState(now())
  const listeners = new Set<(p: GantryPush) => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const steps = new Map<string, number>()
  const transcripts = new Map<string, TranscriptEntry[]>()

  const emit = (p: GantryPush) => listeners.forEach((l) => l(p))
  const find = (id: string) => {
    const a = state.actionables.find((x) => x.id === id)
    if (!a) throw new Error(`Actionable ${id} not found`)
    return a
  }
  const touch = (a: Actionable) => {
    a.updatedAt = now().toISOString()
    emit({ type: 'board.changed' })
  }
  const log = (type: ActivityEvent['type'], a: Actionable | undefined, title: string, extra: Partial<ActivityEvent> = {}) => {
    const event: ActivityEvent = {
      id: crypto.randomUUID(),
      type,
      actionableId: a?.id,
      actionableDisplayId: a?.displayId,
      source: a ? a.source.name : 'Gantry',
      actor: { kind: 'user', name: state.account.name || 'You' },
      title,
      createdAt: now().toISOString(),
      ...extra,
    }
    state.events.unshift(event)
    emit({ type: 'activity.appended', event })
  }
  const agentEvent = (a: Actionable, event: AgentEvent) => {
    const list = transcripts.get(a.id) ?? []
    list.push({ at: now().toISOString(), event })
    transcripts.set(a.id, list)
    emit({ type: 'agent.event', actionableId: a.id, event })
  }
  const halt = (id: string) => {
    clearTimeout(timers.get(id))
    timers.delete(id)
  }
  const removeTag = (a: Actionable, tag: string) => (a.tags = a.tags.filter((t) => t !== tag))
  const topOf = (column: ColumnId) => {
    for (const x of state.actionables) if (x.column === column) x.position++
    return 0
  }
  const runningCount = () => state.actionables.filter((x) => x.agentState === 'running' && !x.dismissedAt).length

  const step = (id: string) => {
    const a = state.actionables.find((x) => x.id === id)
    if (!a || a.agentState !== 'running') return
    const i = steps.get(id) ?? 0
    const ev = AGENT_SCRIPT[i]
    if (ev) {
      agentEvent(a, ev)
      if (ev.type === 'usage') {
        if (a.dispatch) a.dispatch.costUsd += ev.costUsd
      } else log('agent_update', a, ev.type === 'message' ? ev.text : ev.type === 'tool' ? ev.summary : ev.type, { source: 'Claude Code', actor: { kind: 'agent', name: 'Agent' }, detail: a.dispatch?.worktreePath })
      steps.set(id, i + 1)
      timers.set(id, setTimeout(() => step(id), stepMs))
      touch(a)
      return
    }
    steps.delete(id)
    timers.delete(id)
    a.column = 'review'
    a.position = topOf('review')
    a.agentState = 'completed'
    a.result = {
      summary: `Implemented a fix for “${a.title}” and added a regression test.`,
      filesChanged: ['src/index.ts', 'src/index.test.ts'],
      branch: a.dispatch?.branch,
      testsRun: 'pnpm test — all passed',
      openQuestions: [],
    }
    agentEvent(a, { type: 'result', result: a.result })
    log('completed', a, `Agent completed ${a.displayId}`, { source: 'Claude Code', actor: { kind: 'agent', name: 'Agent' }, detail: a.result.summary })
    touch(a)
    startQueued()
  }
  const run = (a: Actionable) => {
    halt(a.id)
    timers.set(a.id, setTimeout(() => step(a.id), stepMs))
  }
  const startQueued = () => {
    const next = state.actionables.find((x) => x.agentState === 'queued' && !x.dismissedAt)
    if (!next || runningCount() >= state.settings.maxConcurrentAgents) return
    next.agentState = 'running'
    removeTag(next, TAGS.queued)
    run(next)
    touch(next)
  }

  const visible = (a: Actionable, f: BoardFilter) => {
    if (a.dismissedAt && !f.showDismissed) return false
    if (a.archivedAt && !f.showArchived) return false
    if (a.snoozedUntil && new Date(a.snoozedUntil) > now() && !f.showSnoozed) return false
    if (f.sources?.length && !f.sources.includes(a.source.kind)) return false
    if (f.providers?.length && !f.providers.includes(a.dispatch?.provider ?? '')) return false
    return true
  }
  const sorted = (list: Actionable[]) =>
    [...list].sort((x, y) => {
      if (x.column !== y.column) return 0
      if (x.column === 'in_progress') {
        const d = IN_PROGRESS_ORDER.indexOf(x.agentState ?? '') - IN_PROGRESS_ORDER.indexOf(y.agentState ?? '')
        return d || (x.dispatch?.startedAt ?? '').localeCompare(y.dispatch?.startedAt ?? '')
      }
      return x.position - y.position
    })
  const isToday = (iso: string) => new Date(iso).toDateString() === now().toDateString()
  const matches = (e: ActivityEvent, q: ActivityQuery) => {
    if (q.types?.length && !q.types.includes(e.type)) return false
    if (q.sources?.length && !q.sources.includes(e.source)) return false
    if (q.actionableId && e.actionableId !== q.actionableId) return false
    if (q.since && e.createdAt < q.since) return false
    if (q.until && e.createdAt > q.until) return false
    if (q.text) {
      const t = q.text.toLowerCase()
      if (![e.title, e.detail, e.actionableDisplayId, e.source].some((v) => v?.toLowerCase().includes(t))) return false
    }
    return true
  }
  const nextDisplayId = () => `GT-${Math.max(100, ...state.actionables.map((a) => Number(a.displayId.slice(3)))) + 1}`

  const board: GantryApi['board'] = {
    async snapshot(filter = {}) {
      const actionables = sorted(state.actionables.filter((a) => visible(a, filter)))
      const live = state.actionables.filter((a) => !a.dismissedAt && !a.archivedAt)
      return {
        columns: [...state.columns].sort((x, y) => x.position - y.position),
        actionables,
        stats: {
          total: live.filter((a) => visible(a, {})).length,
          running: live.filter((a) => a.agentState === 'running').length,
          paused: live.filter((a) => a.agentState === 'paused').length,
          awaitingInput: live.filter((a) => a.agentState === 'awaiting_input').length,
          completedToday: state.events.filter((e) => e.type === 'completed' && isToday(e.createdAt)).length,
          costTodayUsd: state.actionables.reduce((s, a) => s + (a.dispatch && isToday(a.dispatch.startedAt) ? a.dispatch.costUsd : 0), 0),
        },
      } satisfies BoardSnapshot
    },
    async get(id) {
      return structuredClone(state.actionables.find((a) => a.id === id))
    },
    async search(query) {
      const q = query.toLowerCase().trim()
      if (!q) return []
      return state.actionables.filter((a) => [a.title, a.body, a.source.name, a.displayId].some((v) => v?.toLowerCase().includes(q))).slice(0, 20)
    },
    async create(input) {
      const a: Actionable = {
        id: crypto.randomUUID(),
        displayId: nextDisplayId(),
        title: input.title,
        body: input.body,
        source: { kind: 'manual', name: input.sourceName || 'Manual' },
        triggers: ['manual'],
        links: input.links ?? [],
        repository: input.repository,
        priority: input.priority,
        tags: [],
        metadata: {},
        column: 'todo',
        position: topOf('todo'),
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      }
      state.actionables.push(a)
      log('received', a, `Created “${a.title}” manually`, { outcome: 'created', source: 'Manual' })
      touch(a)
      return a
    },
    async move(id, column, position) {
      const a = find(id)
      if (!canMove(a, column)) throw new Error(`Cannot move ${a.displayId} to ${column}`)
      const from = a.column
      const siblings = state.actionables.filter((x) => x.column === column && x.id !== id).sort((x, y) => x.position - y.position)
      siblings.splice(Math.max(0, Math.min(position, siblings.length)), 0, a)
      siblings.forEach((x, i) => (x.position = i))
      a.column = column
      if (from !== column) {
        if (column === 'done') a.doneAt = now().toISOString()
        if (from === 'done') a.doneAt = undefined
        log('moved', a, `Moved ${a.displayId} to ${state.columns.find((c) => c.id === column)?.name ?? column}`)
      }
      touch(a)
    },
    async dispatchPreview(id) {
      const a = find(id)
      const registered = state.repos.map((r) => r.remote)
      const repository = a.repository && registered.includes(a.repository) ? a.repository : undefined
      return {
        instructions:
          a.instructions ??
          [a.title, a.body, a.links.length ? `Links:\n${a.links.map((l) => `- ${l.label}: ${l.url}`).join('\n')}` : ''].filter(Boolean).join('\n\n'),
        repository,
        repositoryCandidates: registered,
        provider: state.settings.defaultProvider,
        model: state.settings.defaultModel ?? 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
          { id: 'haiku', label: 'Haiku' },
        ],
        permissionPreset: state.settings.defaultPermissionPreset,
        fullPresetAvailable: state.ghAuthenticated,
        mustConfirm: state.settings.confirmBeforeDispatch || !repository,
      }
    },
    async start(id, o = {}) {
      const a = find(id)
      if (a.column !== 'todo' && !isCustomColumn(a.column)) throw new Error('Cannot start from this column')
      const preview = await board.dispatchPreview(id)
      const repository = o.repository ?? preview.repository
      if (!repository) throw new Error('Choose a repository')
      const slug = `${a.displayId.toLowerCase()}-${a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24).replace(/-$/, '')}`
      a.dispatch ??= {
        id: crypto.randomUUID(),
        provider: preview.provider,
        model: o.model ?? preview.model,
        repository,
        repositoryPath: state.repos.find((r) => r.remote === repository)?.path ?? '',
        worktreePath: `${state.settings.workspaceLocation}/${slug}`,
        branch: `gantry/${slug}`,
        permissionPreset: o.permissionPreset ?? preview.permissionPreset,
        instructions: o.instructions ?? preview.instructions,
        startedAt: now().toISOString(),
        startedBy: state.account.name,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      }
      a.dispatch.startedAt = now().toISOString()
      a.dispatch.sessionId ??= crypto.randomUUID()
      a.column = 'in_progress'
      removeTag(a, TAGS.stopped)
      if (runningCount() >= state.settings.maxConcurrentAgents) {
        a.agentState = 'queued'
        a.tags.push(TAGS.queued)
      } else {
        a.agentState = 'running'
        run(a)
      }
      log('dispatched', a, a.title, { detail: `Claude Code · ${repository} · ${a.dispatch.worktreePath}` })
      touch(a)
    },
    async pause(id) {
      const a = find(id)
      if (!isAgentActive(a)) throw new Error('Agent is not running')
      halt(id)
      a.agentState = 'paused'
      log('paused', a, `Paused ${a.displayId}`, { source: 'Claude Code' })
      touch(a)
      startQueued()
    },
    async resume(id, feedback) {
      const a = find(id)
      a.agentState = 'running'
      if (feedback) agentEvent(a, { type: 'message', text: `Feedback: ${feedback}` })
      log('resumed', a, `Resumed ${a.displayId}`, { source: 'Claude Code', detail: feedback })
      run(a)
      touch(a)
    },
    async stop(id) {
      const a = find(id)
      halt(id)
      a.column = 'todo'
      a.position = topOf('todo')
      a.agentState = 'stopped'
      a.pendingQuestion = undefined
      removeTag(a, TAGS.queued)
      if (!a.tags.includes(TAGS.stopped)) a.tags.push(TAGS.stopped)
      log('stopped', a, `Stopped ${a.displayId}`, { source: 'Claude Code', detail: 'workspace kept' })
      touch(a)
      startQueued()
    },
    async answer(id, questionId, text) {
      const a = find(id)
      if (a.pendingQuestion?.id !== questionId) throw new Error('Question is no longer pending')
      a.pendingQuestion = undefined
      agentEvent(a, { type: 'message', text: `Answer: ${text}` })
      log('answered', a, `Answered: ${text}`)
      a.agentState = 'running'
      run(a)
      touch(a)
    },
    async dismiss(id) {
      const a = find(id)
      halt(id)
      if (a.column === 'in_progress') a.agentState = 'stopped'
      a.dismissedAt = now().toISOString()
      log('dismissed', a, `Dismissed ${a.title}`)
      touch(a)
      startQueued()
    },
    async snooze(id, until) {
      const a = find(id)
      if (isAgentActive(a)) throw new Error('Pause or stop the agent before snoozing')
      a.snoozedUntil = until
      log('snoozed', a, `Snoozed until ${new Date(until).toLocaleString()}`)
      touch(a)
    },
    async done(id, cleanup) {
      const a = find(id)
      a.column = 'done'
      a.position = topOf('done')
      a.doneAt = now().toISOString()
      log('done', a, `Marked ${a.displayId} done`, { detail: cleanup === 'keep' ? 'workspace kept' : 'workspace deleted' })
      touch(a)
    },
    async reopen(id, feedback) {
      const a = find(id)
      a.column = 'in_progress'
      a.agentState = 'running'
      a.result = undefined
      log('reopened', a, `Reopened ${a.displayId}`, { detail: feedback })
      if (feedback) agentEvent(a, { type: 'message', text: `Feedback: ${feedback}` })
      run(a)
      touch(a)
    },
    async openInTerminal() {},
    async openLink(url) {
      window.open(url, '_blank', 'noopener')
    },
    async transcript(id) {
      return transcripts.get(id) ?? []
    },
  }

  const reposition = () =>
    [...state.columns].sort((x, y) => x.position - y.position).forEach((c, i) => (c.position = i))

  const api: GantryApi = {
    board,
    columns: {
      async create(name, position) {
        const column = { id: `col_${crypto.randomUUID().slice(0, 8)}`, name, kind: 'custom' as const, position: position - 0.5 }
        state.columns.push(column)
        reposition()
        emit({ type: 'board.changed' })
        return column
      },
      async rename(id, name) {
        const c = state.columns.find((x) => x.id === id)
        if (!c || c.kind === 'fixed') throw new Error('Fixed columns cannot be renamed')
        c.name = name
        emit({ type: 'board.changed' })
      },
      async remove(id) {
        const c = state.columns.find((x) => x.id === id)
        if (!c || c.kind === 'fixed') throw new Error('Fixed columns cannot be removed')
        state.columns = state.columns.filter((x) => x.id !== id)
        for (const a of state.actionables) if (a.column === id) a.column = 'todo'
        reposition()
        emit({ type: 'board.changed' })
      },
      async move(id, position) {
        const c = state.columns.find((x) => x.id === id)
        if (!c || c.kind === 'fixed') throw new Error('Fixed columns cannot be reordered')
        const rest = [...state.columns].filter((x) => x.id !== id).sort((x, y) => x.position - y.position)
        rest.splice(Math.max(0, Math.min(position, rest.length)), 0, c)
        rest.forEach((x, i) => (x.position = i))
        emit({ type: 'board.changed' })
      },
    },
    activity: {
      async list(q) {
        const all = state.events.filter((e) => matches(e, q)).sort((x, y) => y.createdAt.localeCompare(x.createdAt))
        const offset = Number(q.cursor ?? 0)
        const limit = q.limit ?? 50
        return {
          events: all.slice(offset, offset + limit),
          nextCursor: offset + limit < all.length ? String(offset + limit) : undefined,
          totalToday: state.events.filter((e) => isToday(e.createdAt)).length,
        }
      },
      async export(format) {
        return `~/Downloads/gantry-activity.${format}`
      },
    },
    connections: {
      async list() {
        return structuredClone(state.connections)
      },
      async connect(provider) {
        const c = state.connections.find((x) => x.provider === provider)!
        c.status = 'connected'
        c.account ??= { login: provider === 'google' ? 'alex@acme.dev' : 'alexlee', team: provider === 'github' ? 'acme organization' : 'Acme workspace' }
        c.lastSyncAt = now().toISOString()
        c.detail = undefined
        log('connection', undefined, `${provider === 'google' ? 'Email' : SOURCE_LABEL[provider]} connected`, { source: SOURCE_LABEL[provider === 'google' ? 'email' : provider], actor: { kind: 'gantry', name: 'Gantry' } })
        emit({ type: 'connections.changed' })
      },
      async disconnect(provider) {
        const c = state.connections.find((x) => x.provider === provider)!
        c.status = 'disconnected'
        const kind = provider === 'google' ? 'email' : provider
        for (const a of state.actionables) if (a.source.kind === kind && !a.tags.includes(TAGS.sourceDisconnected)) a.tags.push(TAGS.sourceDisconnected)
        log('connection', undefined, `${SOURCE_LABEL[kind]} disconnected`, { source: SOURCE_LABEL[kind], actor: { kind: 'gantry', name: 'Gantry' } })
        emit({ type: 'connections.changed' })
        emit({ type: 'board.changed' })
      },
      async manageAccess() {},
      async syncNow() {
        for (const c of state.connections) if (c.status === 'connected') c.lastSyncAt = now().toISOString()
        emit({ type: 'connections.changed' })
      },
      async githubRepositories() {
        return structuredClone(state.githubRepos)
      },
      async apiTokens() {
        return structuredClone(state.tokens)
      },
      async createApiToken(name) {
        const secret = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, '0')).join('')
        const token = { id: crypto.randomUUID(), name, prefix: 'gtry_', lastFour: secret.slice(-4), createdAt: now().toISOString() }
        state.tokens.push(token)
        return { ...token, token: `gtry_${secret}` }
      },
      async revokeApiToken(id) {
        const t = state.tokens.find((x) => x.id === id)
        if (t) t.revokedAt = now().toISOString()
      },
      async sendTestActionable() {
        const a = await board.create({ title: 'Test actionable from the API', body: 'Sent from **Connections › Send test actionable**.', sourceName: 'API test' })
        a.source = { kind: 'api', name: 'API test' }
        a.triggers = ['api.custom']
        emit({ type: 'board.changed' })
      },
      async endpoint() {
        return `${state.settings.workerUrl}/v1/actionables`
      },
    },
    settings: {
      async get() {
        return structuredClone(state.settings)
      },
      async update(patch) {
        state.settings = { ...state.settings, ...structuredClone(patch) }
        emit({ type: 'settings.changed' })
        return structuredClone(state.settings)
      },
      async setTrigger(trigger, enabled) {
        state.settings.triggers[trigger] = enabled
        emit({ type: 'settings.changed' })
      },
      async setLlmKey(key) {
        state.llmKey = key.length > 0
      },
      async hasLlmKey() {
        return state.llmKey
      },
      async chooseWorkspaceLocation() {
        return '~/Code/Gantry'
      },
    },
    repos: {
      async list() {
        return structuredClone(state.repos)
      },
      async add() {
        const names = ['dashboard', 'infra', 'mobile', 'docs']
        const name = names.find((n) => !state.repos.some((r) => r.remote === `acme/${n}`))
        if (!name) return undefined
        const repo = { id: crypto.randomUUID(), path: `~/Code/${name}`, remote: `acme/${name}`, defaultBranch: 'main' }
        state.repos.push(repo)
        return repo
      },
      async update(id, patch) {
        Object.assign(state.repos.find((r) => r.id === id) ?? {}, patch)
      },
      async remove(id) {
        state.repos = state.repos.filter((r) => r.id !== id)
      },
    },
    account: {
      async get() {
        return structuredClone(state.account)
      },
      async setName(name) {
        state.account.name = name
      },
      async signIn(method, email) {
        state.account.signedIn = true
        if (method === 'github') state.account.githubLogin = 'alexlee'
        else state.account.email = email
      },
      async completeAuth() {
        state.account.signedIn = true
      },
      async signOut() {
        state.account.signedIn = false
        state.account.githubLogin = undefined
        state.account.email = undefined
      },
      async completeOnboarding() {
        state.account.onboarded = true
      },
    },
    system: {
      async checks() {
        return {
          claude: state.claudeAvailable ? { available: true, version: '3.4.1' } : { available: false, reason: 'claude not found on PATH' },
          gh: state.ghAuthenticated ? { authenticated: true } : { authenticated: false, detail: 'Run `gh auth login` to enable the Full preset.' },
          repositories: state.repos.length,
          workerReachable: true,
        }
      },
      async deleteAllData() {
        timers.forEach(clearTimeout)
        timers.clear()
        state = emptyState()
        emit({ type: 'board.changed' })
        emit({ type: 'connections.changed' })
        emit({ type: 'settings.changed' })
      },
      async openExternal(url) {
        window.open(url, '_blank', 'noopener')
      },
    },
  }

  return {
    api,
    onPush(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get state() {
      return state
    },
  }
}
