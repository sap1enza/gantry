import { describe, expect, it } from 'vitest'
import { openDb } from './index'
import { createSecretStore, createSettingsStore, jsonTable, nextDisplayId } from './stores'

describe('db', () => {
  it('migrates once and seeds the fixed columns', () => {
    const db = openDb(':memory:')
    expect(db.prepare('SELECT id FROM columns ORDER BY position').all().map((r) => r.id)).toEqual(['todo', 'in_progress', 'review', 'done'])
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
  })

  it('exposes card fields as indexed generated columns', () => {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO actionables (id, display_id, data) VALUES (?, ?, ?)').run('a', 'GT-001', JSON.stringify({ column: 'done', archivedAt: 'x' }))
    expect(db.prepare('SELECT board_column, archived_at, dismissed_at FROM actionables').get()).toEqual({ board_column: 'done', archived_at: 'x', dismissed_at: null })
  })

  it('issues sequential display ids', () => {
    const meta = jsonTable(openDb(':memory:'), 'meta')
    expect([nextDisplayId(meta), nextDisplayId(meta)]).toEqual(['GT-001', 'GT-002'])
  })

  it('stores secrets only in encrypted form', () => {
    const db = openDb(':memory:')
    const secrets = createSecretStore(db, {
      encrypt: (s) => Buffer.from([...s].reverse().join('')),
      decrypt: (b) => [...Buffer.from(b).toString()].reverse().join(''),
    })
    secrets.set('k', 'secret')
    expect(Buffer.from((db.prepare('SELECT value FROM secrets').get() as { value: Uint8Array }).value).toString()).toBe('terces')
    expect(secrets.get('k')).toBe('secret')
    secrets.clear()
    expect(secrets.get('k')).toBeUndefined()
  })

  it('merges nested settings patches over defaults', () => {
    const settings = createSettingsStore(openDb(':memory:'))
    settings.update({ notifications: { newActionable: true } as never, maxConcurrentAgents: 1 })
    const s = settings.get()
    expect(s.maxConcurrentAgents).toBe(1)
    expect(s.notifications).toEqual({ needsInput: true, completed: true, failed: true, newActionable: true })
    expect(settings.get()).toBe(s)
    expect(settings.update({ maxConcurrentAgents: 2 }).maxConcurrentAgents).toBe(2)
  })
})
