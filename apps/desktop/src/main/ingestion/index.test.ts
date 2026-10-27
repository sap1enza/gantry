import { WorkerError, type InboxItem, type WorkerClient } from '@gantry/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backoffUntil, createCtx, ThrottledError } from './context'
import { createIngestion, pollInbox } from './index'
import { connectedCtx, fakeDeps, grantFor, NOW, res, routeFetch } from './testing'

afterEach(() => vi.unstubAllGlobals())

const create = (id: string, title: string): InboxItem => ({
  id,
  receivedAt: NOW.toISOString(),
  payload: { kind: 'actionable.create', id: `gen-${id}`, tokenName: 'ci', request: { title, source: { name: 'Honeybadger' }, external_id: title === 'b' ? undefined : `hb-${id}`, auto_start: true } },
})

function workerWith(items: InboxItem[]) {
  return { inbox: vi.fn(async () => ({ items })), ack: vi.fn(async () => undefined), refreshGrant: vi.fn() } satisfies Partial<WorkerClient>
}

describe('pollInbox', () => {
  it('processes items in order, maps API requests, then acks', async () => {
    const worker = workerWith([create('1', 'a'), create('2', 'b'), { id: '3', receivedAt: '', payload: { kind: 'actionable.dismiss', target: 'Honeybadger:hb-1' } }])
    const deps = fakeDeps(worker)
    await pollInbox(createCtx(deps), new Map())
    expect(deps.sink.ingest.mock.calls.map(([s]) => s.externalKey)).toEqual(['Honeybadger:hb-1', 'Honeybadger:gen-2'])
    expect(deps.sink.ingest.mock.calls[0]![0]).toMatchObject({ id: 'gen-1', trigger: 'api.custom', source: { kind: 'api', name: 'Honeybadger' }, autoStart: true, actor: 'ci' })
    expect(deps.sink.dismiss).toHaveBeenCalledWith('Honeybadger:hb-1')
    expect(worker.ack).toHaveBeenCalledWith(['1', '2', '3'])
  })

  it('stops at a failing item and acks only what succeeded', async () => {
    const worker = workerWith([create('1', 'a'), create('2', 'boom'), create('3', 'c')])
    const deps = fakeDeps(worker)
    deps.sink.ingest.mockImplementation((s) => {
      if (s.title === 'boom') throw new Error('db locked')
      return { outcome: 'created' }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failures = new Map<string, number>()
    await pollInbox(createCtx(deps), failures)
    expect(worker.ack).toHaveBeenCalledWith(['1'])
    expect(failures.get('2')).toBe(1)
  })

  it('skips a throttled item without blocking the rest', async () => {
    const throttled: InboxItem = { id: 'gh', receivedAt: '', payload: { kind: 'github.webhook', event: 'check_suite', deliveryId: 'd', payload: { action: 'completed', check_suite: { conclusion: 'failure', pull_requests: [{ url: 'https://api.github.com/repos/a/b/pulls/1' }] } } } }
    const worker = workerWith([throttled, create('2', 'a')])
    const deps = fakeDeps(worker)
    routeFetch([['api.github.com', () => res({}, 429, { 'retry-after': '60' })]])
    await pollInbox(connectedCtx(deps, grantFor('github', { id: '1', login: 'lucas' })), new Map())
    expect(worker.ack).toHaveBeenCalledWith(['2'])
  })

  it('drops a poison item after repeated failures so the queue keeps moving', async () => {
    const worker = workerWith([create('2', 'boom'), create('3', 'c')])
    const deps = fakeDeps(worker)
    deps.sink.ingest.mockImplementation((s) => {
      if (s.title === 'boom') throw new Error('bad')
      return { outcome: 'created' }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await pollInbox(createCtx(deps), new Map([['2', 4]]))
    expect(worker.ack).toHaveBeenCalledWith(['2', '3'])
  })

  it('stores the refreshed grant when a connection arrives', async () => {
    const worker = workerWith([{ id: '1', receivedAt: '', payload: { kind: 'connection', provider: 'github', status: 'connected' } }])
    worker.refreshGrant.mockResolvedValue(grantFor('github', { id: '1', login: 'lucas' }, 'fresh'))
    const deps = fakeDeps(worker)
    const ingestion = createIngestion(deps)
    await pollInbox(createCtx(deps), new Map())
    expect(JSON.parse(deps.secrets.get('grant.github')!).accessToken).toBe('fresh')
    expect(ingestion.connections()[0]).toMatchObject({ provider: 'github', status: 'connected', account: { login: 'lucas' } })
    expect(deps.sink.logConnection).toHaveBeenCalledWith('github', 'connected', undefined)
  })
})

describe('tokens and rate limits', () => {
  it('refreshes the token and retries once on 401', async () => {
    const worker = workerWith([])
    worker.refreshGrant.mockResolvedValue(grantFor('github', { id: '1', login: 'lucas' }, 'new'))
    const deps = fakeDeps(worker)
    const ctx = connectedCtx(deps, grantFor('github', { id: '1', login: 'lucas' }, 'old'))
    const fetch = routeFetch([['/user', (init) => ((init?.headers as Record<string, string>).authorization === 'Bearer new' ? res({ ok: 1 }) : res({}, 401))]])
    expect(await ctx.json('github', 'https://api.github.com/user')).toEqual({ ok: 1 })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(worker.refreshGrant).toHaveBeenCalledWith('github', { force: true })
  })

  it('marks reconnect_required when the force-refreshed token is still rejected', async () => {
    const worker = workerWith([])
    worker.refreshGrant.mockResolvedValue(grantFor('github', { id: '1', login: 'lucas' }, 'new'))
    const deps = fakeDeps(worker)
    const ctx = connectedCtx(deps, grantFor('github', { id: '1', login: 'lucas' }, 'old', new Date(NOW.getTime() + 3_600_000).toISOString()))
    const fetch = routeFetch([['/user', () => res({}, 401)]])
    await expect(ctx.json('github', 'https://api.github.com/user')).rejects.toThrow('token rejected')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(worker.refreshGrant).toHaveBeenCalledTimes(1)
    expect(ctx.connectionState().github?.status).toBe('reconnect_required')
  })

  it('shares one in-flight refresh between concurrent callers', async () => {
    const worker = workerWith([])
    worker.refreshGrant.mockResolvedValue(grantFor('github', { id: '1', login: 'lucas' }, 'new'))
    const ctx = createCtx(fakeDeps(worker))
    await Promise.all([ctx.refresh('github'), ctx.refresh('github')])
    expect(worker.refreshGrant).toHaveBeenCalledTimes(1)
  })

  it('refreshes before expiry', async () => {
    const worker = workerWith([])
    worker.refreshGrant.mockResolvedValue(grantFor('google', { id: 'g', login: 'me' }, 'new'))
    const deps = fakeDeps(worker)
    const ctx = connectedCtx(deps, grantFor('google', { id: 'g', login: 'me' }, 'old', new Date(NOW.getTime() + 60_000).toISOString()))
    routeFetch([['gmail', () => res({})]])
    await ctx.json('google', 'https://gmail.googleapis.com/x')
    expect(worker.refreshGrant).toHaveBeenCalledWith('google', { force: false })
  })

  it('marks reconnect_required when refresh is rejected', async () => {
    const worker = workerWith([])
    worker.refreshGrant.mockRejectedValue(new WorkerError(404, 'no grant'))
    const deps = fakeDeps(worker)
    const ctx = connectedCtx(deps, grantFor('slack', { id: 'U1', login: 'lucas' }))
    routeFetch([['slack.com', () => res({ ok: false, error: 'token_revoked' })]])
    await expect(ctx.json('slack', 'https://slack.com/api/auth.test')).rejects.toThrow('reconnect required')
    expect(ctx.connectionState().slack?.status).toBe('reconnect_required')
  })

  it('decides when to back off', () => {
    const now = NOW.getTime()
    const headers = (h: Record<string, string>, status = 200) => new Response(null, { status, headers: h })
    expect(backoffUntil(headers({ 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1' }), now)).toBeUndefined()
    expect(backoffUntil(headers({ 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1800000000' }), now)).toBe(1_800_000_000_000)
    expect(backoffUntil(headers({ 'retry-after': '30' }, 429), now)).toBe(now + 30_000)
    expect(backoffUntil(headers({ 'retry-after': '60' }, 403), now)).toBe(now + 60_000)
    expect(backoffUntil(headers({}, 429), now)).toBe(now + 60_000)
  })

  it('throttles subsequent calls and logs once', async () => {
    const deps = fakeDeps()
    const ctx = connectedCtx(deps, grantFor('github', { id: '1', login: 'lucas' }))
    const fetch = routeFetch([['api.github.com', () => res({}, 403, { 'retry-after': '60' })]])
    await expect(ctx.json('github', 'https://api.github.com/a')).rejects.toBeInstanceOf(ThrottledError)
    await expect(ctx.json('github', 'https://api.github.com/b')).rejects.toBeInstanceOf(ThrottledError)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(deps.sink.logConnection.mock.calls.filter(([, s]) => s === 'throttled')).toHaveLength(1)
  })

  it('logs ignored:llm when the gate has no API key', async () => {
    const deps = fakeDeps()
    const ctx = createCtx(deps)
    await ctx.emit({ trigger: 'email.new', source: { kind: 'email', name: 'Gmail' }, externalKey: 't', title: 'x', occurredAt: '' }, { llm: { instruction: 'i', content: 'c' } })
    expect(deps.sink.logIgnored.mock.calls[0]![1]).toBe('ignored:llm')
    expect(deps.sink.ingest).not.toHaveBeenCalled()
  })
})

describe('createIngestion', () => {
  it('opens the worker OAuth start URL on connect and revokes on disconnect', async () => {
    const worker = { oauthStartUrl: vi.fn(async () => 'https://worker/oauth/slack/start?x'), revokeGrant: vi.fn(async () => undefined) }
    const deps = fakeDeps(worker)
    deps.secrets.set('grant.slack', JSON.stringify(grantFor('slack', { id: 'U1', login: 'l' })))
    deps.kv.set('slack.pending', [])
    const ingestion = createIngestion(deps)
    await ingestion.connect('slack')
    expect(deps.openExternal).toHaveBeenCalledWith('https://worker/oauth/slack/start?x')
    await ingestion.disconnect('slack')
    expect(worker.revokeGrant).toHaveBeenCalledWith('slack')
    expect(deps.secrets.get('grant.slack')).toBeUndefined()
    expect(deps.kv.get('slack.pending')).toBeUndefined()
    expect(ingestion.connections()[1]).toMatchObject({ provider: 'slack', status: 'disconnected' })
    expect(deps.sink.markSourceDisconnected).toHaveBeenCalledWith('slack')
  })

  it('marks Google cards as email source disconnected', async () => {
    const deps = fakeDeps({ revokeGrant: vi.fn(async () => undefined) })
    await createIngestion(deps).disconnect('google')
    expect(deps.sink.markSourceDisconnected).toHaveBeenCalledWith('email')
  })
})
