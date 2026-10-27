import { DEFAULT_SETTINGS, SECRET_KEYS, type GrantTokenResponse, type IngestSink, type OAuthProvider, type Settings, type WorkerClient } from '@gantry/shared'
import { vi } from 'vitest'
import type { IngestionDeps } from '../contracts'
import { createCtx } from './context'

export const NOW = new Date('2026-10-27T12:00:00Z')

export function fakeDeps(worker?: Partial<WorkerClient>) {
  const kv = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  const settings: Settings = structuredClone(DEFAULT_SETTINGS)
  const sink = {
    ingest: vi.fn<IngestSink['ingest']>(() => ({ outcome: 'created' })),
    logIgnored: vi.fn<IngestSink['logIgnored']>(),
    resolve: vi.fn<IngestSink['resolve']>(),
    applyPatch: vi.fn<IngestSink['applyPatch']>(),
    dismiss: vi.fn<IngestSink['dismiss']>(),
    logConnection: vi.fn<IngestSink['logConnection']>(),
    markSourceDisconnected: vi.fn<IngestSink['markSourceDisconnected']>(),
    markSourceConnected: vi.fn<IngestSink['markSourceConnected']>(),
  }
  const deps = {
    sink,
    settings,
    kv: { get: <T>(k: string) => kv.get(k) as T | undefined, set: (k: string, v: unknown) => void kv.set(k, structuredClone(v)), delete: (k: string) => void kv.delete(k) },
    secrets: { get: (k: string) => secrets.get(k), set: (k: string, v: string) => void secrets.set(k, v), delete: (k: string) => void secrets.delete(k), clear: () => secrets.clear() },
    getSettings: () => settings,
    worker: () => worker as WorkerClient | undefined,
    openExternal: vi.fn(async () => {}),
    now: () => NOW,
  } satisfies IngestionDeps & { settings: Settings }
  return deps
}

export function grantFor(provider: OAuthProvider, account: { id: string; login: string }, accessToken = 'tok', expiresAt?: string): GrantTokenResponse {
  return { provider, accessToken, expiresAt, account, scopes: [] }
}

export function connectedCtx(deps: ReturnType<typeof fakeDeps>, ...grants: GrantTokenResponse[]) {
  for (const g of grants) deps.secrets.set(SECRET_KEYS.grant(g.provider), JSON.stringify(g))
  return createCtx(deps)
}

export const res = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export function routeFetch(routes: [string | RegExp, (init?: RequestInit) => Response][]) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const route = routes.find(([pattern]) => (typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)))
    if (!route) throw new Error(`unrouted fetch ${url}`)
    return route[1](init)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
