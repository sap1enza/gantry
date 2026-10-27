import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyReconciliation, apiUrlFor, currentFromSearch, githubRepositories, githubWebhook, mentionResolution, mentions, nextLink, reconcileGithub } from './github'
import { connectedCtx, fakeDeps, grantFor, NOW, res, routeFetch } from './testing'

const ME = { id: '1', login: 'lucas' }
const repository = { full_name: 'acme/app' }
const pr = (over: object = {}) => ({
  url: 'https://api.github.com/repos/acme/app/pulls/7',
  html_url: 'https://github.com/acme/app/pull/7',
  number: 7,
  title: 'Fix checkout',
  state: 'open',
  user: { login: 'lucas' },
  ...over,
})

function setup() {
  const deps = fakeDeps()
  const ctx = connectedCtx(deps, grantFor('github', ME))
  const ingested = () => deps.sink.ingest.mock.calls.map(([s]) => s.trigger)
  return { deps, ctx, ingested }
}

afterEach(() => vi.unstubAllGlobals())

describe('githubWebhook', () => {
  it('turns a review request for me into review_requested', async () => {
    const { ctx, ingested, deps } = setup()
    await githubWebhook(ctx, 'pull_request', { action: 'review_requested', repository, pull_request: pr({ user: { login: 'ana' } }), requested_reviewer: { login: 'lucas' } })
    expect(ingested()).toEqual(['github.review_requested'])
    expect(deps.sink.ingest.mock.calls[0]![0]).toMatchObject({ externalKey: 'https://github.com/acme/app/pull/7', repository: 'acme/app' })
  })

  it('ignores team review requests', async () => {
    const { ctx, ingested } = setup()
    await githubWebhook(ctx, 'pull_request', { action: 'review_requested', repository, pull_request: pr({ user: { login: 'ana' } }), requested_team: { slug: 'core' } })
    expect(ingested()).toEqual([])
  })

  it('logs events from unselected repositories as filtered', async () => {
    const { ctx, deps, ingested } = setup()
    deps.settings.github.repositories = ['acme/other']
    await githubWebhook(ctx, 'pull_request', { action: 'review_requested', repository, pull_request: pr(), requested_reviewer: { login: 'lucas' } })
    expect(ingested()).toEqual([])
    expect(deps.sink.logIgnored.mock.calls[0]![1]).toBe('ignored:filtered')
  })

  it('logs disabled triggers as trigger-off', async () => {
    const { ctx, deps, ingested } = setup()
    deps.settings.triggers = { ...deps.settings.triggers, 'github.review_requested': false }
    await githubWebhook(ctx, 'pull_request', { action: 'review_requested', repository, pull_request: pr(), requested_reviewer: { login: 'lucas' } })
    expect(ingested()).toEqual([])
    expect(deps.sink.logIgnored.mock.calls[0]![1]).toBe('ignored:trigger-off')
  })

  it('fetches the PR for a failed check suite and only signals my PRs', async () => {
    const { ctx, ingested } = setup()
    routeFetch([['/pulls/7', () => res(pr())], ['/pulls/8', () => res(pr({ number: 8, user: { login: 'ana' } }))]])
    await githubWebhook(ctx, 'check_suite', {
      action: 'completed',
      repository,
      check_suite: { conclusion: 'failure', pull_requests: [{ url: 'https://api.github.com/repos/acme/app/pulls/7' }, { url: 'https://api.github.com/repos/acme/app/pulls/8' }] },
    })
    expect(ingested()).toEqual(['github.ci_failed'])
  })

  it('fetches mergeable when the webhook omits it', async () => {
    const { ctx, ingested } = setup()
    routeFetch([['/pulls/7', () => res(pr({ mergeable: false }))]])
    await githubWebhook(ctx, 'pull_request', { action: 'synchronize', repository, pull_request: pr({ mergeable: null }) })
    expect(ingested()).toEqual(['github.merge_conflict'])
  })

  it('signals changes requested on my PR', async () => {
    const { ctx, ingested } = setup()
    await githubWebhook(ctx, 'pull_request_review', {
      action: 'submitted',
      repository,
      pull_request: pr(),
      review: { state: 'changes_requested', body: 'Please add tests', html_url: 'https://github.com/acme/app/pull/7#r1', user: { login: 'ana' } },
    })
    expect(ingested()).toEqual(['github.changes_requested'])
  })

  it('signals @me mentions and resolves when I reply', async () => {
    const { ctx, deps, ingested } = setup()
    const issue = { html_url: 'https://github.com/acme/app/issues/3', number: 3, title: 'Bug' }
    await githubWebhook(ctx, 'issue_comment', { action: 'created', repository, issue, comment: { html_url: `${issue.html_url}#c1`, body: 'cc @lucas', user: { login: 'ana' } } })
    expect(ingested()).toEqual(['github.mention'])
    await githubWebhook(ctx, 'issue_comment', { action: 'created', repository, issue, comment: { html_url: `${issue.html_url}#c2`, body: 'on it', user: { login: 'lucas' } } })
    expect(deps.sink.resolve).toHaveBeenCalledWith({ trigger: 'github.mention', externalKey: issue.html_url, reason: 'Replied' })
  })

  it('filters dependabot alerts below the threshold and resolves fixed ones', async () => {
    const { ctx, deps, ingested } = setup()
    const alert = (severity: string, n: number) => ({ html_url: `https://github.com/acme/app/security/dependabot/${n}`, number: n, security_advisory: { severity, summary: `vuln ${n}` } })
    await githubWebhook(ctx, 'dependabot_alert', { action: 'created', repository, alert: alert('medium', 1) })
    await githubWebhook(ctx, 'dependabot_alert', { action: 'created', repository, alert: alert('critical', 2) })
    expect(ingested()).toEqual(['github.dependabot'])
    expect(deps.sink.logIgnored.mock.calls[0]![2]).toBe('Severity medium is below high')
    await githubWebhook(ctx, 'dependabot_alert', { action: 'fixed', repository, alert: alert('critical', 2) })
    expect(deps.sink.resolve).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'github.dependabot', reason: 'Alert fixed' }))
  })

  it('signals issues assigned to me, and opened issues only when scope is all', async () => {
    const { ctx, deps, ingested } = setup()
    deps.settings.triggers = { ...deps.settings.triggers, 'github.issue': true }
    const issue = { html_url: 'https://github.com/acme/app/issues/4', number: 4, title: 'Crash', assignees: [] }
    await githubWebhook(ctx, 'issues', { action: 'opened', repository, issue })
    expect(ingested()).toEqual([])
    await githubWebhook(ctx, 'issues', { action: 'assigned', repository, issue, assignee: { login: 'lucas' } })
    deps.settings.github.issuesScope = 'all'
    await githubWebhook(ctx, 'issues', { action: 'opened', repository, issue })
    expect(ingested()).toEqual(['github.issue', 'github.issue'])
  })

  it('resolves every active trigger when the PR closes', async () => {
    const { ctx, deps } = setup()
    deps.kv.set('github.active', { 'github.ci_failed': [pr().html_url], 'github.merge_conflict': ['other'] })
    await githubWebhook(ctx, 'pull_request', { action: 'closed', repository, pull_request: pr({ state: 'closed', merged: true }) })
    expect(deps.sink.resolve.mock.calls.map(([r]) => [r.trigger, r.reason])).toEqual([['github.ci_failed', 'Pull request merged']])
  })
})

