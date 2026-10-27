import { DEFAULT_SETTINGS, type ActivityEvent } from '@gantry/shared'
import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../db'
import { createSecretStore, jsonTable } from '../db/stores'
import { inferRepository, parseRemote } from '../domain/repositories'
import { AccountService } from './account'
import { loginItemSync } from './login-item'
import { parseDeepLink } from './deeplink'
import { notificationFor } from './notifications'

describe('parseDeepLink', () => {
  it('extracts the actionable id and rejects other links', () => {
    expect(parseDeepLink('gantry://actionable/0b5c-uuid')).toBe('0b5c-uuid')
    expect(parseDeepLink('gantry://actionable/GT-012/')).toBe('GT-012')
    expect(parseDeepLink('gantry://settings')).toBeUndefined()
    expect(parseDeepLink('https://actionable/x')).toBeUndefined()
  })
})

describe('repositories', () => {
  it('parses ssh and https remotes', () => {
    expect(parseRemote('git@github.com:acme/api.git\n')).toBe('acme/api')
    expect(parseRemote('https://github.com/acme/web.app')).toBe('acme/web.app')
    expect(parseRemote('nonsense')).toBeUndefined()
  })

  it('infers from the repository field first, then GitHub links', () => {
    const repos = [{ id: '1', path: '/a', remote: 'Acme/API', defaultBranch: 'main' }]
    expect(inferRepository({ repository: 'acme/api', links: [] }, repos)?.id).toBe('1')
    expect(inferRepository({ links: [{ label: 'PR', url: 'https://github.com/acme/api/pull/3' }] }, repos)?.id).toBe('1')
    expect(inferRepository({ repository: 'acme/other', links: [] }, repos)).toBeUndefined()
  })
})

describe('notificationFor', () => {
  const event = (over: Partial<ActivityEvent>): ActivityEvent => ({
    id: '1',
    type: 'completed',
    source: 'GitHub',
    actor: { kind: 'agent', name: 'Claude Code' },
    title: 'Fix CI',
    actionableDisplayId: 'GT-001',
    createdAt: '',
    ...over,
  })
  it('respects per-type settings', () => {
    expect(notificationFor(event({}), DEFAULT_SETTINGS)).toEqual({ title: 'Agent completed', body: 'GT-001 · Fix CI' })
    expect(notificationFor(event({ type: 'received', outcome: 'created' }), DEFAULT_SETTINGS)).toBeUndefined()
    const off = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, completed: false } }
    expect(notificationFor(event({}), off)).toBeUndefined()
  })
})

describe('AccountService', () => {
  it('retries device registration until the worker is reachable', async () => {
    const db = openDb(':memory:')
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('offline'))
    fetchImpl.mockResolvedValue(Response.json({ deviceId: 'd1', deviceSecret: 's', userId: 'u' }))
    const account = new AccountService({
      meta: jsonTable(db, 'meta'),
      secrets: createSecretStore(db, { encrypt: (v) => Buffer.from(v), decrypt: (b) => Buffer.from(b).toString() }),
      workerUrl: () => 'http://worker.test',
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await account.setName('Lucas')
    expect(account.get()).toMatchObject({ name: 'Lucas', deviceId: undefined })
    expect(await account.ensureDevice()).toBe(true)
    expect(account.get().deviceId).toBe('d1')
    expect(account.worker()).toBeDefined()
  })
})

describe('loginItemSync', () => {
  it('skips the default off value, applies changes once, and logs failures once', () => {
    const set = vi.fn((on: boolean) => {
      if (on) throw new Error('Operation not permitted')
    })
    const log = vi.fn()
    const sync = loginItemSync(set, log)
    sync(false)
    expect(set).not.toHaveBeenCalled()
    sync(true)
    sync(true)
    sync(false)
    sync(true)
    expect(set.mock.calls).toEqual([[true], [false], [true]])
    expect(log).toHaveBeenCalledTimes(1)
  })
})
