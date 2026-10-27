import type { DeviceRegistration, InboxResponse, MeResponse } from '@gantry/shared'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import init from '../migrations/0001_init.sql?raw'
import completionCodes from '../migrations/0002_completion_codes.sql?raw'
import webhookDeliveries from '../migrations/0003_webhook_deliveries.sql?raw'
import { createApp } from './app'
import { hmacSha256Hex } from './crypto'
import type { Env } from './env'
import { deleteExpired, updateGrantTokens } from './store'

let mf: Miniflare
let env: Env
const fetchMock = vi.fn<typeof fetch>()
const app = createApp(fetchMock)

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const call = (path: string, init: RequestInit & { auth?: string } = {}) =>
  app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(init.auth ? { authorization: init.auth } : {}), ...init.headers } }, env)

async function registerDevice() {
  const reg = (await (await call('/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'Ada' }) })).json()) as DeviceRegistration
  return { ...reg, auth: `Device ${reg.deviceId}:${reg.deviceSecret}` }
}

async function createToken(auth: string) {
  const res = await call('/v1/tokens', { method: 'POST', auth, body: JSON.stringify({ name: 'Honeybadger' }) })
  return (await res.json()) as { id: string; token: string }
}

const inbox = async (auth: string) => ((await (await call('/v1/inbox', { auth })).json()) as InboxResponse).items
const routingKeys = async (userId: string) =>
  JSON.parse((await env.DB.prepare("SELECT routing_keys FROM grants WHERE user_id = ? AND provider = 'github'").bind(userId).first<string>('routing_keys'))!) as string[]
const me = async (auth: string) => (await (await call('/v1/me', { auth })).json()) as MeResponse

function mockGithubOAuth(account = { id: 7, login: 'ada' }, tokenOverrides: Record<string, unknown> = {}, installations = [{ id: 42 }]) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url.startsWith('https://github.com/login/oauth/access_token'))
      return json({ access_token: 'gho_access', refresh_token: 'ghr_refresh', expires_in: 28800, ...tokenOverrides })
    if (url === 'https://api.github.com/user') return json({ ...account, avatar_url: 'https://avatars/x' })
    if (url.startsWith('https://api.github.com/user/installations?')) {
      const page = Number(new URL(url).searchParams.get('page'))
      return json({ installations: installations.slice((page - 1) * 100, page * 100) })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
}

async function authorize(auth: string, provider: string) {
  const { url } = (await (await call(`/oauth/${provider}/start`, { method: 'POST', auth })).json()) as { url: string }
  const state = new URL(url).searchParams.get('state')
  return call(`/oauth/${provider}/callback?code=abc&state=${state}`)
}

const completionCode = async (page: Response) => /<code id="code">([^<]+)</.exec(await page.text())![1]!
const complete = (auth: string, code: string) => call('/auth/complete', { method: 'POST', auth, body: JSON.stringify({ code }) })

async function magicLink(auth: string) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await call('/auth/email', { method: 'POST', auth, body: JSON.stringify({ email: 'Ada@Example.com' }) })
  const link = /(https:\S+)/.exec(String(log.mock.lastCall![0]))![1]!
  log.mockRestore()
  return link.replace('https://api.test', '')
}

const connect = async (auth: string, provider: string) => complete(auth, await completionCode(await authorize(auth, provider)))

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {}', d1Databases: ['DB'] }))
  const DB = await mf.getD1Database('DB')
  await DB.batch(
    [init, completionCodes, webhookDeliveries]
      .join(';')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => DB.prepare(s)),
  )
  env = {
    DB,
    PUBLIC_URL: 'https://api.test',
    EMAIL_FROM: 'Gantry <login@gantry.test>',
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    GITHUB_CLIENT_ID: 'gh-id',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    GITHUB_WEBHOOK_SECRET: 'gh-hook',
    SLACK_CLIENT_ID: 'sl-id',
    SLACK_CLIENT_SECRET: 'sl-secret',
    SLACK_SIGNING_SECRET: 'sl-sign',
    GOOGLE_CLIENT_ID: 'go-id',
    GOOGLE_CLIENT_SECRET: 'go-secret',
  }
}, 30_000)

afterAll(() => mf.dispose())

