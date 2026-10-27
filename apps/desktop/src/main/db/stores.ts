import { randomUUID } from 'node:crypto'
import { DEFAULT_SETTINGS, type Repository, type Settings } from '@gantry/shared'
import type { KeyValueStore, SecretStore } from '../contracts'
import type { Db } from './index'

export function jsonTable(db: Db, table: 'kv' | 'meta'): KeyValueStore {
  return {
    get<T>(key: string) {
      const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value: string } | undefined
      return row ? (JSON.parse(row.value) as T) : undefined
    },
    set(key, value) {
      db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
        key,
        JSON.stringify(value),
      )
    },
    delete(key) {
      db.prepare(`DELETE FROM ${table} WHERE key = ?`).run(key)
    },
  }
}

export function nextDisplayId(meta: KeyValueStore) {
  const n = (meta.get<number>('displayCounter') ?? 0) + 1
  meta.set('displayCounter', n)
  return `GT-${String(n).padStart(3, '0')}`
}

export interface Cipher {
  encrypt(plain: string): Uint8Array
  decrypt(data: Uint8Array): string
}

export function createSecretStore(db: Db, cipher: Cipher): SecretStore {
  return {
    get(key) {
      const row = db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: Uint8Array } | undefined
      return row ? cipher.decrypt(row.value) : undefined
    },
    set(key, value) {
      db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        cipher.encrypt(value),
      )
    },
    delete(key) {
      db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
    },
    clear() {
      db.exec('DELETE FROM secrets')
    },
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function createSettingsStore(db: Db) {
  let cached: Settings | undefined
  const load = () => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const settings = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>
    for (const { key, value } of rows) {
      if (!(key in settings)) continue
      const stored: unknown = JSON.parse(value)
      settings[key] = isPlainObject(settings[key]) && isPlainObject(stored) ? { ...settings[key], ...stored } : stored
    }
    return settings as unknown as Settings
  }
  return {
    get: (): Settings => structuredClone((cached ??= load())),
    update(patch: Partial<Settings>): Settings {
      const current = this.get() as unknown as Record<string, unknown>
      const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in current) || value === undefined) continue
        upsert.run(key, JSON.stringify(isPlainObject(current[key]) && isPlainObject(value) ? { ...current[key], ...value } : value))
      }
      cached = undefined
      return this.get()
    },
  }
}
export type SettingsStore = ReturnType<typeof createSettingsStore>

interface RepositoryRow {
  id: string
  path: string
  remote: string
  default_branch: string
  setup_command: string | null
}

const toRepository = (r: RepositoryRow): Repository => ({
  id: r.id,
  path: r.path,
  remote: r.remote,
  defaultBranch: r.default_branch,
  setupCommand: r.setup_command ?? undefined,
})

export function createRepositoryStore(db: Db) {
  return {
    list: () => (db.prepare('SELECT * FROM repositories ORDER BY remote').all() as unknown as RepositoryRow[]).map(toRepository),
    add(repo: Omit<Repository, 'id'>): Repository {
      const existing = db.prepare('SELECT * FROM repositories WHERE path = ?').get(repo.path) as RepositoryRow | undefined
      if (existing) return toRepository(existing)
      const created = { id: randomUUID(), ...repo }
      db.prepare('INSERT INTO repositories (id, path, remote, default_branch, setup_command) VALUES (?, ?, ?, ?, ?)').run(
        created.id,
        created.path,
        created.remote,
        created.defaultBranch,
        created.setupCommand ?? null,
      )
      return created
    },
    setSetupCommand(id: string, setupCommand?: string) {
      db.prepare('UPDATE repositories SET setup_command = ? WHERE id = ?').run(setupCommand?.trim() || null, id)
    },
    remove(id: string) {
      db.prepare('DELETE FROM repositories WHERE id = ?').run(id)
    },
  }
}
export type RepositoryStore = ReturnType<typeof createRepositoryStore>
