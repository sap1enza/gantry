import { DEEP_LINKS, DEFAULT_SETTINGS, type ActivityEvent } from '@gantry/shared'
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
    expect(parseDeepLink('gantry://actionable/0b5c-uuid')).toEqual({ kind: 'actionable', id: '0b5c-uuid' })
    expect(parseDeepLink('gantry://actionable/GT-012/')).toEqual({ kind: 'actionable', id: 'GT-012' })
    expect(parseDeepLink('gantry://settings')).toBeUndefined()
    expect(parseDeepLink('https://actionable/x')).toBeUndefined()
    expect(parseDeepLink('gantry://actionable/%E0')).toBeUndefined()
    expect(parseDeepLink('gantry://actionable/a/b')).toBeUndefined()
  })

  it('routes auth completion codes and rejects malformed ones', () => {
    expect(parseDeepLink(DEEP_LINKS.authComplete('Ab_9-xY'))).toEqual({ kind: 'authComplete', code: 'Ab_9-xY' })
    expect(parseDeepLink('gantry://auth/complete?code=')).toBeUndefined()
    expect(parseDeepLink('gantry://auth/complete?code=a%27b')).toBeUndefined()
    expect(parseDeepLink('https://auth/complete?code=abc')).toBeUndefined()
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
  const makeAccount = (fetch?: typeof globalThis.fetch) => {
    const db = openDb(':memory:')
    return new AccountService({
      meta: jsonTable(db, 'meta'),
      secrets: createSecretStore(db, { encrypt: (v) => Buffer.from(v), decrypt: (b) => Buffer.from(b).toString() }),
      workerUrl: () => 'http://worker.test',
      fetch,
    })
  }

  it('retries device registration until the worker is reachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('offline'))
    fetchImpl.mockResolvedValue(Response.json({ deviceId: 'd1', deviceSecret: 's', userId: 'u' }))
    const account = makeAccount(fetchImpl as unknown as typeof fetch)
    await account.setName('Lucas')
    expect(account.get()).toMatchObject({ name: 'Lucas', deviceId: undefined })
    expect(await account.ensureDevice()).toBe(true)
    expect(account.get().deviceId).toBe('d1')
    expect(account.worker()).toBeDefined()
  })

  it('asks for a name before signing in', async () => {
    const account = makeAccount()
    await expect(account.signIn('github', async () => {})).rejects.toThrow('Set your name first')
  })
})

describe('loginItemSync', () => {
  it('skips the current OS value, applies changes once, and logs failures once', () => {
    const set = vi.fn((on: boolean) => {
      if (on) throw new Error('Operation not permitted')
    })
    const log = vi.fn()
    const sync = loginItemSync(set, false, log)
    sync(false)
    expect(set).not.toHaveBeenCalled()
    sync(true)
    sync(true)
    sync(false)
    sync(true)
    expect(set.mock.calls).toEqual([[true], [false], [true]])
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('clears an item that is already on at login when the setting is off', () => {
    const set = vi.fn()
    loginItemSync(set, true)(false)
    expect(set).toHaveBeenCalledWith(false)
  })
})