beforeEach(async () => {
  fetchMock.mockReset()
  await env.DB.batch(
    ['inbox', 'webhook_deliveries', 'grants', 'api_tokens', 'completion_codes', 'devices', 'oauth_states', 'email_links', 'rate_limits', 'users'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  )
})

describe('auth', () => {
  it('rejects missing, malformed and wrong device credentials', async () => {
    const { deviceId } = await registerDevice()
    expect((await call('/v1/inbox')).status).toBe(401)
    expect((await call('/v1/inbox', { auth: 'Device nope' })).status).toBe(401)
    expect((await call('/v1/inbox', { auth: `Device ${deviceId}:wrong` })).status).toBe(401)
  })

  it('rejects unknown bearer tokens', async () => {
    const res = await call('/v1/actionables', { method: 'POST', auth: 'Bearer gtry_nope', body: JSON.stringify({ title: 'x' }) })
    expect(res.status).toBe(401)
  })

  it('rejects revoked tokens', async () => {
    const { auth } = await registerDevice()
    const { id, token } = await createToken(auth)
    expect((await call(`/v1/tokens/${id}`, { method: 'DELETE', auth })).status).toBe(204)
    const res = await call('/v1/actionables', { method: 'POST', auth: `Bearer ${token}`, body: JSON.stringify({ title: 'x' }) })
    expect(res.status).toBe(401)
    const [info] = (await (await call('/v1/tokens', { auth })).json()) as { revokedAt?: string; lastFour: string }[]
    expect(info!.revokedAt).toBeDefined()
    expect(token.endsWith(info!.lastFour)).toBe(true)
  })
})

describe('actionables API', () => {
  it('validates, enqueues, and serves the inbox until acked', async () => {
    const { auth } = await registerDevice()
    const { token } = await createToken(auth)
    const bearer = `Bearer ${token}`

    const invalid = await call('/v1/actionables', { method: 'POST', auth: bearer, body: JSON.stringify({ title: '', priority: 'meh' }) })
    expect(invalid.status).toBe(400)

    const request = { title: 'Fix checkout', source: { name: 'Honeybadger' }, external_id: 'hb-1', priority: 'high' }
    const created = await call('/v1/actionables', { method: 'POST', auth: bearer, body: JSON.stringify(request) })
    expect(created.status).toBe(201)
    const { id, url } = (await created.json()) as { id: string; url: string }
    expect(url).toBe(`gantry://actionable/${id}`)

    await call('/v1/actionables/Honeybadger:hb-1', { method: 'PATCH', auth: bearer, body: JSON.stringify({ tags: ['prod'] }) })
    await call('/v1/actionables/Honeybadger:hb-1/dismiss', { method: 'POST', auth: bearer })

    const items = await inbox(auth)
    expect(items.map((i) => i.payload)).toEqual([
      { kind: 'actionable.create', id, tokenName: 'Honeybadger', request },
      { kind: 'actionable.update', target: 'Honeybadger:hb-1', patch: { tags: ['prod'] } },
      { kind: 'actionable.dismiss', target: 'Honeybadger:hb-1' },
    ])

    expect((await call('/v1/inbox/ack', { method: 'POST', auth, body: JSON.stringify({ ids: items.map((i) => i.id) }) })).status).toBe(204)
    expect(await inbox(auth)).toEqual([])
  })

  it('enqueues a sample test actionable for the device', async () => {
    const { auth } = await registerDevice()
    expect((await call('/v1/test-actionable', { method: 'POST', auth })).status).toBe(201)
    expect((await inbox(auth))[0]!.payload).toMatchObject({ kind: 'actionable.create', tokenName: 'Test' })
  })
})

describe('hardening', () => {
  it('returns 429 with Retry-After once the per-minute limit is spent', async () => {
    const { auth, deviceId } = await registerDevice()
    await env.DB.prepare('INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 59)').bind(`device:${deviceId}`, Math.floor(Date.now() / 60_000)).run()
    expect((await call('/v1/inbox', { auth })).status).toBe(200)
    const limited = await call('/v1/inbox', { auth })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('limits device registrations to 10 per hour per IP', async () => {
    const register = (ip: string) => call('/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'x' }), headers: { 'cf-connecting-ip': ip } })
    for (let i = 0; i < 10; i++) expect((await register('1.1.1.1')).status).toBe(201)
    const limited = await register('1.1.1.1')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await register('2.2.2.2')).status).toBe(201)
  })

  it('caps the inbox response near 4 MB but always returns one item', async () => {
    const { auth, userId } = await registerDevice()
    const insert = (id: string, size: number) =>
      env.DB.prepare("INSERT INTO inbox (id, user_id, payload, received_at, expires_at) VALUES (?, ?, ?, ?, '2999-01-01')")
        .bind(id, userId, JSON.stringify({ kind: 'slack.event', payload: { blob: 'a'.repeat(size) } }), `2026-01-01T00:00:0${id}`)
        .run()
    for (const id of ['1', '2', '3', '4']) await insert(id, 1_100_000)
    expect((await inbox(auth)).map((i) => i.id)).toEqual(['1', '2', '3'])
    await env.DB.prepare("DELETE FROM inbox WHERE id IN ('1', '2', '3')").run()
    await insert('0', 1_000)
    expect((await inbox(auth)).map((i) => i.id)).toEqual(['0', '4'])
  })

  it('rejects bodies over 64 KB with 413', async () => {
    const { auth } = await registerDevice()
    const { token } = await createToken(auth)
    const res = await call('/v1/actionables', { method: 'POST', auth: `Bearer ${token}`, body: JSON.stringify({ title: 'x', body: 'a'.repeat(65 * 1024) }) })
    expect(res.status).toBe(413)
  })

  it('allows webhook bodies over 64 KB', async () => {
    const body = JSON.stringify({ installation: { id: 1 }, blob: 'a'.repeat(100 * 1024) })
    const res = await call('/webhooks/github', { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${await hmacSha256Hex('gh-hook', body)}` } })
    expect(res.status).toBe(200)
  })

  it('scheduled cleanup deletes expired inbox items and completion codes', async () => {
    const { auth, userId, deviceId } = await registerDevice()
    await env.DB.prepare("INSERT INTO inbox (id, user_id, payload, received_at, expires_at) VALUES ('old', ?, '{}', '2000-01-01', '2000-01-31')").bind(userId).run()
    await env.DB.prepare("INSERT INTO completion_codes (code_hash, device_id, payload, expires_at) VALUES ('old', ?, '', '2000-01-01')").bind(deviceId).run()
    await deleteExpired(env.DB)
    expect(await env.DB.prepare("SELECT id FROM inbox WHERE id = 'old'").first()).toBeNull()
    expect(await env.DB.prepare('SELECT 1 FROM completion_codes').first()).toBeNull()
    expect(await inbox(auth)).toEqual([])
  })
})

describe('oauth', () => {
  it('stores an encrypted grant and enqueues a connection item', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth()
    const res = await connect(auth, 'github')
    expect(await res.json()).toEqual({ kind: 'grant', provider: 'github' })
    const stored = await env.DB.prepare('SELECT access_token FROM grants').first<{ access_token: string }>()
    expect(stored!.access_token).not.toContain('gho_access')
    expect((await inbox(auth))[0]!.payload).toMatchObject({ kind: 'connection', provider: 'github', status: 'connected', account: { login: 'ada' } })
    expect((await me(auth)).grants).toEqual([{ provider: 'github', account: expect.objectContaining({ id: '7' }), status: 'connected' }])
  })

  it('rejects a reused state', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth()
    const { url } = (await (await call('/oauth/github/start', { method: 'POST', auth })).json()) as { url: string }
    const state = new URL(url).searchParams.get('state')
    expect((await call(`/oauth/github/callback?code=a&state=${state}`)).status).toBe(200)
    expect((await call(`/oauth/github/callback?code=a&state=${state}`)).status).toBe(400)
  })

  it('github_signin merges a second device into the existing user with the same GitHub id', async () => {
    const first = await registerDevice()
    const second = await registerDevice()
    mockGithubOAuth()
    await connect(first.auth, 'github_signin')
    await connect(second.auth, 'github_signin')
    const merged = await me(second.auth)
    expect(merged.userId).toBe(first.userId)
    expect(merged).toMatchObject({ githubLogin: 'ada', signedIn: true })
  })

  it('merging keeps the email of the merged-away user', async () => {
    const first = await registerDevice()
    const second = await registerDevice()
    await env.DB.prepare("UPDATE users SET email = 'b@x.test' WHERE id = ?").bind(second.userId).run()
    mockGithubOAuth()
    await connect(first.auth, 'github_signin')
    await connect(second.auth, 'github_signin')
    expect(await me(first.auth)).toMatchObject({ email: 'b@x.test', githubLogin: 'ada' })
  })

  it('returns the stored token while it is fresh', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth()
    await connect(auth, 'github')
    const res = await call('/v1/grants/github/refresh', { method: 'POST', auth })
    expect(await res.json()).toMatchObject({ provider: 'github', accessToken: 'gho_access' })
  })

  it('force refreshes a fresh token', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth()
    await connect(auth, 'github')
    fetchMock.mockResolvedValueOnce(json({ access_token: 'gho_forced', refresh_token: 'ghr_new', expires_in: 28800 }))
    const res = await call('/v1/grants/github/refresh?force=1', { method: 'POST', auth })
    expect(await res.json()).toMatchObject({ accessToken: 'gho_forced' })
  })

  it('marks the grant reconnect_required when a forced refresh has no refresh token', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth(undefined, { refresh_token: undefined, expires_in: undefined })
    await connect(auth, 'github')
    expect((await call('/v1/grants/github/refresh?force=1', { method: 'POST', auth })).status).toBe(409)
    expect((await me(auth)).grants[0]!.status).toBe('reconnect_required')
  })

  it('requests search and conversation read scopes in the Slack user scopes', async () => {
    const { auth } = await registerDevice()
    const { url } = (await (await call('/oauth/slack/start', { method: 'POST', auth })).json()) as { url: string }
    expect(new URL(url).searchParams.get('user_scope')!.split(',')).toEqual(
      expect.arrayContaining(['search:read', 'channels:read', 'groups:read', 'im:read', 'mpim:read']),
    )
  })

  it('routes every page of the user installations to a new GitHub grant', async () => {
    const { auth, userId } = await registerDevice()
    mockGithubOAuth(undefined, {}, Array.from({ length: 101 }, (_, i) => ({ id: i + 1 })))
    await connect(auth, 'github')
    const keys = await routingKeys(userId)
    expect(keys).toHaveLength(102)
    expect(keys).toEqual(expect.arrayContaining(['user:7', 'installation:1', 'installation:101']))
  })

  it('re-lists installations when the GitHub token refreshes', async () => {
    const { auth, userId } = await registerDevice()
    mockGithubOAuth()
    await connect(auth, 'github')
    mockGithubOAuth(undefined, {}, [{ id: 42 }, { id: 77 }])
    await call('/v1/grants/github/refresh?force=1', { method: 'POST', auth })
    expect(await routingKeys(userId)).toEqual(['user:7', 'installation:42', 'installation:77'])
  })

  it('refreshes a token that is near expiry without exposing the refresh token', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth(undefined, { expires_in: 60 })
    await connect(auth, 'github')
    fetchMock.mockResolvedValueOnce(json({ access_token: 'gho_new', refresh_token: 'ghr_new', expires_in: 28800 }))
    const body = (await (await call('/v1/grants/github/refresh', { method: 'POST', auth })).json()) as Record<string, unknown>
    expect(body.accessToken).toBe('gho_new')
    expect(JSON.stringify(body)).not.toContain('ghr_')
    const refreshCall = fetchMock.mock.calls.findLast(([url]) => String(url).startsWith('https://github.com/login/oauth/access_token'))!
    expect(new URLSearchParams(String(refreshCall[1]!.body)).get('refresh_token')).toBe('ghr_refresh')
  })

  it('marks the grant reconnect_required when refresh fails', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth(undefined, { expires_in: 60 })
    await connect(auth, 'github')
    fetchMock.mockResolvedValueOnce(json({ error: 'bad_refresh_token' }))
    expect((await call('/v1/grants/github/refresh', { method: 'POST', auth })).status).toBe(409)
    expect((await me(auth)).grants[0]!.status).toBe('reconnect_required')
    expect((await inbox(auth)).at(-1)!.payload).toMatchObject({ kind: 'connection', provider: 'github', status: 'reconnect_required' })
  })

  it('keeps the grant connected when the provider is temporarily unavailable', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth(undefined, { expires_in: 60 })
    await connect(auth, 'github')
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }))
    expect((await call('/v1/grants/github/refresh', { method: 'POST', auth })).status).toBe(502)
    expect((await me(auth)).grants[0]!.status).toBe('connected')
  })

  it('returns the rotated token when a concurrent refresh already used the refresh token', async () => {
    const { auth, userId } = await registerDevice()
    mockGithubOAuth(undefined, { expires_in: 60 })
    await connect(auth, 'github')
    fetchMock.mockImplementationOnce(async () => {
      await updateGrantTokens(env, userId, 'github', { accessToken: 'gho_other', refreshToken: 'ghr_other', scopes: [] })
      return json({ error: 'bad_refresh_token' })
    })
    const res = await call('/v1/grants/github/refresh', { method: 'POST', auth })
    expect(await res.json()).toMatchObject({ accessToken: 'gho_other' })
    expect((await me(auth)).grants[0]!.status).toBe('connected')
  })

  it('DELETE /v1/me revokes grants at the provider and wipes the user', async () => {
    const { auth, userId } = await registerDevice()
    mockGithubOAuth()
    await connect(auth, 'github')
    await createToken(auth)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect((await call('/v1/me', { method: 'DELETE', auth })).status).toBe(204)
    expect(String(fetchMock.mock.lastCall![0])).toBe('https://api.github.com/applications/gh-id/grant')
    for (const table of ['grants', 'api_tokens', 'inbox', 'devices']) {
      expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE user_id = ?`).bind(userId).first()).toBeNull()
    }
    expect((await call('/v1/me', { auth })).status).toBe(401)
  })
})

describe('auth completion', () => {
  it('defers the grant until the initiating device redeems the code once', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth()
    const page = await authorize(auth, 'github')
    const html = await page.clone().text()
    const code = await completionCode(page)
    expect(html).toContain(`url=gantry://auth/complete?code=${code}`)
    expect(await env.DB.prepare('SELECT 1 FROM grants').first()).toBeNull()
    expect(await env.DB.prepare('SELECT code_hash FROM completion_codes').first('code_hash')).not.toBe(code)
    expect(await inbox(auth)).toEqual([])

    expect(await (await complete(auth, code)).json()).toEqual({ kind: 'grant', provider: 'github' })
    expect((await inbox(auth))[0]!.payload).toMatchObject({ kind: 'connection', provider: 'github', status: 'connected' })
    expect((await complete(auth, code)).status).toBe(400)
  })

  it('rejects a code redeemed by another device without granting either', async () => {
    const initiator = await registerDevice()
    const victim = await registerDevice()
    mockGithubOAuth()
    const code = await completionCode(await authorize(initiator.auth, 'github'))
    const res = await complete(victim.auth, code)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_code' })
    expect((await me(victim.auth)).grants).toEqual([])
    expect((await complete(initiator.auth, code)).status).toBe(400)
  })

  it('rejects an expired code', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth()
    const code = await completionCode(await authorize(auth, 'github'))
    await env.DB.prepare("UPDATE completion_codes SET expires_at = '2000-01-01'").run()
    expect(await (await complete(auth, code)).json()).toEqual({ error: 'invalid_code' })
  })

  it('rejects a magic link code redeemed by another device', async () => {
    const { auth } = await registerDevice()
    const other = await registerDevice()
    const path = await magicLink(auth)
    const code = await completionCode(await call(path))
    expect((await call(path)).status).toBe(400)
    expect(await me(auth)).toMatchObject({ signedIn: false })
    expect((await complete(other.auth, code)).status).toBe(400)
    expect(await me(other.auth)).toMatchObject({ signedIn: false })
  })

  it('signs in the initiating device with a magic link code once', async () => {
    const { auth } = await registerDevice()
    const code = await completionCode(await call(await magicLink(auth)))
    expect(await (await complete(auth, code)).json()).toEqual({ kind: 'signin' })
    expect(await me(auth)).toMatchObject({ email: 'ada@example.com', signedIn: true })
    expect((await complete(auth, code)).status).toBe(400)
  })
})