const s = (key: string) => ({ trigger: 'github.ci_failed' as const, source: { kind: 'github' as const, name: 'GitHub' }, externalKey: key, title: key, occurredAt: '' })
const searchPage = (nodes: object[], issueCount = nodes.length, endCursor: string | null = null) => ({ data: { search: { issueCount, pageInfo: { hasNextPage: !!endCursor, endCursor }, nodes } } })
const emptySearch = () => res(searchPage([]))
const linked = (body: unknown, next?: string) => res(body, 200, next ? { link: `<${next}>; rel="next", <https://x/last>; rel="last"` } : {})

describe('reconciliation', () => {
  const node = (n: number, over: object = {}) => ({ url: `https://github.com/acme/app/pull/${n}`, number: n, title: `PR ${n}`, repository: { nameWithOwner: 'acme/app' }, ...over })
  const rollup = (state: string) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } })

  it('keeps keys a webhook tracked while reconciliation was running', async () => {
    const { ctx, deps } = setup()
    const webhookKey = 'https://github.com/acme/app/pull/8'
    deps.sink.ingest.mockImplementation(() => {
      deps.kv.set('github.active', { 'github.review_requested': [webhookKey], 'github.mention': [webhookKey] })
      return { outcome: 'created' }
    })
    const current = currentFromSearch(ctx, { authored: { complete: true, nodes: [] }, review: { complete: true, nodes: [node(5)] } }, {})
    await applyReconciliation(ctx, current, {})
    expect(deps.kv.get('github.active')).toMatchObject({ 'github.review_requested': [node(5).url, webhookKey], 'github.mention': [webhookKey] })
  })

  it('maps search state to current entities, keeping pending ones that were active', () => {
    const { ctx } = setup()
    const current = currentFromSearch(
      ctx,
      {
        authored: { complete: true, nodes: [node(1, rollup('FAILURE')), node(2, rollup('PENDING')), node(3, { ...rollup('PENDING'), mergeable: 'CONFLICTING' }), node(4, { reviewDecision: 'CHANGES_REQUESTED' })] },
        review: { complete: true, nodes: [node(5)] },
        issues: { complete: true, nodes: [] },
      },
      { 'github.ci_failed': [node(2).url] },
    )
    expect([...current['github.ci_failed']!.signals.keys()]).toEqual([node(1).url, node(2).url])
    expect([...current['github.merge_conflict']!.signals.keys()]).toEqual([node(3).url])
    expect([...current['github.changes_requested']!.signals.keys()]).toEqual([node(4).url])
    expect([...current['github.review_requested']!.signals.keys()]).toEqual([node(5).url])
    expect(current['github.issue']!.signals.size).toBe(0)
  })

  it('backfills new entities and resolves ones that no longer match', async () => {
    const { ctx, deps, ingested } = setup()
    deps.kv.set('github.active', { 'github.ci_failed': ['A', 'B'] })
    await applyReconciliation(ctx, { 'github.ci_failed': { complete: true, signals: new Map([['A', s('A')], ['C', s('C')]]) } })
    expect(ingested()).toEqual(['github.ci_failed'])
    expect(deps.sink.ingest.mock.calls[0]![0].externalKey).toBe('C')
    expect(deps.sink.resolve).toHaveBeenCalledWith({ trigger: 'github.ci_failed', externalKey: 'B', reason: 'Checks passing or pull request closed' })
    expect(deps.kv.get('github.active')).toEqual({ 'github.ci_failed': ['A', 'C'] })
  })

  it('never resolves from a truncated result, only backfills', async () => {
    const { ctx, deps, ingested } = setup()
    deps.kv.set('github.active', { 'github.ci_failed': ['A', 'B'] })
    await applyReconciliation(ctx, { 'github.ci_failed': { complete: false, signals: new Map([['C', s('C')]]) } })
    expect(ingested()).toEqual(['github.ci_failed'])
    expect(deps.sink.resolve).not.toHaveBeenCalled()
    expect(deps.kv.get('github.active')).toEqual({ 'github.ci_failed': ['A', 'B', 'C'] })
  })
})

