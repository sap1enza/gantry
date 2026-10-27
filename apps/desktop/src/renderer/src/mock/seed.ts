import { DEFAULT_SETTINGS, type Account, type Actionable, type ActivityEvent, type ApiTokenInfo, type Column, type ConnectionInfo, type Repository, type Settings } from '@gantry/shared'

export interface MockState {
  actionables: Actionable[]
  columns: Column[]
  events: ActivityEvent[]
  settings: Settings
  account: Account
  connections: ConnectionInfo[]
  tokens: ApiTokenInfo[]
  repos: Repository[]
  githubRepos: { fullName: string; selected: boolean }[]
  llmKey: boolean
  claudeAvailable: boolean
  ghAuthenticated: boolean
}

const FIXED_COLUMNS: Column[] = [
  { id: 'todo', name: 'To-do', kind: 'fixed', position: 0 },
  { id: 'in_progress', name: 'In Progress', kind: 'fixed', position: 1 },
  { id: 'review', name: 'Review', kind: 'fixed', position: 2 },
  { id: 'done', name: 'Done', kind: 'fixed', position: 3 },
]

export function emptyState(): MockState {
  return {
    actionables: [],
    columns: structuredClone(FIXED_COLUMNS),
    events: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    account: { name: '', signedIn: false, deviceId: 'dev_8c21f0', onboarded: false },
    connections: [
      { provider: 'github', status: 'disconnected' },
      { provider: 'slack', status: 'disconnected' },
      { provider: 'google', status: 'disconnected' },
      { provider: 'api', status: 'connected', detail: 'Enabled' },
    ],
    tokens: [],
    repos: [],
    githubRepos: [
      { fullName: 'acme/storefront', selected: false },
      { fullName: 'acme/api', selected: false },
      { fullName: 'acme/dashboard', selected: false },
      { fullName: 'acme/infra', selected: false },
    ],
    llmKey: false,
    claudeAvailable: true,
    ghAuthenticated: false,
  }
}