describe('github webhook', () => {
  const deliver = async (body: string, signature: string, event = 'check_suite') =>
    call('/webhooks/github', { method: 'POST', body, headers: { 'x-hub-signature-256': signature, 'x-github-event': event, 'x-github-delivery': 'd-1' } })

  it('routes signed events to users whose grant covers the installation', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth()
    await connect(auth, 'github')
    const body = JSON.stringify({ action: 'completed', installation: { id: 42 } })
    const res = await deliver(body, `sha256=${await hmacSha256Hex('gh-hook', body)}`)
    expect(await res.json()).toEqual({ delivered: 1 })
    expect((await inbox(auth)).at(-1)!.payload).toEqual({ kind: 'github.webhook', event: 'check_suite', deliveryId: 'd-1', payload: JSON.parse(body) })
  })

  it('adds new installations to the grant of the installing user', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth()
    await connect(auth, 'github')
    const install = JSON.stringify({ action: 'created', installation: { id: 99 }, sender: { id: 7 } })
    expect(await (await deliver(install, `sha256=${await hmacSha256Hex('gh-hook', install)}`, 'installation')).json()).toEqual({ delivered: 1 })
  })

  it('routes an org installation by another sender to members who can access it', async () => {
    const { auth, userId } = await registerDevice()
    mockGithubOAuth()
    await connect(auth, 'github')
    mockGithubOAuth(undefined, {}, [{ id: 42 }, { id: 99 }])
    const install = JSON.stringify({ action: 'added', installation: { id: 99 }, sender: { id: 1 } })
    await deliver(install, `sha256=${await hmacSha256Hex('gh-hook', install)}`, 'installation_repositories')
    expect(await routingKeys(userId)).toContain('installation:99')
  })

  it('ignores a delivery id it already enqueued', async () => {
    const { auth } = await registerDevice()
    mockGithubOAuth()
    await connect(auth, 'github')
    const body = JSON.stringify({ action: 'completed', installation: { id: 42 } })
    const signature = `sha256=${await hmacSha256Hex('gh-hook', body)}`
    expect(await (await deliver(body, signature)).json()).toEqual({ delivered: 1 })
    expect(await (await deliver(body, signature)).json()).toEqual({ delivered: 0 })
    expect((await inbox(auth)).filter((i) => i.payload.kind === 'github.webhook')).toHaveLength(1)
  })

  it('rejects a signed non-JSON body with 400', async () => {
    expect((await deliver('payload=x', `sha256=${await hmacSha256Hex('gh-hook', 'payload=x')}`)).status).toBe(400)
  })

  it('rejects a bad signature', async () => {
    const body = JSON.stringify({ installation: { id: 42 } })
    expect((await deliver(body, `sha256=${await hmacSha256Hex('wrong', body)}`)).status).toBe(401)
    expect((await deliver(body, '')).status).toBe(401)
  })
})

