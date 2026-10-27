import type { IngestSignal, Settings, TriggerId } from '@gantry/shared'
import { HttpError, skipUnlessFatal, type Ctx, type EmitOptions } from './context'

const API = 'https://api.github.com'
const SOURCE = { kind: 'github', name: 'GitHub' } as const
const SEVERITY = ['low', 'medium', 'high', 'critical']
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])
const PR_TRIGGERS: TriggerId[] = ['github.ci_failed', 'github.merge_conflict', 'github.changes_requested', 'github.review_requested', 'github.mention']

interface User {
  login: string
}
interface Repo {
  full_name: string
}
interface PullRequest {
  url: string
  html_url: string
  number: number
  title: string
  state?: string
  merged?: boolean
  user: User
  mergeable?: boolean | null
  base?: { repo: Repo }
}
interface Issue {
  html_url: string
  number: number
  title: string
  user?: User
  assignees?: User[]
  pull_request?: unknown
}
interface Comment {
  html_url: string
  body?: string | null
  user: User
}
interface Alert {
  html_url: string
  number: number
  security_advisory?: { summary?: string; severity?: string }
  security_vulnerability?: { severity?: string; package?: { name?: string } }
}
interface WebhookPayload {
  action?: string
  repository?: Repo
  pull_request?: PullRequest
  issue?: Issue
  comment?: Comment
  review?: { state: string; body?: string | null; html_url: string; user: User }
  requested_reviewer?: User
  requested_team?: unknown
  assignee?: User
  alert?: Alert
  check_suite?: { conclusion?: string | null; app?: { name?: string }; pull_requests?: { url: string }[] }
  check_run?: { conclusion?: string | null; name?: string; pull_requests?: { url: string }[] }
}

type ActiveKeys = Partial<Record<TriggerId, string[]>>

interface ThreadItem {
  user: User | null
  body?: string | null
  created_at?: string
  submitted_at?: string
}

const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
const apiUrl = (path: string) => (path.startsWith('http') ? path : `${API}${path}`)
const gh = <T>(ctx: Ctx, path: string, init?: RequestInit) => ctx.json<T>('github', apiUrl(path), { ...init, headers: HEADERS })

export const nextLink = (headers: Headers) => /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') ?? '')?.[1]

async function ghAll<T>(ctx: Ctx, path: string, pick: (body: never) => T[] = (body) => body) {
  const items: T[] = []
  for (let url: string | undefined = apiUrl(path); url; ) {
    const { body, headers } = await ctx.request<never>('github', url, { headers: HEADERS })
    items.push(...pick(body))
    url = nextLink(headers)
  }
  return items
}

const sameLogin = (u: User | null | undefined, login: string) => u?.login.toLowerCase() === login.toLowerCase()

export const mentions = (text: string | null | undefined, login: string) =>
  new RegExp(`(^|[^\\w-])@${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text ?? '')

const severityAtLeast = (severity: string | undefined, min: Settings['github']['dependabotMinSeverity']) =>
  SEVERITY.indexOf(severity ?? 'low') >= SEVERITY.indexOf(min)

function repoFilter(settings: Settings, repo: string | undefined) {
  const selected = settings.github.repositories
  if (!repo || !selected.length || selected.some((r) => r.toLowerCase() === repo.toLowerCase())) return undefined
  return `Repository ${repo} is not selected`
}

export function apiUrlFor(htmlUrl: string) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(pull|issues|security\/dependabot)\/(\d+)/.exec(htmlUrl)
  if (!m) return undefined
  const kind = { pull: 'pulls', issues: 'issues', 'security/dependabot': 'dependabot/alerts' }[m[2]!]
  return { repo: m[1]!, kind: m[2]!, number: m[3]!, url: `${API}/repos/${m[1]}/${kind}/${m[3]}` }
}

const active = (ctx: Ctx) => ctx.deps.kv.get<ActiveKeys>('github.active') ?? {}

function signal(ctx: Ctx, trigger: TriggerId, item: { html_url: string; number: number; title: string }, repo: string, extra: Partial<IngestSignal> = {}): IngestSignal {
  return {
    trigger,
    source: SOURCE,
    externalKey: item.html_url,
    title: item.title,
    links: [{ label: `${repo}#${item.number}`, url: item.html_url }],
    repository: repo,
    metadata: { url: item.html_url },
    occurredAt: ctx.iso(),
    ...extra,
  }
}

