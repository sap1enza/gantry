import type { GrantAccount, OAuthProvider } from '@gantry/shared'
import type { Env } from './env'

export const GRANT_PROVIDERS: OAuthProvider[] = ['github', 'slack', 'google']
export type OAuthStartProvider = OAuthProvider | 'github_signin'
export const OAUTH_PROVIDERS: OAuthStartProvider[] = [...GRANT_PROVIDERS, 'github_signin']

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  scopes: string[]
}

export interface ExchangeResult extends TokenSet {
  account: GrantAccount
  routingKeys: string[]
}

const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'gantry-worker' }

const providerConfig = (env: Env, provider: OAuthProvider) =>
  ({
    github: {
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      authorizeParams: {},
    },
    slack: {
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      clientId: env.SLACK_CLIENT_ID,
      clientSecret: env.SLACK_CLIENT_SECRET,
      authorizeParams: { user_scope: 'channels:history,groups:history,im:history,mpim:history,search:read,users:read' },
    },
    google: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorizeParams: {
        response_type: 'code',
        scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
        access_type: 'offline',
        prompt: 'consent',
      },
    },
  })[provider]

const tokenProvider = (provider: OAuthStartProvider): OAuthProvider => (provider === 'github_signin' ? 'github' : provider)
const redirectUri = (env: Env, provider: OAuthStartProvider) => `${env.PUBLIC_URL}/oauth/${provider}/callback`

export function authorizeUrl(env: Env, provider: OAuthStartProvider, state: string) {
  const config = providerConfig(env, tokenProvider(provider))
  const url = new URL(config.authorizeUrl)
  for (const [k, v] of Object.entries({ ...config.authorizeParams, client_id: config.clientId, redirect_uri: redirectUri(env, provider), state }))
    url.searchParams.set(k, v)
  return url.toString()
}

export class OAuthRejected extends Error {}

async function requestTokens(fetchImpl: typeof fetch, env: Env, provider: OAuthProvider, params: Record<string, string>) {
  const { tokenUrl, clientId, clientSecret } = providerConfig(env, provider)
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, any>
  const t = provider === 'slack' && data.authed_user?.access_token ? data.authed_user : data
  if (res.status >= 500) throw new Error(`${provider} token endpoint unavailable: ${res.status}`)
  if (!res.ok || data.error || data.ok === false || typeof t.access_token !== 'string') {
    throw new OAuthRejected(`${provider} token request failed: ${data.error ?? res.status}`)
  }
  const tokens: TokenSet = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000).toISOString() : undefined,
    scopes: typeof t.scope === 'string' ? t.scope.split(/[ ,]+/).filter(Boolean) : [],
  }
  return { tokens, data }
}

async function getJson(fetchImpl: typeof fetch, url: string, token: string, headers: Record<string, string> = {}) {
  const res = await fetchImpl(url, { headers: { ...headers, authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`)
  return (await res.json()) as Record<string, any>
}

async function githubIdentity(fetchImpl: typeof fetch, accessToken: string) {
  const user = await getJson(fetchImpl, 'https://api.github.com/user', accessToken, GITHUB_HEADERS)
  return { id: String(user.id), login: user.login, name: user.name ?? undefined, avatarUrl: user.avatar_url } satisfies GrantAccount
}

async function githubInstallationKeys(fetchImpl: typeof fetch, accessToken: string) {
  const data = await getJson(fetchImpl, 'https://api.github.com/user/installations', accessToken, GITHUB_HEADERS)
  return (data.installations ?? []).map((i: { id: number }) => `installation:${i.id}`) as string[]
}

export async function exchangeCode(fetchImpl: typeof fetch, env: Env, provider: OAuthStartProvider, code: string): Promise<ExchangeResult> {
  const { tokens, data } = await requestTokens(fetchImpl, env, tokenProvider(provider), {
    code,
    redirect_uri: redirectUri(env, provider),
    ...(provider === 'google' ? { grant_type: 'authorization_code' } : {}),
  })
  if (provider === 'slack') {
    const userId: string = data.authed_user.id
    const teamId: string = data.team?.id
    const info = await getJson(fetchImpl, `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, tokens.accessToken)
    return {
      ...tokens,
      account: { id: userId, login: info.user?.name ?? userId, name: info.user?.real_name, avatarUrl: info.user?.profile?.image_72, team: data.team?.name },
      routingKeys: [`${teamId}:${userId}`],
    }
  }
  if (provider === 'google') {
    const info = await getJson(fetchImpl, 'https://openidconnect.googleapis.com/v1/userinfo', tokens.accessToken)
    return { ...tokens, account: { id: info.sub, login: info.email, name: info.name, avatarUrl: info.picture }, routingKeys: [] }
  }
  const account = await githubIdentity(fetchImpl, tokens.accessToken)
  const installations = provider === 'github' ? await githubInstallationKeys(fetchImpl, tokens.accessToken) : []
  return { ...tokens, account, routingKeys: [`user:${account.id}`, ...installations] }
}

export async function refreshTokens(fetchImpl: typeof fetch, env: Env, provider: OAuthProvider, refreshToken: string) {
  const { tokens } = await requestTokens(fetchImpl, env, provider, { grant_type: 'refresh_token', refresh_token: refreshToken })
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
}

export async function revokeGrant(fetchImpl: typeof fetch, env: Env, provider: OAuthProvider, accessToken: string, refreshToken?: string) {
  if (provider === 'github') {
    await fetchImpl(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/grant`, {
      method: 'DELETE',
      headers: { ...GITHUB_HEADERS, authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}` },
      body: JSON.stringify({ access_token: accessToken }),
    })
  } else if (provider === 'google') {
    await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken ?? accessToken)}`, { method: 'POST' })
  } else {
    await fetchImpl('https://slack.com/api/auth.revoke', { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } })
  }
}
