import { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (key TEXT PRIMARY KEY, value BLOB NOT NULL);
  CREATE TABLE columns (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL);
  INSERT INTO columns VALUES ('todo', 'To-do', 'fixed', 0), ('in_progress', 'In Progress', 'fixed', 1), ('review', 'Review', 'fixed', 2), ('done', 'Done', 'fixed', 3);
  CREATE TABLE actionables (id TEXT PRIMARY KEY, display_id TEXT NOT NULL UNIQUE, dedupe_key TEXT UNIQUE, data TEXT NOT NULL);
  CREATE TABLE dispatches (id TEXT PRIMARY KEY, actionable_id TEXT NOT NULL, started_at TEXT NOT NULL, cost_usd REAL NOT NULL, data TEXT NOT NULL);
  CREATE INDEX dispatches_actionable ON dispatches (actionable_id);
  CREATE TABLE transcript (dispatch_id TEXT NOT NULL, actionable_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL);
  CREATE INDEX transcript_actionable ON transcript (actionable_id);
  CREATE INDEX transcript_at ON transcript (at);
  CREATE TABLE events (id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, actionable_id TEXT, source TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX events_actionable ON events (actionable_id);
  CREATE INDEX events_created ON events (created_at);
  CREATE TABLE repositories (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, remote TEXT NOT NULL, default_branch TEXT NOT NULL, setup_command TEXT);
  `,
  `
  ALTER TABLE actionables ADD COLUMN board_column TEXT GENERATED ALWAYS AS (json_extract(data, '$.column')) VIRTUAL;
  ALTER TABLE actionables ADD COLUMN archived_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.archivedAt')) VIRTUAL;
  ALTER TABLE actionables ADD COLUMN dismissed_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.dismissedAt')) VIRTUAL;
  ALTER TABLE actionables ADD COLUMN snoozed_until TEXT GENERATED ALWAYS AS (json_extract(data, '$.snoozedUntil')) VIRTUAL;
  ALTER TABLE actionables ADD COLUMN agent_state TEXT GENERATED ALWAYS AS (json_extract(data, '$.agentState')) VIRTUAL;
  CREATE INDEX actionables_column ON actionables (board_column);
  CREATE INDEX actionables_archived ON actionables (archived_at);
  CREATE INDEX actionables_dismissed ON actionables (dismissed_at);
  CREATE INDEX actionables_snoozed ON actionables (snoozed_until);
  CREATE INDEX actionables_agent_state ON actionables (agent_state);
  `,
  `DELETE FROM transcript WHERE json_extract(event, '$.type') = 'raw';`,
  `CREATE TABLE reports (id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE, data TEXT NOT NULL);`,
]

export function openDb(path: string): Db {
  const db = new DatabaseSync(path)
  db.function('casefold', { deterministic: true }, (s) => (typeof s === 'string' ? s.toLowerCase() : s))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  MIGRATIONS.slice(version).forEach((sql, i) => {
    db.exec('BEGIN')
    db.exec(sql)
    db.exec(`PRAGMA user_version = ${version + i + 1}`)
    db.exec('COMMIT')
  })
  return db
}