async function emitTracked(ctx: Ctx, s: IngestSignal, opts: EmitOptions = {}) {
  const result = await ctx.emit(s, opts)
  if (!result) return
  const all = active(ctx)
  all[s.trigger] = [...new Set([...(all[s.trigger] ?? []), s.externalKey])]
  ctx.deps.kv.set('github.active', all)
}

function resolve(ctx: Ctx, trigger: TriggerId, externalKey: string, reason: string) {
  const all = active(ctx)
  if (!all[trigger]?.includes(externalKey)) return
  all[trigger] = all[trigger].filter((k) => k !== externalKey)
  ctx.deps.kv.set('github.active', all)
  ctx.deps.sink.resolve({ trigger, externalKey, reason })
}

export async function githubWebhook(ctx: Ctx, event: string, p: WebhookPayload) {
  const me = ctx.account('github')?.login
  if (!me) return
  const repo = p.repository?.full_name ?? ''
  const filtered = repoFilter(ctx.settings(), repo)
  const isMe = (u?: User | null) => sameLogin(u, me)

  switch (event) {
    case 'check_suite':
    case 'check_run': {
      const unit = p[event]
      if (p.action !== 'completed' || !unit || !FAILED.has(unit.conclusion ?? '')) return
      const name = p.check_run?.name ?? p.check_suite?.app?.name ?? 'Checks'
      for (const ref of unit.pull_requests ?? []) {
        const pr = await gh<PullRequest>(ctx, ref.url)
        if (!isMe(pr.user) || pr.state !== 'open') continue
        await emitTracked(ctx, signal(ctx, 'github.ci_failed', pr, repo, { body: `${name} failed.` }), { filtered })
      }
      return
    }
    case 'pull_request': {
      const pr = p.pull_request!
      if (p.action === 'closed') {
        for (const t of PR_TRIGGERS) resolve(ctx, t, pr.html_url, pr.merged ? 'Pull request merged' : 'Pull request closed')
        return
      }
      if (p.action === 'review_requested') {
        if (isMe(p.requested_reviewer)) await emitTracked(ctx, signal(ctx, 'github.review_requested', pr, repo), { filtered })
        return
      }
      if (p.action === 'review_request_removed') {
        if (isMe(p.requested_reviewer)) resolve(ctx, 'github.review_requested', pr.html_url, 'Review request removed')
        return
      }
      if (!isMe(pr.user) || !['opened', 'reopened', 'synchronize', 'edited'].includes(p.action ?? '')) return
      const full = typeof pr.mergeable === 'boolean' ? pr : await gh<PullRequest>(ctx, pr.url)
      if (full.mergeable === false) await emitTracked(ctx, signal(ctx, 'github.merge_conflict', full, repo), { filtered })
      if (full.mergeable === true) resolve(ctx, 'github.merge_conflict', pr.html_url, 'Pull request is mergeable')
      return
    }
    case 'pull_request_review': {
      const pr = p.pull_request!
      const review = p.review!
      if (p.action !== 'submitted') return
      if (isMe(review.user)) {
        resolve(ctx, 'github.review_requested', pr.html_url, 'Review submitted')
        resolve(ctx, 'github.mention', pr.html_url, 'Replied')
        return
      }
      if (isMe(pr.user) && review.state === 'changes_requested')
        await emitTracked(ctx, signal(ctx, 'github.changes_requested', pr, repo, { body: review.body ?? undefined, actor: review.user.login }), { filtered })
      if (isMe(pr.user) && review.state === 'approved') resolve(ctx, 'github.changes_requested', pr.html_url, 'Pull request approved')
      if (mentions(review.body, me)) await emitMention(ctx, pr, repo, { html_url: review.html_url, body: review.body, user: review.user }, filtered)
      return
    }
    case 'issue_comment':
    case 'pull_request_review_comment': {
      const thread = p.issue ?? p.pull_request!
      const comment = p.comment!
      if (p.action !== 'created') return
      if (isMe(comment.user)) return resolve(ctx, 'github.mention', thread.html_url, 'Replied')
      if (mentions(comment.body, me)) await emitMention(ctx, thread, repo, comment, filtered)
      return
    }
    case 'dependabot_alert': {
      const alert = p.alert!
      if (['fixed', 'dismissed', 'auto_dismissed'].includes(p.action ?? '')) return resolve(ctx, 'github.dependabot', alert.html_url, `Alert ${p.action?.replace('_', ' ')}`)
      if (!['created', 'reopened', 'auto_reopened'].includes(p.action ?? '')) return
      const min = ctx.settings().github.dependabotMinSeverity
      const severity = alert.security_advisory?.severity ?? alert.security_vulnerability?.severity
      await emitTracked(ctx, alertSignal(ctx, alert, repo), {
        filtered: filtered ?? (severityAtLeast(severity, min) ? undefined : `Severity ${severity} is below ${min}`),
      })
      return
    }
    case 'issues': {
      const issue = p.issue!
      if (p.action === 'closed') {
        resolve(ctx, 'github.issue', issue.html_url, 'Issue closed')
        resolve(ctx, 'github.mention', issue.html_url, 'Issue closed')
        return
      }
      const assigned = p.action === 'assigned' && isMe(p.assignee)
      const opened = p.action === 'opened' && (ctx.settings().github.issuesScope === 'all' || (issue.assignees ?? []).some(isMe))
      if (assigned || opened) await emitTracked(ctx, signal(ctx, 'github.issue', issue, repo, { actor: issue.user?.login }), { filtered })
      return
    }
  }
}