describe('slack webhook', () => {
  const send = async (payload: unknown, { secret = 'sl-sign', ts = Math.floor(Date.now() / 1000) } = {}) => {
    const body = JSON.stringify(payload)
    const signature = `v0=${await hmacSha256Hex(secret, `v0:${ts}:${body}`)}`
    return call('/webhooks/slack', { method: 'POST', body, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': signature } })
  }

  async function connectSlack(auth: string) {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === 'https://slack.com/api/oauth.v2.access')
        return json({ ok: true, team: { id: 'T1', name: 'Acme' }, authed_user: { id: 'U1', access_token: 'xoxp-1', scope: 'im:history,users:read' } })
      if (url.startsWith('https://slack.com/api/users.info')) return json({ ok: true, user: { name: 'ada', real_name: 'Ada' } })
      throw new Error(`unexpected fetch ${url}`)
    })
    await connect(auth, 'slack')
  }

  it('answers url_verification', async () => {
    expect(await (await send({ type: 'url_verification', challenge: 'c-1' })).json()).toEqual({ challenge: 'c-1' })
  })

  it('routes signed events by authorization team and user', async () => {
    const { auth } = await registerDevice()
    await connectSlack(auth)
    const payload = { type: 'event_callback', authorizations: [{ team_id: 'T1', user_id: 'U1' }], event: { type: 'message', text: 'hi <@U1>' } }
    expect(await (await send(payload)).json()).toEqual({ delivered: 1 })
    expect((await inbox(auth)).at(-1)!.payload).toEqual({ kind: 'slack.event', payload })
  })

  it('ignores a retried event_id', async () => {
    const { auth } = await registerDevice()
    await connectSlack(auth)
    const payload = { type: 'event_callback', event_id: 'Ev1', authorizations: [{ team_id: 'T1', user_id: 'U1' }], event: { type: 'message' } }
    expect(await (await send(payload)).json()).toEqual({ delivered: 1 })
    expect(await (await send(payload)).json()).toEqual({ delivered: 0 })
    expect((await inbox(auth)).filter((i) => i.payload.kind === 'slack.event')).toHaveLength(1)
  })

  it('rejects a bad signature', async () => {
    expect((await send({ type: 'url_verification', challenge: 'x' }, { secret: 'wrong' })).status).toBe(401)
  })

  it('rejects a replayed request older than 5 minutes', async () => {
    expect((await send({ type: 'url_verification', challenge: 'x' }, { ts: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401)
  })
})
