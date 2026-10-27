import { describe, expect, it, vi } from 'vitest'
import { AccountService } from './account'

describe('AccountService.refresh', () => {
  it('re-registers the device when the Worker no longer knows it', async () => {
    const meta = new Map<string, unknown>([['account', { name: 'Lucas', signedIn: false, onboarded: true }]])
    const secrets = new Map([['device', JSON.stringify({ deviceId: 'stale', deviceSecret: 's' })]])
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization')
      if (String(url).endsWith('/v1/devices')) return json({ deviceId: 'fresh', deviceSecret: 'n' })
      return auth?.startsWith('Device fresh:') ? json({ signedIn: false }) : json({ error: 'unauthorized' }, 401)
    })
    const account = new AccountService({
      meta: { get: <T>(k: string) => meta.get(k) as T, set: (k, v) => void meta.set(k, v), delete: (k) => void meta.delete(k) },
      secrets: { get: (k) => secrets.get(k), set: (k, v) => void secrets.set(k, v), delete: (k) => void secrets.delete(k), clear: () => secrets.clear() },
      workerUrl: () => 'https://worker.test',
      fetch: fetch as typeof globalThis.fetch,
    })

    await account.refresh()

    expect(account.get().deviceId).toBe('fresh')
  })
})