function emitMention(ctx: Ctx, thread: { html_url: string; number: number; title: string }, repo: string, comment: Comment, filtered?: string) {
  return emitTracked(
    ctx,
    signal(ctx, 'github.mention', thread, repo, {
      body: `@${comment.user.login}: ${comment.body ?? ''}`,
      links: [
        { label: `${repo}#${thread.number}`, url: thread.html_url },
        { label: 'Comment', url: comment.html_url },
      ],
      actor: comment.user.login,
    }),
    { filtered },
  )
}

function alertSignal(ctx: Ctx, alert: Alert, repo: string) {
  const pkg = alert.security_vulnerability?.package?.name
  const title = alert.security_advisory?.summary ?? `Dependabot alert in ${pkg ?? repo}`
  return signal(ctx, 'github.dependabot', { html_url: alert.html_url, number: alert.number, title }, repo, {
    links: [{ label: `${repo} Dependabot #${alert.number}`, url: alert.html_url }],
  })
}

interface SearchNode {
  url: string
  number: number
  title: string
  repository: { nameWithOwner: string }
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}
export interface Search {
  nodes: SearchNode[]
  complete: boolean
}
type SearchResult = { authored: Search; review: Search; issues?: Search }

const NODE = 'url number title repository { nameWithOwner }'
const AUTHORED_FIELDS = `...on PullRequest { ${NODE} mergeable reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`
const SEARCH = (fields: string) =>
  `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 100, after: $after) { issueCount pageInfo { hasNextPage endCursor } nodes { ${fields} } } }`

interface SearchPage {
  issueCount: number
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: SearchNode[]
}

async function searchAll(ctx: Ctx, fields: string, q: string): Promise<Search> {
  const nodes: SearchNode[] = []
  for (let after: string | null = null; ; ) {
    const { data }: { data: { search: SearchPage } } = await gh(ctx, '/graphql', { method: 'POST', body: JSON.stringify({ query: SEARCH(fields), variables: { q, after } }) })
    nodes.push(...data.search.nodes)
    if (!data.search.pageInfo.hasNextPage) return { nodes, complete: nodes.length >= data.search.issueCount }
    after = data.search.pageInfo.endCursor
  }
}

interface Tracked {
  signals: Map<string, IngestSignal>
  complete: boolean
}
type Current = Partial<Record<TriggerId, Tracked>>

