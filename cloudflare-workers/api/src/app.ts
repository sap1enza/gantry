import {
  createActionableSchema,
  DEEP_LINKS,
  patchActionableSchema,
  type ApiTokenInfo,
  type AuthCompletion,
  type CreateActionableRequest,
  type CreatedApiToken,
  type DeviceRegistration,
  type GrantAccount,
  type GrantTokenResponse,
  type InboxPayload,
  type MeResponse,
  type OAuthProvider,
} from '@gantry/shared'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { validator } from 'hono/validator'
import { z } from 'zod'
import { decrypt, encrypt, hmacSha256Hex, randomToken, sha256, timingSafeEqual } from './crypto'
import type { AppEnv } from './env'
import {
  authorizeUrl,
  exchangeCode,
  GRANT_PROVIDERS,
  OAuthRejected,
  OAUTH_PROVIDERS,
  refreshTokens,
  revokeGrant,
  type ExchangeResult,
  type OAuthStartProvider,
} from './oauth'
import {
  addRoutingKey,
  decryptGrant,
  deleteUser,
  enqueue,
  findUsersByRoutingKey,
  getGrant,
  hitRateLimit,
  mergeUsers,
  now,
  type GrantRow,
  saveGrant,
  updateGrantTokens,
} from './store'

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const EMAIL_LINK_TTL_MS = 15 * 60 * 1000
const COMPLETION_CODE_TTL_MS = 10 * 60 * 1000
const REFRESH_SKEW_MS = 5 * 60 * 1000
const SLACK_REPLAY_WINDOW_S = 5 * 60
const EMAIL_SENDS_PER_MINUTE = 5
const API_BODY_LIMIT = 64 * 1024
const WEBHOOK_BODY_LIMIT = 1024 * 1024

const nameSchema = z.object({ name: z.string().trim().min(1).max(100) })
const ackSchema = z.object({ ids: z.array(z.string()).max(1000) })
const emailSchema = z.object({ email: z.email().max(254) })
const completeSchema = z.object({ code: z.string().trim().min(1).max(128) })

type PendingAuth =
  | { kind: 'grant'; provider: OAuthProvider; result: ExchangeResult }
  | { kind: 'github_signin'; account: GrantAccount }
  | { kind: 'email'; email: string }

const SAMPLE_ACTIONABLE: CreateActionableRequest = {
  title: 'Test actionable from Gantry',
  body: 'This card was created by **Send test actionable**. The API is wired up correctly.',
  source: { name: 'Gantry test', icon: 'bolt' },
  links: [{ label: 'Gantry API docs', url: 'https://github.com/' }],
  priority: 'normal',
  tags: ['test'],
}

type Ctx = Context<AppEnv>

const parseJsonOrNull = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const tooMany = (c: Ctx, retryAfter: number) => c.json({ error: 'rate_limited' }, 429, { 'retry-after': String(retryAfter) })

const page = (c: Ctx, message: string, status: 200 | 400 | 502 = 200) =>
  c.html(
    `<!doctype html><meta charset="utf-8"><title>Gantry</title><body style="font-family:system-ui;text-align:center;padding:4rem"><p>${message}</p></body>`,
    status,
  )

const completionPage = (c: Ctx, code: string) => {
  const link = DEEP_LINKS.authComplete(code)
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${link}"><title>Gantry</title><body style="font-family:system-ui;text-align:center;padding:4rem"><p>Almost done. Finish in Gantry.</p><p><a href="${link}">Open Gantry</a></p><p>Or paste this code in Gantry:</p><p><code id="code">${code}</code> <button onclick="navigator.clipboard.writeText('${code}')">Copy</button></p></body>`,
  )
}

const json = <T extends z.ZodType>(schema: T) =>
  validator('json', (value, c) => {
    const parsed = schema.safeParse(value)
    return parsed.success ? (parsed.data as z.infer<T>) : c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400)
  })

const toTokenInfo = (r: Record<string, string | null>): ApiTokenInfo => ({
  id: r.id!,
  name: r.name!,
  prefix: r.prefix!,
  lastFour: r.last_four!,
  createdAt: r.created_at!,
  lastUsedAt: r.last_used_at ?? undefined,
  revokedAt: r.revoked_at ?? undefined,
})

