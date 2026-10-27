import type { GrantAccount, InboxPayload, OAuthProvider } from '@gantry/shared'
import { decrypt, encrypt } from './crypto'
import type { Env } from './env'
import type { ExchangeResult, TokenSet } from './oauth'

const INBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000
const RATE_LIMIT_PER_MINUTE = 60

export const now = () => new Date().toISOString()

export async function enqueue(db: D1Database, userIds: string[], payload: InboxPayload) {
  if (!userIds.length) return
  const receivedAt = new Date()
  const expiresAt = new Date(receivedAt.getTime() + INBOX_TTL_MS).toISOString()
  const json = JSON.stringify(payload)
  await db.batch(
    userIds.map((userId) =>
      db
        .prepare('INSERT INTO inbox (id, user_id, payload, received_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), userId, json, receivedAt.toISOString(), expiresAt),
    ),
  )
}

export async function hitRateLimit(db: D1Database, key: string, limit = RATE_LIMIT_PER_MINUTE) {
  const nowMs = Date.now()
  const window = Math.floor(nowMs / 60_000)
  const row = await db
    .prepare('INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT (key, window) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(key, window)
    .first<{ count: number }>()
  return row!.count > limit ? Math.ceil(((window + 1) * 60_000 - nowMs) / 1000) : 0
}

export async function findUsersByRoutingKey(db: D1Database, provider: OAuthProvider, keys: string[]) {
  if (!keys.length) return []
  const { results } = await db
    .prepare(
      `SELECT DISTINCT g.user_id FROM grants g, json_each(g.routing_keys) k
       WHERE g.provider = ? AND g.status = 'connected' AND k.value IN (SELECT value FROM json_each(?))`,
    )
    .bind(provider, JSON.stringify(keys))
    .all<{ user_id: string }>()
  return results.map((r) => r.user_id)
}

export async function addRoutingKey(db: D1Database, provider: OAuthProvider, matchKey: string, newKey: string) {
  await db
    .prepare(
      `UPDATE grants SET routing_keys = json_insert(routing_keys, '$[#]', ?2)
       WHERE provider = ?1 AND EXISTS (SELECT 1 FROM json_each(routing_keys) WHERE value = ?3)
       AND NOT EXISTS (SELECT 1 FROM json_each(routing_keys) WHERE value = ?2)`,
    )
    .bind(provider, newKey, matchKey)
    .run()
}

export interface GrantRow {
  user_id: string
  provider: OAuthProvider
  access_token: string
  refresh_token: string | null
  expires_at: string | null
  account: string
  scopes: string
  status: 'connected' | 'reconnect_required'
}

export const getGrant = (db: D1Database, userId: string, provider: OAuthProvider) =>
  db.prepare('SELECT * FROM grants WHERE user_id = ? AND provider = ?').bind(userId, provider).first<GrantRow>()

export async function saveGrant(env: Env, userId: string, provider: OAuthProvider, grant: ExchangeResult) {
  await env.DB.prepare(
    `INSERT INTO grants (user_id, provider, access_token, refresh_token, expires_at, account, scopes, status, routing_keys, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, account = excluded.account, scopes = excluded.scopes, status = 'connected',
       routing_keys = excluded.routing_keys, updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      provider,
      await encrypt(env.TOKEN_ENCRYPTION_KEY, grant.accessToken),
      grant.refreshToken ? await encrypt(env.TOKEN_ENCRYPTION_KEY, grant.refreshToken) : null,
      grant.expiresAt ?? null,
      JSON.stringify(grant.account),
      JSON.stringify(grant.scopes),
      JSON.stringify(grant.routingKeys),
      now(),
    )
    .run()
}

export async function updateGrantTokens(env: Env, userId: string, provider: OAuthProvider, tokens: TokenSet) {
  await env.DB.prepare('UPDATE grants SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE user_id = ? AND provider = ?')
    .bind(
      await encrypt(env.TOKEN_ENCRYPTION_KEY, tokens.accessToken),
      tokens.refreshToken ? await encrypt(env.TOKEN_ENCRYPTION_KEY, tokens.refreshToken) : null,
      tokens.expiresAt ?? null,
      now(),
      userId,
      provider,
    )
    .run()
}

export async function decryptGrant(env: Env, row: GrantRow) {
  return {
    accessToken: await decrypt(env.TOKEN_ENCRYPTION_KEY, row.access_token),
    refreshToken: row.refresh_token ? await decrypt(env.TOKEN_ENCRYPTION_KEY, row.refresh_token) : undefined,
    account: JSON.parse(row.account) as GrantAccount,
    scopes: JSON.parse(row.scopes) as string[],
  }
}

const USER_TABLES = ['devices', 'api_tokens', 'inbox', 'oauth_states', 'email_links', 'grants']

export const deleteUser = (db: D1Database, userId: string) => db.prepare('DELETE FROM users WHERE id = ?').bind(userId)

export async function mergeUsers(db: D1Database, fromUserId: string, intoUserId: string) {
  if (fromUserId === intoUserId) return
  // shortcut: grants the target already has are dropped without provider revocation, revoke them once multi-device merges are common
  const from = await db.prepare('SELECT email, github_id, github_login FROM users WHERE id = ?').bind(fromUserId).first<Record<string, string | null>>()
  await db.batch([
    ...USER_TABLES.map((table) => db.prepare(`UPDATE OR IGNORE ${table} SET user_id = ?1 WHERE user_id = ?2`).bind(intoUserId, fromUserId)),
    deleteUser(db, fromUserId),
    db
      .prepare('UPDATE users SET email = COALESCE(email, ?), github_id = COALESCE(github_id, ?), github_login = COALESCE(github_login, ?) WHERE id = ?')
      .bind(from?.email ?? null, from?.github_id ?? null, from?.github_login ?? null, intoUserId),
  ])
}

export async function deleteExpired(db: D1Database) {
  const ts = now()
  await db.batch([
    db.prepare('DELETE FROM inbox WHERE expires_at < ?').bind(ts),
    db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(ts),
    db.prepare('DELETE FROM email_links WHERE expires_at < ?').bind(ts),
    db.prepare('DELETE FROM rate_limits WHERE window < ?').bind(Math.floor(Date.now() / 60_000) - 1),
  ])
}
