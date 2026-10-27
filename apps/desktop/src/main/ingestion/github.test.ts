import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyReconciliation, apiUrlFor, currentFromSearch, githubWebhook, mentions, reconcileGithub } from './github'
import { connectedCtx, fakeDeps, grantFor, res, routeFetch } from './testing'

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

describe('reconciliation', () => {
  const node = (n: number, over: object = {}) => ({ url: `https://github.com/acme/app/pull/${n}`, number: n, title: `PR ${n}`, repository: { nameWithOwner: 'acme/app' }, ...over })
  const rollup = (state: string) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } })

  it('maps search state to current entities, keeping pending ones that were active', () => {
    const { ctx } = setup()
    const current = currentFromSearch(
      ctx,
      {
        authored: { nodes: [node(1, rollup('FAILURE')), node(2, rollup('PENDING')), node(3, { ...rollup('PENDING'), mergeable: 'CONFLICTING' }), node(4, { reviewDecision: 'CHANGES_REQUESTED' })] },
        review: { nodes: [node(5)] },
        issues: { nodes: [] },
      },
      { 'github.ci_failed': [node(2).url] },
    )
    expect([...current['github.ci_failed']!.keys()]).toEqual([node(1).url, node(2).url])
    expect([...current['github.merge_conflict']!.keys()]).toEqual([node(3).url])
    expect([...current['github.changes_requested']!.keys()]).toEqual([node(4).url])
    expect([...current['github.review_requested']!.keys()]).toEqual([node(5).url])
  })

  it('backfills new entities and resolves ones that no longer match', async () => {
    const { ctx, deps, ingested } = setup()
    deps.kv.set('github.active', { 'github.ci_failed': ['A', 'B'] })
    const s = (key: string) => ({ trigger: 'github.ci_failed' as const, source: { kind: 'github' as const, name: 'GitHub' }, externalKey: key, title: key, occurredAt: '' })
    await applyReconciliation(ctx, { 'github.ci_failed': new Map([['A', s('A')], ['C', s('C')]]) })
    expect(ingested()).toEqual(['github.ci_failed'])
    expect(deps.sink.ingest.mock.calls[0]![0].externalKey).toBe('C')
    expect(deps.sink.resolve).toHaveBeenCalledWith({ trigger: 'github.ci_failed', externalKey: 'B', reason: 'Checks passing or pull request closed' })
    expect(deps.kv.get('github.active')).toEqual({ 'github.ci_failed': ['A', 'C'] })
  })
})

describe('reconcileGithub', () => {
  it('keeps dependabot alerts active when fetching them fails', async () => {
    const { ctx, deps } = setup()
    deps.settings.github.repositories = ['acme/app']
    deps.kv.set('github.active', { 'github.dependabot': ['https://github.com/acme/app/security/dependabot/1'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const empty = { nodes: [] }
    routeFetch([
      ['/graphql', () => res({ data: { authored: empty, review: empty, issues: empty } })],
      ['/dependabot/alerts', () => res({}, 500)],
    ])
    await reconcileGithub(ctx)
    expect(deps.sink.resolve).not.toHaveBeenCalled()
  })
})

describe('helpers', () => {
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
