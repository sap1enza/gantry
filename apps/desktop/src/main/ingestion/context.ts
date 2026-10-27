import {
  errorMessage,
  PROVIDER_SOURCE,
  SECRET_KEYS,
  TRIGGERS,
  WorkerError,
  type ConnectionInfo,
  type ConnectionStatus,
  type GrantAccount,
  type GrantTokenResponse,
  type IngestResult,
  type IngestSignal,
  type OAuthProvider,
  type Settings,
  type TriggerId,
} from '@gantry/shared'
import type { IngestionDeps } from '../contracts'
import { classify, LlmError } from './llm'

export class ThrottledError extends Error {
  constructor(
    readonly provider: OAuthProvider,
    readonly until: number,
  ) {
    super(`${provider} throttled until ${new Date(until).toISOString()}`)
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} ${url}`)
  }
}

export class NotConnectedError extends Error {}

export const FETCH_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 5
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 3_600_000
const GIVE_UP_MS = 24 * 3_600_000
const RETRY_FORGET_MS = 7 * 24 * 3_600_000

export function isTransient(e: unknown) {
  if (e instanceof NotConnectedError) return true
  const status = (e as { status?: unknown })?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  return (e instanceof TypeError && e.message === 'fetch failed') || (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError'))
}

export const isFatal = (e: unknown) => e instanceof ThrottledError || e instanceof NotConnectedError

export function report(e: unknown) {
  if (!isFatal(e)) console.error('[ingestion]', e)
}

interface RetryState {
  attempts: number
  retryAt: number
}

const SLACK_AUTH_ERRORS = new Set(['invalid_auth', 'token_expired', 'token_revoked', 'not_authed'])
const REFRESH_MARGIN_MS = 5 * 60_000
const GOOGLE_RATE_LIMITS = new Set(['rateLimitExceeded', 'userRateLimitExceeded'])
const GOOGLE_BACKOFF_MS = 60_000

const googleRateLimited = (body: unknown) =>
  ((body as { error?: { errors?: { reason?: string }[] } })?.error?.errors ?? []).some((x) => GOOGLE_RATE_LIMITS.has(x.reason ?? ''))

export function backoffUntil(res: Response, now: number): number | undefined {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter && Number.isFinite(Number(retryAfter)) && (res.status === 429 || res.status === 403)) return now + Number(retryAfter) * 1000
  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = res.headers.get('x-ratelimit-reset')
  const limit = Number(res.headers.get('x-ratelimit-limit') ?? 5000)
  if (remaining !== null && reset && Number(remaining) <= Math.max(1, limit * 0.05)) return Number(reset) * 1000
  if (res.status === 429) return now + 60_000
  return undefined
}

export interface EmitOptions {
  filtered?: string
  llm?: { instruction: string; content: string }
}

export type Ctx = ReturnType<typeof createCtx>

export function createCtx(deps: IngestionDeps) {
  const listeners = new Set<() => void>()
  const blocked = new Map<OAuthProvider, number>()
  const refreshing = new Map<string, Promise<GrantTokenResponse>>()
  const grants = new Map<OAuthProvider, GrantTokenResponse | undefined>()
  const now = () => (deps.now?.() ?? new Date()).getTime()
  const settings = (): Settings => deps.getSettings()

  const grant = (p: OAuthProvider): GrantTokenResponse | undefined => {
    if (!grants.has(p)) {
      const raw = deps.secrets.get(SECRET_KEYS.grant(p))
      grants.set(p, raw ? (JSON.parse(raw) as GrantTokenResponse) : undefined)
    }
    return grants.get(p)
  }

  const connectionState = () => deps.kv.get<Partial<Record<OAuthProvider, ConnectionInfo>>>('connections') ?? {}

  function setConnection(p: OAuthProvider, patch: Partial<ConnectionInfo> & { status?: ConnectionStatus }) {
    const all = connectionState()
    const prev = all[p] ?? { provider: p, status: 'disconnected' }
    all[p] = { ...prev, ...patch }
    deps.kv.set('connections', all)
    if (patch.status && patch.status !== prev.status) deps.sink.logConnection(p, patch.status, patch.detail)
    if (patch.status === 'connected' && prev.status !== 'connected') deps.sink.markSourceConnected(PROVIDER_SOURCE[p])
    for (const l of listeners) l()
  }

  function storeGrant(g: GrantTokenResponse) {
    deps.secrets.set(SECRET_KEYS.grant(g.provider), JSON.stringify(g))
    grants.set(g.provider, g)
    const { login, name, team, avatarUrl } = g.account
    setConnection(g.provider, { status: 'connected', account: { login, name, team, avatarUrl }, detail: undefined })
  }

  function refresh(p: OAuthProvider, force = false): Promise<GrantTokenResponse> {
    const key = `${p}:${force}`
    const inFlight = refreshing.get(key) ?? refreshOnce(p, force).finally(() => refreshing.delete(key))
    refreshing.set(key, inFlight)
    return inFlight
  }

  async function refreshOnce(p: OAuthProvider, force: boolean): Promise<GrantTokenResponse> {
    const worker = deps.worker()
    if (!worker) throw new NotConnectedError('device not registered')
    try {
      const g = await worker.refreshGrant(p, { force })
      storeGrant(g)
      return g
    } catch (e) {
      if (e instanceof WorkerError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        setConnection(p, { status: 'reconnect_required', detail: e.message })
        throw new NotConnectedError(`${p} reconnect required`)
      }
      throw e
    }
  }

  async function token(p: OAuthProvider) {
    const g = grant(p)
    if (!g) throw new NotConnectedError(`${p} not connected`)
    if (g.expiresAt && Date.parse(g.expiresAt) - now() < REFRESH_MARGIN_MS) return (await refresh(p)).accessToken
    return g.accessToken
  }

  function block(p: OAuthProvider, until: number) {
    const already = (blocked.get(p) ?? 0) > now()
    blocked.set(p, until)
    if (!already) deps.sink.logConnection(p, 'throttled', `Backing off until ${new Date(until).toISOString()}`)
  }

  async function request<T>(p: OAuthProvider, url: string, init: RequestInit = {}): Promise<{ body: T; headers: Headers }> {
    let accessToken = await token(p)
    for (let attempt = 0; ; attempt++) {
      const until = blocked.get(p)
      if (until && until > now()) throw new ThrottledError(p, until)
      const res = await fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...init.headers, authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      const backoff = backoffUntil(res, now())
      if (backoff) block(p, backoff)
      if (backoff && !res.ok) throw new ThrottledError(p, backoff)
      const body = res.status === 204 ? undefined : await res.json().catch(() => undefined)
      if (p === 'google' && res.status === 403 && googleRateLimited(body)) {
        block(p, backoff ?? now() + GOOGLE_BACKOFF_MS)
        throw new ThrottledError(p, blocked.get(p)!)
      }
      const rejected = res.status === 401 || (p === 'slack' && SLACK_AUTH_ERRORS.has((body as { error?: string })?.error ?? ''))
      if (rejected && attempt === 0) {
        accessToken = (await refresh(p, true)).accessToken
        continue
      }
      if (rejected) {
        setConnection(p, { status: 'reconnect_required', detail: 'Token rejected' })
        throw new NotConnectedError(`${p} token rejected`)
      }
      if (!res.ok) throw new HttpError(res.status, url)
      return { body: body as T, headers: res.headers }
    }
  }

  const json = async <T>(p: OAuthProvider, url: string, init?: RequestInit) => (await request<T>(p, url, init)).body

  const triggerOn = (t: TriggerId) => settings().triggers[t] !== false

  function admit(signal: IngestSignal) {
    if (triggerOn(signal.trigger)) return true
    deps.sink.logIgnored(signal, 'ignored:trigger-off', `${TRIGGERS[signal.trigger].label} is turned off`)
    return false
  }

  async function emit(signal: IngestSignal, opts: EmitOptions = {}): Promise<IngestResult | undefined> {
    if (!admit(signal)) return
    if (opts.filtered) {
      deps.sink.logIgnored(signal, 'ignored:filtered', opts.filtered)
      return
    }
    if (opts.llm) {
      const verdict = await classify(settings().llm, deps.secrets.get(SECRET_KEYS.llmApiKey), opts.llm.instruction, opts.llm.content).catch((e) => {
        if (e instanceof LlmError && !isTransient(e)) return { decision: false, reason: e.message }
        throw e
      })
      if (!verdict.decision) {
        deps.sink.logIgnored(signal, 'ignored:llm', verdict.reason)
        return
      }
      signal = { ...signal, aiDetected: true, receivedDetail: verdict.reason }
    }
    return deps.sink.ingest(signal)
  }

  const retries = () => deps.kv.get<Record<string, RetryState>>('ingestion.retries') ?? {}

  function saveRetries(all: Record<string, RetryState>) {
    const fresh = Object.entries(all).filter(([, r]) => now() - r.retryAt < RETRY_FORGET_MS)
    deps.kv.set('ingestion.retries', Object.fromEntries(fresh))
  }

  function queued(prefix: string, add: string[] = []) {
    const all = retries()
    for (const id of add) all[prefix + id] ??= { attempts: 0, retryAt: now() }
    saveRetries(all)
    return Object.keys(all)
      .filter((k) => k.startsWith(prefix) && all[k]!.attempts < MAX_ATTEMPTS && all[k]!.retryAt <= now())
      .map((k) => k.slice(prefix.length))
  }

  async function retryable(key: string, describe: IngestSignal, run: () => Promise<unknown>, fatal = isFatal) {
    const state = retries()[key]
    if (state && state.attempts >= MAX_ATTEMPTS && now() - state.retryAt < GIVE_UP_MS) return true
    if (state && state.retryAt > now()) return false
    try {
      await run()
    } catch (e) {
      if (fatal(e)) throw e
      const attempts = (state?.attempts ?? 0) + 1
      if (isTransient(e) && attempts < MAX_ATTEMPTS) {
        saveRetries({ ...retries(), [key]: { attempts, retryAt: now() + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS) } })
        return false
      }
      report(e)
      deps.sink.logIgnored(describe, 'ignored:error', `Failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${errorMessage(e)}`)
      saveRetries({ ...retries(), [key]: { attempts: MAX_ATTEMPTS, retryAt: now() } })
      return true
    }
    if (state) {
      const all = retries()
      delete all[key]
      saveRetries(all)
    }
    return true
  }

  return {
    deps,
    now,
    iso: () => new Date(now()).toISOString(),
    settings,
    account: (p: OAuthProvider): GrantAccount | undefined => grant(p)?.account,
    connectionState,
    setConnection,
    refresh,
    request,
    json,
    triggerOn,
    admit,
    emit,
    queued,
    retryable,
    forget(p: OAuthProvider, retryPrefix: string) {
      deps.secrets.delete(SECRET_KEYS.grant(p))
      grants.delete(p)
      saveRetries(Object.fromEntries(Object.entries(retries()).filter(([k]) => !k.startsWith(retryPrefix))))
    },
    onChange(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
