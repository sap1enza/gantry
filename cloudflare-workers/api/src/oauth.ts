import type { GrantAccount, OAuthProvider } from '@gantry/shared'
import type { Env } from './env'

export const GRANT_PROVIDERS: OAuthProvider[] = ['github']
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

const MAX_INSTALLATION_PAGES = 10
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
  if (res.status >= 500) throw new Error(`${provider} token endpoint unavailable: ${res.status}`)
  if (!res.ok || data.error || typeof data.access_token !== 'string') {
    throw new OAuthRejected(`${provider} token request failed: ${data.error ?? res.status}`)
  }
  const tokens: TokenSet = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined,
    scopes: typeof data.scope === 'string' ? data.scope.split(/[ ,]+/).filter(Boolean) : [],
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

export async function githubInstallationKeys(fetchImpl: typeof fetch, accessToken: string) {
  const keys: string[] = []
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const data = await getJson(fetchImpl, `https://api.github.com/user/installations?per_page=100&page=${page}`, accessToken, GITHUB_HEADERS)
    const installations: { id: number }[] = data.installations ?? []
    keys.push(...installations.map((i) => `installation:${i.id}`))
    if (installations.length < 100) break
  }
  return keys
}

export async function exchangeCode(fetchImpl: typeof fetch, env: Env, provider: OAuthStartProvider, code: string): Promise<ExchangeResult> {
  const { tokens } = await requestTokens(fetchImpl, env, tokenProvider(provider), {
    code,
    redirect_uri: redirectUri(env, provider),
  })
  const account = await githubIdentity(fetchImpl, tokens.accessToken)
  const installations = provider === 'github' ? await githubInstallationKeys(fetchImpl, tokens.accessToken) : []
  return { ...tokens, account, routingKeys: [`user:${account.id}`, ...installations] }
}

export async function refreshTokens(fetchImpl: typeof fetch, env: Env, provider: OAuthProvider, refreshToken: string) {
  const { tokens } = await requestTokens(fetchImpl, env, provider, { grant_type: 'refresh_token', refresh_token: refreshToken })
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
}

export async function revokeGrant(fetchImpl: typeof fetch, env: Env, accessToken: string) {
  await fetchImpl(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/grant`, {
    method: 'DELETE',
    headers: { ...GITHUB_HEADERS, authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}` },
    body: JSON.stringify({ access_token: accessToken }),
  })
}