describe('reconcileGithub', () => {
  it('backfills open unreplied mentions updated since the last scan', async () => {
    const { ctx, deps } = setup()
    deps.kv.set('github.mentionsSince', '2026-10-27T11:50:00.000Z')
    const issue = { url: 'https://github.com/acme/app/issues/7', number: 7, title: 'Help', repository: { nameWithOwner: 'acme/app' } }
    const queries: string[] = []
    routeFetch([
      [
        '/graphql',
        (init) => {
          const { q } = JSON.parse(String(init!.body)).variables as { q: string }
          queries.push(q)
          return res(searchPage(q.startsWith('mentions:') ? [issue] : []))
        },
      ],
      ['/issues/7/comments', () => res([{ user: { login: 'ana' }, body: '@lucas thoughts?', created_at: '2026-10-27T11:55:00Z' }])],
      ['/issues/7', () => res({ state: 'open' })],
    ])
    await reconcileGithub(ctx)
    expect(queries).toContain('mentions:lucas is:open archived:false updated:>=2026-10-27T11:50:00.000Z')
    expect(deps.sink.ingest.mock.calls.map(([x]) => [x.trigger, x.externalKey])).toEqual([['github.mention', issue.url]])
    expect(deps.kv.get('github.active')).toMatchObject({ 'github.mention': [issue.url] })
    expect(deps.kv.get('github.mentionsSince')).toBe(NOW.toISOString())
  })

  const alertUrl = (n: number) => `https://github.com/acme/app/security/dependabot/${n}`
  const alert = (n: number) => ({ html_url: alertUrl(n), number: n, security_advisory: { severity: 'high', summary: `vuln ${n}` } })

  it('keeps dependabot alerts active when fetching them fails', async () => {
    const { ctx, deps } = setup()
    deps.settings.github.repositories = ['acme/app']
    deps.kv.set('github.active', { 'github.dependabot': [alertUrl(1)] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    routeFetch([
      ['/graphql', emptySearch],
      ['/dependabot/alerts', () => res({}, 500)],
    ])
    await reconcileGithub(ctx)
    expect(deps.sink.resolve).not.toHaveBeenCalled()
  })

  it('follows dependabot pagination before resolving', async () => {
    const { ctx, deps } = setup()
    deps.settings.github.repositories = ['acme/app']
    deps.kv.set('github.active', { 'github.dependabot': [alertUrl(1), alertUrl(2), alertUrl(3)] })
    routeFetch([
      ['/graphql', emptySearch],
      ['after=c2', () => linked([alert(2)])],
      ['/dependabot/alerts', () => linked([alert(1)], 'https://api.github.com/repos/acme/app/dependabot/alerts?after=c2')],
    ])
    await reconcileGithub(ctx)
    expect(deps.sink.resolve.mock.calls.map(([r]) => r.externalKey)).toEqual([alertUrl(3)])
  })

  it('stops paging when rate limited and resolves nothing', async () => {
    const { ctx, deps } = setup()
    deps.settings.github.repositories = ['acme/app']
    deps.kv.set('github.active', { 'github.dependabot': [alertUrl(3)] })
    const fetch = routeFetch([
      ['/graphql', emptySearch],
      ['after=c2', () => linked([alert(2)])],
      ['/dependabot/alerts', () => res([alert(1)], 200, { link: '<https://api.github.com/repos/acme/app/dependabot/alerts?after=c2>; rel="next"', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' })],
    ])
    await expect(reconcileGithub(ctx)).rejects.toThrow('throttled')
    expect(fetch.mock.calls.some(([u]) => String(u).includes('after=c2'))).toBe(false)
    expect(deps.sink.resolve).not.toHaveBeenCalled()
  })

  it('pages GraphQL search and resolves what no longer matches', async () => {
    const { ctx, deps } = setup()
    deps.kv.set('github.active', { 'github.review_requested': ['https://github.com/acme/app/pull/1', 'https://github.com/acme/app/pull/9'] })
    const pr = (n: number) => ({ url: `https://github.com/acme/app/pull/${n}`, number: n, title: `PR ${n}`, repository: { nameWithOwner: 'acme/app' } })
    routeFetch([
      [
        '/graphql',
        (init) => {
          const { variables } = JSON.parse(String(init!.body)) as { variables: { q: string; after: string | null } }
          if (!variables.q.includes('review-requested')) return emptySearch()
          return res(variables.after ? searchPage([pr(2)], 2) : searchPage([pr(1)], 2, 'p2'))
        },
      ],
    ])
    await reconcileGithub(ctx)
    expect(deps.sink.ingest.mock.calls.map(([x]) => x.externalKey)).toEqual([pr(2).url])
    expect(deps.sink.resolve.mock.calls.map(([r]) => r.externalKey)).toEqual([pr(9).url])
  })

  it('treats a search whose count changed while paging as truncated', async () => {
    const { ctx, deps } = setup()
    deps.kv.set('github.active', { 'github.review_requested': ['https://github.com/acme/app/pull/9'] })
    const pr = (n: number) => ({ url: `https://github.com/acme/app/pull/${n}`, number: n, title: `PR ${n}`, repository: { nameWithOwner: 'acme/app' } })
    routeFetch([['/graphql', (init) => res(JSON.parse(String(init!.body)).variables.after ? searchPage([pr(2)], 2) : searchPage([pr(1)], 3, 'p2'))]])
    await reconcileGithub(ctx)
    expect(deps.sink.resolve).not.toHaveBeenCalled()
  })

  it('does not resolve when search hits the result cap', async () => {
    const { ctx, deps } = setup()
    deps.kv.set('github.active', { 'github.review_requested': ['https://github.com/acme/app/pull/9'] })
    routeFetch([['/graphql', () => res(searchPage([], 1500))]])
    await reconcileGithub(ctx)
    expect(deps.sink.resolve).not.toHaveBeenCalled()
  })

  it("covers open issues in selected repositories when scope is 'all' and resolves closed ones", async () => {
    const { ctx, deps, ingested } = setup()
    deps.settings.github.repositories = ['acme/app']
    deps.settings.github.issuesScope = 'all'
    deps.settings.triggers = { ...deps.settings.triggers, 'github.issue': true, 'github.dependabot': false }
    deps.kv.set('github.active', { 'github.issue': ['https://github.com/acme/app/issues/1'] })
    const fetch = routeFetch([
      ['/graphql', emptySearch],
      [
        '/repos/acme/app/issues?',
        () =>
          res([
            { html_url: 'https://github.com/acme/app/issues/2', number: 2, title: 'New', user: { login: 'ana' }, created_at: '2026-10-27T12:00:01Z' },
            { html_url: 'https://github.com/acme/app/issues/4', number: 4, title: 'Old', created_at: '2020-01-01T00:00:00Z' },
            { html_url: 'https://github.com/acme/app/pull/3', number: 3, title: 'PR', pull_request: {}, created_at: '2026-10-27T12:00:01Z' },
          ]),
      ],
    ])
    await reconcileGithub(ctx)
    expect(ingested()).toEqual(['github.issue'])
    expect(deps.sink.ingest.mock.calls[0]![0]).toMatchObject({ externalKey: 'https://github.com/acme/app/issues/2', actor: 'ana' })
    expect(deps.sink.resolve).toHaveBeenCalledWith({ trigger: 'github.issue', externalKey: 'https://github.com/acme/app/issues/1', reason: 'Issue closed' })
    expect(fetch.mock.calls.filter(([, init]) => String(init?.body ?? '').includes('assignee:'))).toHaveLength(0)
    expect(deps.kv.get('github.issuesSince')).toBe('2026-10-27T12:00:00.000Z')
  })

  it("skips repositories with issues disabled in scope 'all'", async () => {
    const { ctx, deps } = setup()
    deps.settings.github.repositories = ['acme/off', 'acme/app']
    deps.settings.github.issuesScope = 'all'
    deps.settings.triggers = { ...deps.settings.triggers, 'github.issue': true, 'github.dependabot': false }
    deps.kv.set('github.active', { 'github.issue': ['https://github.com/acme/app/issues/1'] })
    routeFetch([
      ['/graphql', emptySearch],
      ['/repos/acme/off/issues?', () => res({}, 410)],
      ['/repos/acme/app/issues?', () => res([])],
    ])
    await reconcileGithub(ctx)
    expect(deps.sink.resolve).toHaveBeenCalledWith(expect.objectContaining({ externalKey: 'https://github.com/acme/app/issues/1' }))
  })

  it('resolves active mentions from thread state', async () => {
    const { ctx, deps } = setup()
    const closed = 'https://github.com/acme/app/issues/5'
    deps.kv.set('github.active', { 'github.mention': [closed, 'https://github.com/acme/app/pull/7'] })
    routeFetch([
      ['/graphql', emptySearch],
      ['/issues/5', () => res({ state: 'closed' })],
      ['/issues/7/comments', () => res([{ user: { login: 'ana' }, body: '@lucas ?', created_at: '2026-10-27T10:00:00Z' }])],
      ['/issues/7', () => res({ state: 'open' })],
      ['/pulls/7/comments', () => res([])],
      ['/pulls/7/reviews', () => res([{ user: { login: 'Lucas' }, body: 'done', submitted_at: '2026-10-27T11:00:00Z' }])],
    ])
    await reconcileGithub(ctx)
    expect(deps.sink.resolve.mock.calls.map(([r]) => [r.externalKey, r.reason])).toEqual([
      [closed, 'Issue closed'],
      ['https://github.com/acme/app/pull/7', 'Replied'],
    ])
    expect(deps.kv.get('github.active')).toMatchObject({ 'github.mention': [] })
  })
})

describe('mentionResolution', () => {
  const thread = 'https://github.com/acme/app/issues/3'
  const comments = (...items: object[]) =>
    routeFetch([
      ['/issues/3/comments', () => res(items)],
      ['/issues/3', () => res({ state: 'open' })],
    ])

  it('resolves merged pull requests and threads that are gone', async () => {
    const { ctx } = setup()
    routeFetch([
      ['/issues/7', () => res({ state: 'closed', pull_request: { merged_at: '2026-10-27T10:00:00Z' } })],
      ['/issues/3', () => res({}, 404)],
    ])
    expect(await mentionResolution(ctx, 'lucas', 'https://github.com/acme/app/pull/7')).toBe('Pull request merged')
    expect(await mentionResolution(ctx, 'lucas', thread)).toBe('No longer accessible')
  })

  it('ignores my replies that came before the latest mention', async () => {
    const { ctx } = setup()
    comments({ user: { login: 'lucas' }, body: 'hi', created_at: '2026-10-27T09:00:00Z' }, { user: { login: 'ana' }, body: 'ping @lucas', created_at: '2026-10-27T10:00:00Z' })
    expect(await mentionResolution(ctx, 'lucas', thread)).toBeUndefined()
  })

  it('keeps the card when the mention is no longer visible', async () => {
    const { ctx } = setup()
    comments({ user: { login: 'lucas' }, body: 'hi', created_at: '2026-10-27T09:00:00Z' })
    expect(await mentionResolution(ctx, 'lucas', thread)).toBeUndefined()
  })
})

describe('githubRepositories', () => {
  it('pages installations and their repositories', async () => {
    const { ctx } = setup()
    routeFetch([
      ['installations?page=2', () => res({ installations: [{ id: 2 }] })],
      ['/user/installations?', () => linked({ installations: [{ id: 1 }] }, 'https://api.github.com/user/installations?page=2')],
      ['/installations/1/repositories?page=2', () => res({ repositories: [{ full_name: 'acme/b' }] })],
      ['/installations/1/repositories', () => linked({ repositories: [{ full_name: 'acme/a' }] }, 'https://api.github.com/user/installations/1/repositories?page=2')],
      ['/installations/2/repositories', () => res({ repositories: [{ full_name: 'beta/c' }] })],
    ])
    expect((await githubRepositories(ctx)).map((r) => r.fullName)).toEqual(['acme/a', 'acme/b', 'beta/c'])
  })
})

describe('helpers', () => {
  it('reads the next page from a Link header', () => {
    expect(nextLink(new Headers({ link: '<https://a/1?page=2>; rel="next", <https://a/1?page=5>; rel="last"' }))).toBe('https://a/1?page=2')
    expect(nextLink(new Headers({ link: '<https://a/1?page=1>; rel="prev"' }))).toBeUndefined()
  })

  it('matches @login only as a whole handle', () => {
    expect(mentions('hey @Lucas, look', 'lucas')).toBe(true)
    expect(mentions('@lucas-bot ran', 'lucas')).toBe(false)
    expect(mentions('mail me@lucas.dev', 'lucas')).toBe(false)
  })

  it('derives API URLs from html URLs', () => {
    expect(apiUrlFor('https://github.com/acme/app/pull/7')?.url).toBe('https://api.github.com/repos/acme/app/pulls/7')
    expect(apiUrlFor('https://github.com/acme/app/security/dependabot/2')?.url).toBe('https://api.github.com/repos/acme/app/dependabot/alerts/2')
  })
})