export function seededState(now = new Date()): MockState {
  const at = (h: number, m: number, s = 0) => {
    const d = new Date(now)
    d.setHours(h, m, s, 0)
    return d.toISOString()
  }
  const card = (p: Partial<Actionable> & Pick<Actionable, 'displayId' | 'title' | 'source' | 'column'>): Actionable => ({
    id: crypto.randomUUID(),
    triggers: [],
    links: [],
    tags: [],
    metadata: {},
    position: 0,
    createdAt: at(9, 0),
    updatedAt: at(9, 0),
    ...p,
  })
  const dispatch = (worktree: string, repository: string, startedAt: string, costUsd = 0): Actionable['dispatch'] => ({
    id: crypto.randomUUID(),
    provider: 'claude',
    model: 'sonnet',
    repository,
    repositoryPath: `~/Code/${repository.split('/')[1]}`,
    worktreePath: `~/Developer/Gantry/${worktree}`,
    branch: `gantry/${worktree}`,
    permissionPreset: 'edit_test',
    instructions: 'Use the event trace to find the retry race. Add a regression test. Open a PR; do not merge.',
    sessionId: crypto.randomUUID(),
    startedAt,
    startedBy: 'Alex Lee',
    inputTokens: 182_000,
    outputTokens: 9_400,
    costUsd,
  })

  const gt128 = card({
    displayId: 'GT-128',
    title: 'Fix checkout timeout after payment retry',
    body: 'A new production error is affecting checkout retries. Investigate the trace, reproduce the failure, and open a fix for review.',
    source: { kind: 'api', name: 'Honeybadger', icon: 'bug' },
    triggers: ['api.custom'],
    links: [
      { label: 'Honeybadger event #4821', url: 'https://app.honeybadger.io/faults/4821' },
      { label: 'acme/storefront · PR #248', url: 'https://github.com/acme/storefront/pull/248' },
    ],
    repository: 'acme/storefront',
    priority: 'high',
    column: 'in_progress',
    agentState: 'running',
    dispatch: dispatch('gt-128-checkout', 'acme/storefront', at(9, 38, 44), 0.42),
    createdAt: at(9, 38, 2),
    updatedAt: at(9, 41, 12),
  })

  const actionables: Actionable[] = [
    card({
      displayId: 'GT-127',
      title: 'Fix failing CI on payment retry PR',
      body: 'Check suite **failed** on `payment-retry`. 2 jobs failing: `unit` and `e2e`.',
      source: { kind: 'github', name: 'Pull request' },
      triggers: ['github.ci_failed'],
      tags: ['CI failed'],
      links: [{ label: 'acme/storefront · PR #246', url: 'https://github.com/acme/storefront/pull/246' }],
      repository: 'acme/storefront',
      priority: 'high',
      column: 'todo',
      position: 0,
      createdAt: at(9, 33, 18),
    }),
    card({
      displayId: 'GT-126',
      title: 'Reply to Maya about the release checklist',
      body: '> @alex can you confirm the release checklist covers the payment migration before Thursday?\n\nAI check: mention is 34 minutes old with no reply in thread.',
      source: { kind: 'slack', name: 'Unreplied mention' },
      triggers: ['slack.unreplied'],
      tags: ['Needs reply', 'AI detected'],
      links: [{ label: "#engineering · Maya's message", url: 'https://acme.slack.com/archives/C01/p1730000000' }],
      column: 'todo',
      position: 1,
      createdAt: at(9, 23, 6),
    }),
    card({
      displayId: 'GT-125',
      title: 'Review the updated security questionnaire',
      body: 'Priya sent the updated Northstar security questionnaire. Sections 4 and 7 changed.',
      source: { kind: 'email', name: 'Inbox' },
      triggers: ['email.new'],
      tags: ['New email'],
      links: [{ label: 'Priya Shah · Northstar', url: 'https://mail.google.com/mail/u/0/#inbox/18c' }],
      column: 'todo',
      position: 2,
      createdAt: at(9, 9, 12),
    }),
    gt128,
    card({
      displayId: 'GT-124',
      title: 'Resolve merge conflicts in auth middleware',
      body: 'PR #891 cannot be merged: conflicts in `src/middleware/auth.ts`.',
      source: { kind: 'github', name: 'Merge conflicts' },
      triggers: ['github.merge_conflict'],
      tags: ['Merge conflicts'],
      links: [{ label: 'acme/api · PR #891', url: 'https://github.com/acme/api/pull/891' }],
      repository: 'acme/api',
      column: 'in_progress',
      position: 1,
      agentState: 'paused',
      pendingQuestion: { id: 'q1', prompt: 'Keep the new session refresh logic from main, or the token rotation from this branch?', options: ['Keep main', 'Keep branch', 'Merge both'] },
      dispatch: dispatch('gt-124-auth', 'acme/api', at(9, 14), 0.18),
      createdAt: at(9, 12),
      updatedAt: at(9, 21, 42),
    }),
    card({
      displayId: 'GT-122',
      title: 'Add retry budget to webhook sender',
      body: 'Webhook deliveries retry forever on 5xx. Cap retries and surface failures.',
      source: { kind: 'manual', name: 'Manual' },
      triggers: ['manual'],
      repository: 'acme/api',
      column: 'review',
      position: 0,
      agentState: 'completed',
      dispatch: dispatch('gt-122-retry-budget', 'acme/api', at(8, 40), 0.61),
      result: {
        summary: 'Added a per-endpoint retry budget (5 attempts, exponential backoff) and a `webhook.failed` event.',
        filesChanged: ['src/webhooks/sender.ts', 'src/webhooks/sender.test.ts', 'src/events.ts'],
        branch: 'gantry/gt-122-retry-budget',
        prUrl: 'https://github.com/acme/api/pull/893',
        testsRun: 'pnpm test webhooks — 24 passed',
        openQuestions: ['Should the budget be configurable per customer?'],
      },
      links: [{ label: 'acme/api · PR #893', url: 'https://github.com/acme/api/pull/893' }],
      createdAt: at(8, 35),
      updatedAt: at(9, 2),
    }),
    card({
      displayId: 'GT-123',
      title: 'Upgrade vulnerable cookie dependency',
      source: { kind: 'github', name: 'Dependabot' },
      triggers: ['github.dependabot'],
      tags: ['Dependabot'],
      links: [{ label: 'acme/api · PR #892 opened', url: 'https://github.com/acme/api/pull/892' }],
      repository: 'acme/api',
      column: 'done',
      position: 0,
      agentState: 'completed',
      doneAt: at(9, 27, 31),
      createdAt: at(8, 50),
    }),
    card({
      displayId: 'GT-120',
      title: 'Review pagination changes',
      source: { kind: 'github', name: 'Review request' },
      triggers: ['github.review_requested'],
      links: [{ label: 'acme/dashboard · PR #104', url: 'https://github.com/acme/dashboard/pull/104' }],
      column: 'done',
      position: 1,
      agentState: 'completed',
      doneAt: at(9, 16, 20),
      createdAt: at(8, 30),
    }),
    card({
      displayId: 'GT-119',
      title: 'Follow up on staging access',
      source: { kind: 'slack', name: 'AI follow-up' },
      triggers: ['slack.follow_up'],
      links: [{ label: '#platform · Reply sent', url: 'https://acme.slack.com/archives/C02/p1730000001' }],
      column: 'done',
      position: 2,
      doneAt: at(8, 52),
      createdAt: at(8, 10),
    }),
    card({
      displayId: 'GT-121',
      title: 'Confirm production access with Sam',
      body: 'Waiting for team response. No agent dispatched.',
      source: { kind: 'slack', name: '#platform' },
      triggers: ['slack.follow_up'],
      column: 'col_waiting',
      position: 0,
      createdAt: at(8, 20),
    }),
    card({
      displayId: 'GT-118',
      title: 'Duplicate mention on pagination PR',
      source: { kind: 'github', name: 'Mention' },
      triggers: ['github.mention'],
      column: 'todo',
      position: 3,
      dismissedAt: at(9, 18, 4),
      createdAt: at(8, 5),
    }),
    card({
      displayId: 'GT-117',
      title: 'Renew staging TLS certificate',
      source: { kind: 'email', name: 'Inbox' },
      triggers: ['email.new'],
      column: 'todo',
      position: 4,
      snoozedUntil: new Date(now.getTime() + 86_400_000).toISOString(),
      createdAt: at(7, 50),
    }),
  ]

  const ev = (p: Omit<ActivityEvent, 'id'>): ActivityEvent => ({ id: crypto.randomUUID(), ...p })
  const byId = (d: string) => actionables.find((a) => a.displayId === d)?.id
  const user = { kind: 'user' as const, name: 'Alex Lee' }
  const agent = { kind: 'agent' as const, name: 'Agent' }
  const events: ActivityEvent[] = [
    ev({ type: 'agent_update', actionableId: gt128.id, actionableDisplayId: 'GT-128', source: 'Claude Code', actor: agent, title: 'Running checkout regression tests', detail: 'gantry/gt-128-checkout · 2 files changed', createdAt: at(9, 41, 12) }),
    ev({ type: 'agent_update', actionableId: gt128.id, actionableDisplayId: 'GT-128', source: 'Claude Code', actor: agent, title: 'Updated payment retry handler', detail: 'src/checkout/retry.ts', createdAt: at(9, 40, 48) }),
    ev({ type: 'agent_update', actionableId: gt128.id, actionableDisplayId: 'GT-128', source: 'Claude Code', actor: agent, title: 'Created isolated workspace', detail: '~/Developer/Gantry/gt-128-checkout', createdAt: at(9, 39, 6) }),
    ev({ type: 'dispatched', actionableId: gt128.id, actionableDisplayId: 'GT-128', source: 'Honeybadger', actor: user, title: 'Fix checkout timeout after payment retry', detail: 'Claude Code · acme/storefront · isolated workspace created', createdAt: at(9, 38, 44) }),
    ev({ type: 'received', outcome: 'created', actionableId: gt128.id, actionableDisplayId: 'GT-128', source: 'API', actor: { kind: 'source', name: 'API · Honeybadger' }, title: 'Honeybadger event #4821 created an actionable', detail: 'custom source: Honeybadger · source URL attached', createdAt: at(9, 38, 2) }),
    ev({ type: 'connection', source: 'Email', actor: { kind: 'gantry', name: 'Gantry' }, title: 'Email connection needs reauthorization', detail: 'Google Workspace · alex@acme.dev · new input paused', createdAt: at(9, 35, 10) }),
    ev({ type: 'received', outcome: 'created', actionableId: byId('GT-127'), actionableDisplayId: 'GT-127', source: 'GitHub', actor: { kind: 'source', name: 'GitHub webhook' }, title: 'CI failed on payment retry pull request', detail: 'acme/storefront #246 · trigger: failing CI', createdAt: at(9, 33, 18) }),
    ev({ type: 'received', outcome: 'ignored:filtered', source: 'Email', actor: { kind: 'source', name: 'Google Workspace' }, title: 'Weekly digest from Linear', detail: 'excluded category: Updates', createdAt: at(9, 30, 2) }),
    ev({ type: 'done', actionableId: byId('GT-123'), actionableDisplayId: 'GT-123', source: 'Claude Code', actor: agent, title: 'Upgraded vulnerable cookie dependency', detail: 'acme/api · PR #892 opened · workspace deleted', createdAt: at(9, 27, 31) }),
    ev({ type: 'received', outcome: 'created', actionableId: byId('GT-126'), actionableDisplayId: 'GT-126', source: 'Slack', actor: { kind: 'source', name: 'Slack · AI check' }, title: "Maya's mention still needs a reply", detail: '#engineering · trigger: unreplied mention · AI detected', createdAt: at(9, 23, 6) }),
    ev({ type: 'paused', actionableId: byId('GT-124'), actionableDisplayId: 'GT-124', source: 'Claude Code', actor: user, title: 'Auth middleware agent paused for input', detail: 'acme/api #891 · workspace preserved', createdAt: at(9, 21, 42) }),
    ev({ type: 'dismissed', actionableId: byId('GT-118'), actionableDisplayId: 'GT-118', source: 'GitHub', actor: user, title: 'Dismissed duplicate mention on pagination PR', detail: 'acme/dashboard #104 · no agent dispatched', createdAt: at(9, 18, 4) }),
    ev({ type: 'completed', actionableId: byId('GT-120'), actionableDisplayId: 'GT-120', source: 'Claude Code', actor: agent, title: 'Reviewed pagination changes', detail: 'acme/dashboard #104 · review submitted', createdAt: at(9, 16, 20) }),
    ev({ type: 'received', outcome: 'created', actionableId: byId('GT-125'), actionableDisplayId: 'GT-125', source: 'Email', actor: { kind: 'source', name: 'Google Workspace' }, title: 'Security questionnaire received from Priya Shah', detail: 'alex@acme.dev · trigger: new email', createdAt: at(9, 9, 12) }),
  ]
  for (let i = 0; i < 16; i++)
    events.push(ev({ type: 'received', outcome: i % 3 ? 'ignored:trigger-off' : 'ignored:duplicate', source: 'GitHub', actor: { kind: 'source', name: 'GitHub webhook' }, title: `Push to acme/storefront main (${i + 1})`, detail: 'no matching trigger', createdAt: at(8, 59 - i * 3) }))

  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.github.repositories = ['acme/storefront', 'acme/api', 'acme/dashboard']

  return {
    actionables,
    columns: [...structuredClone(FIXED_COLUMNS), { id: 'col_waiting', name: 'Waiting', kind: 'custom', position: 4 }],
    events,
    settings,
    account: { name: 'Alex Lee', signedIn: true, githubLogin: 'alexlee', email: 'alex@acme.dev', deviceId: 'dev_8c21f0', onboarded: true },
    connections: [
      { provider: 'github', status: 'connected', account: { login: 'alexlee', team: 'acme organization' }, lastSyncAt: now.toISOString() },
      { provider: 'slack', status: 'connected', account: { login: 'alex', name: 'Alex Lee', team: 'Acme workspace' }, lastSyncAt: new Date(now.getTime() - 60_000).toISOString() },
      { provider: 'google', status: 'reconnect_required', account: { login: 'alex@acme.dev', team: 'Google Workspace' }, lastSyncAt: at(9, 9), detail: 'OAuth session expired at 9:35 AM. Existing actionables are kept.' },
      { provider: 'api', status: 'connected', detail: 'Honeybadger is connected through this API.' },
    ],
    tokens: [{ id: crypto.randomUUID(), name: 'Honeybadger', prefix: 'gtry_', lastFour: '4e91', createdAt: at(8, 0), lastUsedAt: at(9, 38, 2) }],
    repos: [
      { id: crypto.randomUUID(), path: '~/Code/storefront', remote: 'acme/storefront', defaultBranch: 'main', setupCommand: 'cp ../../.env . && pnpm i' },
      { id: crypto.randomUUID(), path: '~/Code/api', remote: 'acme/api', defaultBranch: 'main' },
    ],
    githubRepos: [
      { fullName: 'acme/storefront', selected: true },
      { fullName: 'acme/api', selected: true },
      { fullName: 'acme/dashboard', selected: true },
      { fullName: 'acme/infra', selected: false },
    ],
    llmKey: true,
    claudeAvailable: true,
    ghAuthenticated: false,
  }
}