export function createApp(fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
  const app = new Hono<AppEnv>()

  const tooLarge = (c: Ctx) => c.json({ error: 'payload_too_large' }, 413)
  const apiBodyLimit = bodyLimit({ maxSize: API_BODY_LIMIT, onError: tooLarge })
  const webhookBodyLimit = bodyLimit({ maxSize: WEBHOOK_BODY_LIMIT, onError: tooLarge })
  app.use((c, next) => (c.req.path.startsWith('/webhooks/') ? webhookBodyLimit : apiBodyLimit)(c, next))
  app.get('/health', (c) => c.json({ ok: true }))

  const deviceAuth = createMiddleware<AppEnv>(async (c, next) => {
    const match = /^Device ([^:\s]+):(\S+)$/.exec(c.req.header('authorization') ?? '')
    const device =
      match && (await c.env.DB.prepare('SELECT id, user_id, secret_hash FROM devices WHERE id = ?').bind(match[1]).first<Record<string, string>>())
    if (!match || !device || !(await timingSafeEqual(await sha256(match[2]!), device.secret_hash!))) return c.json({ error: 'unauthorized' }, 401)
    const retryAfter = await hitRateLimit(c.env.DB, `device:${device.id}`)
    if (retryAfter) return tooMany(c, retryAfter)
    c.set('userId', device.user_id!)
    c.set('deviceId', device.id!)
    await next()
  })

  const tokenAuth = createMiddleware<AppEnv>(async (c, next) => {
    const match = /^Bearer (gtry_\S+)$/.exec(c.req.header('authorization') ?? '')
    const token =
      match &&
      (await c.env.DB.prepare('SELECT id, user_id, name, revoked_at FROM api_tokens WHERE token_hash = ?')
        .bind(await sha256(match[1]!))
        .first<Record<string, string | null>>())
    if (!token || token.revoked_at) return c.json({ error: 'unauthorized' }, 401)
    const retryAfter = await hitRateLimit(c.env.DB, `token:${token.id}`)
    if (retryAfter) return tooMany(c, retryAfter)
    await c.env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(now(), token.id).run()
    c.set('userId', token.user_id!)
    c.set('tokenName', token.name!)
    await next()
  })

  async function me(c: Ctx): Promise<MeResponse> {
    const userId = c.get('userId')
    const [users, grants] = await c.env.DB.batch<Record<string, string | null>>([
      c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId),
      c.env.DB.prepare('SELECT provider, account, status FROM grants WHERE user_id = ?').bind(userId),
    ])
    const user = users!.results[0]
    return {
      userId,
      name: user!.name!,
      email: user!.email ?? undefined,
      githubLogin: user!.github_login ?? undefined,
      signedIn: Boolean(user!.email || user!.github_id),
      grants: (grants!.results as unknown as GrantRow[]).map((g) => ({ provider: g.provider, account: JSON.parse(g.account) as GrantAccount, status: g.status })),
    }
  }

  async function createActionable(c: Ctx, tokenName: string, request: CreateActionableRequest) {
    const id = crypto.randomUUID()
    await enqueue(c.env.DB, [c.get('userId')], { kind: 'actionable.create', id, tokenName, request })
    return c.json({ id, url: `gantry://actionable/${id}` }, 201)
  }

  const findGrant = (c: Ctx) => {
    const provider = c.req.param('provider') as OAuthProvider
    return GRANT_PROVIDERS.includes(provider) ? getGrant(c.env.DB, c.get('userId'), provider) : null
  }

  app.post(
    '/v1/devices',
    createMiddleware<AppEnv>(async (c, next) => {
      const retryAfter = await hitRateLimit(c.env.DB, `ip:${c.req.header('cf-connecting-ip') ?? 'unknown'}`)
      if (retryAfter) return tooMany(c, retryAfter)
      await next()
    }),
    json(nameSchema),
    async (c) => {
      const userId = crypto.randomUUID()
      const deviceId = crypto.randomUUID()
      const deviceSecret = randomToken()
      const createdAt = now()
      await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').bind(userId, c.req.valid('json').name, createdAt),
        c.env.DB.prepare('INSERT INTO devices (id, user_id, secret_hash, created_at) VALUES (?, ?, ?, ?)').bind(deviceId, userId, await sha256(deviceSecret), createdAt),
      ])
      return c.json({ deviceId, deviceSecret, userId } satisfies DeviceRegistration, 201)
    },
  )

  app.get('/v1/me', deviceAuth, async (c) => c.json(await me(c)))

  app.patch('/v1/me', deviceAuth, json(nameSchema.partial()), async (c) => {
    const body = c.req.valid('json')
    if (body.name) await c.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(body.name, c.get('userId')).run()
    return c.json(await me(c))
  })

  app.delete('/v1/me', deviceAuth, async (c) => {
    const userId = c.get('userId')
    const { results } = await c.env.DB.prepare('SELECT * FROM grants WHERE user_id = ?').bind(userId).all<GrantRow>()
    await Promise.allSettled(
      results.map(async (row) => {
        const grant = await decryptGrant(c.env, row)
        await revokeGrant(fetchImpl, c.env, row.provider, grant.accessToken, grant.refreshToken)
      }),
    )
    await deleteUser(c.env.DB, userId).run()
    return c.body(null, 204)
  })

  app.get('/v1/inbox', deviceAuth, async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500)
    const { results } = await c.env.DB.prepare('SELECT id, payload, received_at FROM inbox WHERE user_id = ? AND expires_at > ? ORDER BY received_at LIMIT ?')
      .bind(c.get('userId'), now(), limit)
      .all<Record<string, string>>()
    return c.json({ items: results.map((r) => ({ id: r.id!, receivedAt: r.received_at!, payload: JSON.parse(r.payload!) as InboxPayload })) })
  })

  app.post('/v1/inbox/ack', deviceAuth, json(ackSchema), async (c) => {
    await c.env.DB.prepare('DELETE FROM inbox WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))')
      .bind(c.get('userId'), JSON.stringify(c.req.valid('json').ids))
      .run()
    return c.body(null, 204)
  })

  app.get('/v1/tokens', deviceAuth, async (c) => {
    const { results } = await c.env.DB.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').bind(c.get('userId')).all<Record<string, string | null>>()
    return c.json(results.map(toTokenInfo))
  })

  app.post('/v1/tokens', deviceAuth, json(nameSchema), async (c) => {
    const token = `gtry_${randomToken()}`
    const row = {
      id: crypto.randomUUID(),
      name: c.req.valid('json').name,
      prefix: 'gtry_',
      last_four: token.slice(-4),
      created_at: now(),
      last_used_at: null,
      revoked_at: null,
    }
    await c.env.DB.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, last_four, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, c.get('userId'), row.name, await sha256(token), row.prefix, row.last_four, row.created_at)
      .run()
    return c.json({ ...toTokenInfo(row), token } satisfies CreatedApiToken, 201)
  })

  app.delete('/v1/tokens/:id', deviceAuth, async (c) => {
    const { meta } = await c.env.DB.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .bind(now(), c.req.param('id'), c.get('userId'))
      .run()
    return meta.changes ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)
  })

  app.post('/v1/test-actionable', deviceAuth, (c) => createActionable(c, 'Test', SAMPLE_ACTIONABLE))

  app.post('/v1/actionables', tokenAuth, json(createActionableSchema), (c) => createActionable(c, c.get('tokenName')!, c.req.valid('json')))

  app.patch('/v1/actionables/:id', tokenAuth, json(patchActionableSchema), async (c) => {
    await enqueue(c.env.DB, [c.get('userId')], { kind: 'actionable.update', target: c.req.param('id'), patch: c.req.valid('json') })
    return c.body(null, 202)
  })

  app.post('/v1/actionables/:id/dismiss', tokenAuth, async (c) => {
    await enqueue(c.env.DB, [c.get('userId')], { kind: 'actionable.dismiss', target: c.req.param('id') })
    return c.body(null, 202)
  })

  app.post('/oauth/:provider/start', deviceAuth, async (c) => {
    const provider = c.req.param('provider') as OAuthStartProvider
    if (!OAUTH_PROVIDERS.includes(provider)) return c.json({ error: 'unknown_provider' }, 404)
    const state = randomToken()
    await c.env.DB.prepare('INSERT INTO oauth_states (state, user_id, device_id, provider, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(state, c.get('userId'), c.get('deviceId'), provider, new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString())
      .run()
    return c.json({ url: authorizeUrl(c.env, provider, state) })
  })

  async function issueCompletionCode(c: Ctx, deviceId: string, pending: PendingAuth) {
    const code = randomToken()
    await c.env.DB.prepare('INSERT INTO completion_codes (code_hash, device_id, payload, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(code), deviceId, await encrypt(c.env.TOKEN_ENCRYPTION_KEY, JSON.stringify(pending)), new Date(Date.now() + COMPLETION_CODE_TTL_MS).toISOString())
      .run()
    return completionPage(c, code)
  }

  app.get('/oauth/:provider/callback', async (c) => {
    const provider = c.req.param('provider') as OAuthStartProvider
    const code = c.req.query('code')
    const stored = await c.env.DB.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING device_id, provider, expires_at')
      .bind(c.req.query('state') ?? '')
      .first<Record<string, string>>()
    if (!stored?.device_id || stored.provider !== provider || stored.expires_at! < now()) return page(c, 'This link has expired. Try connecting again from Gantry.', 400)
    if (!code) return page(c, 'Connection cancelled. You can close this tab.', 400)
    let result
    try {
      result = await exchangeCode(fetchImpl, c.env, provider, code)
    } catch (err) {
      console.error(err)
      return page(c, 'Connection failed. Try again from Gantry.', 502)
    }
    return issueCompletionCode(c, stored.device_id, provider === 'github_signin' ? { kind: 'github_signin', account: result.account } : { kind: 'grant', provider, result })
  })

  app.post('/auth/complete', deviceAuth, json(completeSchema), async (c) => {
    const row = await c.env.DB.prepare('DELETE FROM completion_codes WHERE code_hash = ? RETURNING device_id, payload, expires_at')
      .bind(await sha256(c.req.valid('json').code))
      .first<Record<string, string>>()
    if (!row || row.device_id !== c.get('deviceId') || row.expires_at! < now()) return c.json({ error: 'invalid_code' }, 400)
    const pending = JSON.parse(await decrypt(c.env.TOKEN_ENCRYPTION_KEY, row.payload!)) as PendingAuth
    const userId = c.get('userId')
    if (pending.kind === 'grant') {
      await saveGrant(c.env, userId, pending.provider, pending.result)
      await enqueue(c.env.DB, [userId], { kind: 'connection', provider: pending.provider, status: 'connected', account: pending.result.account })
      return c.json({ kind: 'grant', provider: pending.provider } satisfies AuthCompletion)
    }
    if (pending.kind === 'github_signin') {
      const existing = await c.env.DB.prepare('SELECT id FROM users WHERE github_id = ?').bind(pending.account.id).first<{ id: string }>()
      if (existing) await mergeUsers(c.env.DB, userId, existing.id)
      await c.env.DB.prepare('UPDATE users SET github_id = ?, github_login = ? WHERE id = ?').bind(pending.account.id, pending.account.login, existing?.id ?? userId).run()
    } else {
      const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(pending.email).first<{ id: string }>()
      if (existing) await mergeUsers(c.env.DB, userId, existing.id)
      else await c.env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(pending.email, userId).run()
    }
    return c.json({ kind: 'signin' } satisfies AuthCompletion)
  })

  app.post('/v1/grants/:provider/refresh', deviceAuth, async (c) => {
    const row = await findGrant(c)
    if (!row) return c.json({ error: 'not_found' }, 404)
    const { provider, user_id: userId } = row
    if (row.status !== 'connected') return c.json({ error: 'reconnect_required' }, 409)
    const grant = await decryptGrant(c.env, row)
    let accessToken = grant.accessToken
    let expiresAt = row.expires_at ?? undefined
    if (c.req.query('force') === '1' || (row.expires_at && Date.parse(row.expires_at) - Date.now() < REFRESH_SKEW_MS)) {
      try {
        if (!grant.refreshToken) throw new OAuthRejected('no refresh token')
        const refreshed = await refreshTokens(fetchImpl, c.env, provider, grant.refreshToken)
        await updateGrantTokens(c.env, userId, provider, refreshed)
        accessToken = refreshed.accessToken
        expiresAt = refreshed.expiresAt
      } catch (err) {
        console.error(err)
        if (!(err instanceof OAuthRejected)) return c.json({ error: 'provider_unavailable' }, 502)
        const latest = await getGrant(c.env.DB, userId, provider)
        if (latest && latest.status === 'connected' && latest.refresh_token !== row.refresh_token) {
          const rotated = await decryptGrant(c.env, latest)
          return c.json({ provider, accessToken: rotated.accessToken, expiresAt: latest.expires_at ?? undefined, account: rotated.account, scopes: rotated.scopes } satisfies GrantTokenResponse)
        }
        await c.env.DB.prepare("UPDATE grants SET status = 'reconnect_required' WHERE user_id = ? AND provider = ?").bind(userId, provider).run()
        await enqueue(c.env.DB, [userId], { kind: 'connection', provider, status: 'reconnect_required', account: grant.account })
        return c.json({ error: 'reconnect_required' }, 409)
      }
    }
    return c.json({ provider, accessToken, expiresAt, account: grant.account, scopes: grant.scopes } satisfies GrantTokenResponse)
  })

  app.delete('/v1/grants/:provider', deviceAuth, async (c) => {
    const row = await findGrant(c)
    if (!row) return c.body(null, 204)
    const grant = await decryptGrant(c.env, row)
    await revokeGrant(fetchImpl, c.env, row.provider, grant.accessToken, grant.refreshToken).catch(console.error)
    await c.env.DB.prepare('DELETE FROM grants WHERE user_id = ? AND provider = ?').bind(row.user_id, row.provider).run()
    return c.body(null, 204)
  })

  app.post('/auth/email', deviceAuth, json(emailSchema), async (c) => {
    const retryAfter = await hitRateLimit(c.env.DB, `email:${c.get('deviceId')}`, EMAIL_SENDS_PER_MINUTE)
    if (retryAfter) return tooMany(c, retryAfter)
    const body = c.req.valid('json')
    const token = randomToken()
    await c.env.DB.prepare('INSERT INTO email_links (token_hash, user_id, device_id, email, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256(token), c.get('userId'), c.get('deviceId'), body.email.toLowerCase(), new Date(Date.now() + EMAIL_LINK_TTL_MS).toISOString())
      .run()
    const link = `${c.env.PUBLIC_URL}/auth/email/verify?token=${token}`
    if (!c.env.RESEND_API_KEY) {
      // shortcut: no email provider configured logs the magic link, set RESEND_API_KEY for real delivery
      console.log(`Magic link for ${body.email}: ${link}`)
      return c.body(null, 204)
    }
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: c.env.EMAIL_FROM,
        to: [body.email],
        subject: 'Sign in to Gantry',
        html: `<p><a href="${link}">Sign in to Gantry</a>. This link expires in 15 minutes.</p>`,
      }),
    })
    return res.ok ? c.body(null, 204) : c.json({ error: 'email_failed' }, 502)
  })

  app.get('/auth/email/verify', async (c) => {
    const link = await c.env.DB.prepare('DELETE FROM email_links WHERE token_hash = ? RETURNING device_id, email, expires_at')
      .bind(await sha256(c.req.query('token') ?? ''))
      .first<Record<string, string>>()
    if (!link?.device_id || link.expires_at! < now()) return page(c, 'This link has expired. Request a new one from Gantry.', 400)
    return issueCompletionCode(c, link.device_id, { kind: 'email', email: link.email! })
  })

  app.post('/webhooks/github', async (c) => {
    const raw = await c.req.text()
    const expected = `sha256=${await hmacSha256Hex(c.env.GITHUB_WEBHOOK_SECRET, raw)}`
    if (!(await timingSafeEqual(c.req.header('x-hub-signature-256') ?? '', expected))) return c.json({ error: 'bad_signature' }, 401)
    const payload = parseJsonOrNull(raw) as { action?: string; installation?: { id: number }; sender?: { id: number } } | null
    if (!payload) return c.json({ error: 'invalid_json' }, 400)
    const event = c.req.header('x-github-event') ?? 'unknown'
    const installationKey = payload.installation && `installation:${payload.installation.id}`
    if (!installationKey) return c.json({ delivered: 0 })
    if (event === 'installation' && payload.action === 'created' && payload.sender) {
      await addRoutingKey(c.env.DB, 'github', `user:${payload.sender.id}`, installationKey)
    }
    const users = await findUsersByRoutingKey(c.env.DB, 'github', [installationKey])
    await enqueue(c.env.DB, users, { kind: 'github.webhook', event, deliveryId: c.req.header('x-github-delivery') ?? '', payload })
    return c.json({ delivered: users.length })
  })

  app.post('/webhooks/slack', async (c) => {
    const raw = await c.req.text()
    const timestamp = Number(c.req.header('x-slack-request-timestamp'))
    if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > SLACK_REPLAY_WINDOW_S) return c.json({ error: 'stale_request' }, 401)
    const expected = `v0=${await hmacSha256Hex(c.env.SLACK_SIGNING_SECRET, `v0:${timestamp}:${raw}`)}`
    if (!(await timingSafeEqual(c.req.header('x-slack-signature') ?? '', expected))) return c.json({ error: 'bad_signature' }, 401)
    const payload = parseJsonOrNull(raw) as { type?: string; challenge?: string; authorizations?: { team_id: string; user_id: string }[] } | null
    if (!payload) return c.json({ error: 'invalid_json' }, 400)
    if (payload.type === 'url_verification') return c.json({ challenge: payload.challenge })
    // shortcut: Slack only includes one authorization per event, call apps.event.authorizations.list when several Gantry users share a channel
    const keys = (payload.authorizations ?? []).map((a) => `${a.team_id}:${a.user_id}`)
    const users = await findUsersByRoutingKey(c.env.DB, 'slack', keys)
    await enqueue(c.env.DB, users, { kind: 'slack.event', payload })
    return c.json({ delivered: users.length })
  })

  app.onError((err, c) => {
    console.error(err)
    return c.json({ error: 'internal_error' }, 500)
  })

  return app
}