export function currentFromSearch(ctx: Ctx, data: SearchResult, prev: ActiveKeys): Current {
  const settings = ctx.settings()
  const current: Current = {}
  const track = (search: Search, triggers: TriggerId[]) => {
    for (const t of triggers) current[t] = { signals: new Map(), complete: search.complete }
  }
  track(data.authored, ['github.ci_failed', 'github.merge_conflict', 'github.changes_requested'])
  track(data.review, ['github.review_requested'])
  if (data.issues) track(data.issues, ['github.issue'])
  const add = (t: TriggerId, n: SearchNode) => {
    if (repoFilter(settings, n.repository.nameWithOwner)) return
    current[t]!.signals.set(n.url, signal(ctx, t, { html_url: n.url, number: n.number, title: n.title }, n.repository.nameWithOwner))
  }
  const wasActive = (t: TriggerId, n: SearchNode) => prev[t]?.includes(n.url) ?? false
  for (const n of data.authored.nodes) {
    const checks = n.commits?.nodes[0]?.commit.statusCheckRollup?.state
    if (checks === 'FAILURE' || checks === 'ERROR' || ((checks === 'PENDING' || checks === 'EXPECTED') && wasActive('github.ci_failed', n))) add('github.ci_failed', n)
    if (n.mergeable === 'CONFLICTING' || (n.mergeable === 'UNKNOWN' && wasActive('github.merge_conflict', n))) add('github.merge_conflict', n)
    if (n.reviewDecision === 'CHANGES_REQUESTED') add('github.changes_requested', n)
  }
  for (const n of data.review.nodes) add('github.review_requested', n)
  for (const n of data.issues?.nodes ?? []) add('github.issue', n)
  return current
}

const RESOLVE_REASON: Partial<Record<TriggerId, string>> = {
  'github.ci_failed': 'Checks passing or pull request closed',
  'github.merge_conflict': 'Mergeable or pull request closed',
  'github.changes_requested': 'Approved, dismissed, or pull request closed',
  'github.review_requested': 'Review submitted or pull request closed',
  'github.dependabot': 'Alert fixed or dismissed',
  'github.issue': 'Issue closed',
}

export async function applyReconciliation(ctx: Ctx, current: Current, prev = active(ctx)) {
  const next: ActiveKeys = { ...prev }
  for (const [trigger, reason] of Object.entries(RESOLVE_REASON) as [TriggerId, string][]) {
    const cur = current[trigger]
    if (!cur || !ctx.triggerOn(trigger)) continue
    const before = new Set(prev[trigger] ?? [])
    for (const [key, s] of cur.signals) if (!before.has(key)) await ctx.emit(s)
    if (cur.complete) for (const key of before) if (!cur.signals.has(key)) ctx.deps.sink.resolve({ trigger, externalKey: key, reason })
    next[trigger] = [...new Set([...(cur.complete ? [] : before), ...cur.signals.keys()])]
  }
  ctx.deps.kv.set('github.active', next)
}

async function unlessFailed<T>(fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (e) {
    skipUnlessFatal(e)
    return undefined
  }
}

export async function reconcileGithub(ctx: Ctx) {
  const me = ctx.account('github')?.login
  if (!me) return
  const settings = ctx.settings()
  const prev = active(ctx)
  const assignedOnly = settings.github.issuesScope === 'assigned'
  const current = currentFromSearch(
    ctx,
    {
      authored: await searchAll(ctx, AUTHORED_FIELDS, `is:pr is:open archived:false author:${me}`),
      review: await searchAll(ctx, `...on PullRequest { ${NODE} }`, `is:pr is:open archived:false user-review-requested:${me}`),
      issues: assignedOnly ? await searchAll(ctx, `...on Issue { ${NODE} }`, `is:issue is:open archived:false assignee:${me}`) : undefined,
    },
    prev,
  )
  let repos: Promise<string[]> | undefined
  // shortcut: lists every accessible repo per reconcile when none are selected, cache the list if users hit rate limits
  const repoNames = () => (repos ??= settings.github.repositories.length ? Promise.resolve(settings.github.repositories) : githubRepositories(ctx).then((rs) => rs.map((r) => r.fullName)))
  if (ctx.triggerOn('github.dependabot')) current['github.dependabot'] = await unlessFailed(async () => openAlerts(ctx, settings, await repoNames()))
  if (!assignedOnly && ctx.triggerOn('github.issue')) current['github.issue'] = await unlessFailed(async () => openIssues(ctx, await repoNames()))
  await applyReconciliation(ctx, current, prev)
  await reconcileMentions(ctx, me)
}

async function openAlerts(ctx: Ctx, settings: Settings, repos: string[]): Promise<Tracked> {
  const signals = new Map<string, IngestSignal>()
  const severities = SEVERITY.slice(SEVERITY.indexOf(settings.github.dependabotMinSeverity)).join(',')
  for (const fullName of repos) {
    const alerts = await ghAll<Alert>(ctx, `/repos/${fullName}/dependabot/alerts?state=open&per_page=100&severity=${severities}`).catch((e) => {
      if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return []
      throw e
    })
    for (const a of alerts) signals.set(a.html_url, alertSignal(ctx, a, fullName))
  }
  return { signals, complete: true }
}

async function openIssues(ctx: Ctx, repos: string[]): Promise<Tracked> {
  const signals = new Map<string, IngestSignal>()
  for (const fullName of repos) {
    const issues = await ghAll<Issue>(ctx, `/repos/${fullName}/issues?state=open&per_page=100`)
    for (const i of issues) if (!i.pull_request) signals.set(i.html_url, signal(ctx, 'github.issue', i, fullName, { actor: i.user?.login }))
  }
  return { signals, complete: true }
}

export async function mentionResolution(ctx: Ctx, me: string, htmlUrl: string) {
  const target = apiUrlFor(htmlUrl)
  if (!target || target.kind === 'security/dependabot') return undefined
  const base = `/repos/${target.repo}`
  const thread = await gh<{ state: string }>(ctx, `${base}/issues/${target.number}`)
  if (thread.state === 'closed') return target.kind === 'pull' ? 'Pull request closed' : 'Issue closed'
  const paths = [`${base}/issues/${target.number}/comments?per_page=100`]
  if (target.kind === 'pull') paths.push(`${base}/pulls/${target.number}/comments?per_page=100`, `${base}/pulls/${target.number}/reviews?per_page=100`)
  const items: ThreadItem[] = []
  for (const path of paths) items.push(...(await ghAll<ThreadItem>(ctx, path)))
  const at = (i: ThreadItem) => Date.parse(i.submitted_at ?? i.created_at ?? '')
  const mentionedAt = items.filter((i) => !sameLogin(i.user, me) && mentions(i.body, me)).map(at)
  if (!mentionedAt.length) return undefined
  const last = Math.max(...mentionedAt)
  return items.some((i) => sameLogin(i.user, me) && at(i) > last) ? 'Replied' : undefined
}

async function reconcileMentions(ctx: Ctx, me: string) {
  for (const key of active(ctx)['github.mention'] ?? []) {
    const reason = await unlessFailed(() => mentionResolution(ctx, me, key))
    if (reason) resolve(ctx, 'github.mention', key, reason)
  }
}

export async function githubRepositories(ctx: Ctx) {
  const installations = await ghAll<{ id: number }>(ctx, '/user/installations?per_page=100', (b: { installations: { id: number }[] }) => b.installations)
  const names: string[] = []
  for (const { id } of installations) {
    const repositories = await ghAll<Repo>(ctx, `/user/installations/${id}/repositories?per_page=100`, (b: { repositories: Repo[] }) => b.repositories)
    names.push(...repositories.map((r) => r.full_name))
  }
  const settings = ctx.settings()
  return names.map((fullName) => ({ fullName, selected: !repoFilter(settings, fullName) }))
}

export async function githubContext(ctx: Ctx, htmlUrl: string) {
  const target = apiUrlFor(htmlUrl)
  if (!target) return undefined
  if (target.kind === 'pull') {
    const pr = await gh<PullRequest & { body?: string; additions: number; deletions: number; changed_files: number; head: { sha: string } }>(ctx, target.url)
    const runs = await ghAll(ctx, `/repos/${target.repo}/commits/${pr.head.sha}/check-runs?per_page=100`, (b: { check_runs: { name: string; conclusion: string | null }[] }) => b.check_runs)
    const failing = runs.filter((r) => FAILED.has(r.conclusion ?? '')).map((r) => r.name)
    return [
      `PR: ${pr.title}`,
      `Diff: +${pr.additions} −${pr.deletions} across ${pr.changed_files} files`,
      failing.length ? `Failing checks: ${failing.join(', ')}` : undefined,
      pr.body ? `\n${pr.body}` : undefined,
    ]
      .filter(Boolean)
      .join('\n')
  }
  if (target.kind === 'issues') {
    const issue = await gh<Issue & { body?: string }>(ctx, target.url)
    return `Issue: ${issue.title}\n\n${issue.body ?? ''}`
  }
  const alert = await gh<Alert & { security_advisory?: { description?: string } }>(ctx, target.url)
  return `Dependabot: ${alert.security_advisory?.summary ?? ''}\nPackage: ${alert.security_vulnerability?.package?.name ?? '?'}\n\n${alert.security_advisory?.description ?? ''}`
}
