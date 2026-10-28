import { randomUUID } from 'node:crypto'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import {
  actionsFor,
  canMove,
  FIXED_COLUMNS,
  isCustomColumn,
  TAGS,
  TRIGGERS,
  type Actionable,
  type ActionablePatch,
  type CardEdit,
  type ActivityEvent,
  type ActivityQuery,
  type AgentEvent,
  type AgentState,
  type BoardFilter,
  type BoardSnapshot,
  type CardAction,
  type Column,
  type ColumnId,
  type DispatchOverrides,
  type GantryPush,
  type IngestResult,
  type IngestSignal,
  type IngestSink,
  type Link,
  type ManualActionableInput,
  type ReceivedOutcome,
  type Repository,
  type ResolveSignal,
  type Settings,
  type SourceKind,
  type TranscriptEntry,
  type TriggerId,
  hasLiveAgent,
  unique,
  without,
} from '@gantry/shared'
import type { KeyValueStore } from '../contracts'
import type { Db } from '../db'
import { nextDisplayId } from '../db/stores'
import { findRepository } from './repositories'

export interface AgentControl {
  start(id: string, overrides?: DispatchOverrides, auto?: boolean): Promise<void>
  stop(id: string): Promise<void>
  drain(): void
}

export interface BoardDeps {
  db: Db
  meta: KeyValueStore
  settings(): Settings
  repositories(): Repository[]
  push(push: GantryPush): void
  now?: () => Date
}

export type Actor = ActivityEvent['actor']

export interface EventInput {
  type: ActivityEvent['type']
  actor: Actor
  title?: string
  detail?: string
  outcome?: ReceivedOutcome
  data?: Record<string, unknown>
  source?: string
}

export const USER: Actor = { kind: 'user', name: 'You' }
export const GANTRY: Actor = { kind: 'gantry', name: 'Gantry' }

const DAY_MS = 86_400_000
const IN_PROGRESS_RANK: Partial<Record<AgentState, number>> = { awaiting_input: 0, running: 1, queued: 2, paused: 3 }

const dedupeKey = (kind: SourceKind, externalKey: string) => `${kind}:${externalKey}`
const mergeLinks = (current: Link[], incoming: Link[]) => [...current, ...incoming.filter((l) => !current.some((c) => c.url === l.url))]
const sourceActor = (signal: IngestSignal): Actor => ({ kind: 'source', name: signal.actor ?? signal.source.name })
const insertAt = <T>(xs: T[], index: number, x: T) => xs.splice(Math.max(0, Math.min(index, xs.length)), 0, x)
const INTERNAL_METADATA = ['aliasIds', 'autoStartOnRepository']
const MAX_ALIASES = 20
const externalMetadata = (m: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(m).filter(([k]) => !INTERNAL_METADATA.includes(k)))
const parseRow = (row: unknown) => (row ? (JSON.parse((row as { data: string }).data) as Actionable) : undefined)
const HAS_TAG = "EXISTS (SELECT 1 FROM json_each(data, '$.tags') WHERE value = ?)"
const SEARCH =
  "(instr(casefold(json_extract(data, '$.title')), ?1) OR instr(casefold(json_extract(data, '$.body')), ?1) OR instr(casefold(json_extract(data, '$.source.name')), ?1) OR instr(casefold(display_id), ?1) OR instr(casefold(id), ?1)) ORDER BY json_extract(data, '$.updatedAt') DESC LIMIT 50"
const SNAPSHOT_BODY_CHARS = 280
const snapshotCard = (a: Actionable): Actionable => ({
  ...a,
  body: a.body?.slice(0, SNAPSHOT_BODY_CHARS),
  dispatch: a.dispatch && { ...a.dispatch, instructions: '' },
})

export function assertAction(a: Actionable, action: CardAction) {
  if (!actionsFor(a).includes(action)) throw new Error(`${a.displayId} cannot ${action.replace('_', ' ')} from ${a.column}`)
}

function compareCards(x: Actionable, y: Actionable) {
  if (x.column === 'in_progress' && y.column === 'in_progress') {
    const rank = (IN_PROGRESS_RANK[x.agentState!] ?? 9) - (IN_PROGRESS_RANK[y.agentState!] ?? 9)
    return rank || (x.dispatch?.startedAt ?? '').localeCompare(y.dispatch?.startedAt ?? '')
  }
  return x.position - y.position
}

type NewCard = Omit<Actionable, 'id' | 'displayId' | 'column' | 'position' | 'createdAt' | 'updatedAt'> & { id?: string }

export class Board implements IngestSink {
  agents?: AgentControl
  private statements = new Map<string, StatementSync>()

  constructor(private deps: BoardDeps) {}

  private sql(query: string) {
    let statement = this.statements.get(query)
    if (!statement) this.statements.set(query, (statement = this.db.prepare(query)))
    return statement
  }

  private where(clause: string, ...args: SQLInputValue[]) {
    return this.sql(`SELECT data FROM actionables WHERE ${clause}`)
      .all(...args)
      .map((r) => parseRow(r)!)
  }

  private transaction(fn: () => void) {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private get db() {
    return this.deps.db
  }

  private now() {
    return this.deps.now?.() ?? new Date()
  }

  private iso() {
    return this.now().toISOString()
  }

  private startOfToday() {
    const d = this.now()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }

  all(): Actionable[] {
    return this.sql('SELECT data FROM actionables').all().map((r) => parseRow(r)!)
  }

  inColumn(column: ColumnId) {
    return this.where('board_column = ?', column)
  }

  get(id: string) {
    return parseRow(this.sql('SELECT data FROM actionables WHERE id = ?').get(id))
  }

  must(id: string) {
    const a = this.get(id)
    if (!a) throw new Error(`Unknown actionable ${id}`)
    return a
  }

  resolveTarget(target: string) {
    return parseRow(
      this.sql('SELECT data FROM actionables WHERE id = ? OR display_id = ? OR dedupe_key = ?').get(target, target.toUpperCase(), dedupeKey('api', target)) ??
        this.sql("SELECT data FROM actionables WHERE ? IN (SELECT value FROM json_each(data, '$.metadata.aliasIds'))").get(target) ??
        this.byBareExternalId(target),
    )
  }

  private byBareExternalId(externalId: string) {
    const rows = this.sql("SELECT data FROM actionables WHERE dedupe_key LIKE 'api:%' AND substr(dedupe_key, -?) = ? LIMIT 2").all(externalId.length + 1, `:${externalId}`)
    return rows.length === 1 ? rows[0] : undefined
  }

  private byKey(kind: SourceKind, externalKey: string) {
    return parseRow(this.sql('SELECT data FROM actionables WHERE dedupe_key = ?').get(dedupeKey(kind, externalKey)))
  }

  private write(a: Actionable) {
    this.sql('INSERT INTO actionables (id, display_id, dedupe_key, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(a.id, a.displayId, a.externalKey ? dedupeKey(a.source.kind, a.externalKey) : null, JSON.stringify(a))
    if (a.dispatch)
      this.sql(
        'INSERT INTO dispatches (id, actionable_id, started_at, cost_usd, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cost_usd = excluded.cost_usd, data = excluded.data',
      ).run(a.dispatch.id, a.id, a.dispatch.startedAt, a.dispatch.costUsd, JSON.stringify(a.dispatch))
  }

  private top(column: ColumnId) {
    const row = this.sql("SELECT MIN(json_extract(data, '$.position')) AS p FROM actionables WHERE board_column = ?").get(column) as { p: number | null }
    return (row.p ?? 1) - 1
  }

  private persist(a: Actionable, event?: EventInput) {
    a.updatedAt = this.iso()
    if (event?.actor.kind === 'user') a.tags = without(a.tags, TAGS.snoozed)
    this.write(a)
  }

  save(a: Actionable, event?: EventInput) {
    this.persist(a, event)
    this.deps.push({ type: 'board.changed' })
    if (event) this.log(event, a)
    return a
  }

  private change<T>(a: Actionable, mutate: (a: Actionable) => T) {
    const column = a.column
    const result = mutate(a)
    if (a.column !== column) a.position = this.top(a.column)
    return result
  }

  update(id: string, mutate: (a: Actionable) => void, event?: EventInput) {
    const a = this.must(id)
    this.change(a, mutate)
    return this.save(a, event)
  }

  updateEach(cards: Actionable[], mutate: (a: Actionable) => EventInput | void) {
    if (!cards.length) return
    this.transaction(() => {
      for (const a of cards) {
        const event = this.change(a, mutate) ?? undefined
        this.persist(a, event)
        if (event) this.log(event, a)
      }
    })
    this.deps.push({ type: 'board.changed' })
  }

  log(input: EventInput, a?: Actionable) {
    const event: ActivityEvent = {
      id: randomUUID(),
      type: input.type,
      actionableId: a?.id,
      actionableDisplayId: a?.displayId,
      source: input.source ?? a?.source.name ?? 'Gantry',
      actor: input.actor,
      title: input.title ?? a?.title ?? input.type,
      detail: input.detail,
      outcome: input.outcome,
      data: input.data,
      createdAt: this.iso(),
    }
    this.sql('INSERT INTO events (id, type, actionable_id, source, title, detail, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(event.id, event.type, event.actionableId ?? null, event.source, event.title, event.detail ?? null, event.createdAt, JSON.stringify(event))
    this.deps.push({ type: 'activity.appended', event })
    return event
  }

  private insert(fields: NewCard, event: EventInput) {
    const now = this.iso()
    const id = fields.id && !this.get(fields.id) ? fields.id : randomUUID()
    const a: Actionable = {
      ...fields,
      id,
      displayId: nextDisplayId(this.deps.meta),
      column: 'todo',
      position: this.top('todo'),
      createdAt: now,
      updatedAt: now,
    }
    return this.save(a, event)
  }

  private reopenFields(a: Actionable) {
    a.column = 'todo'
    a.tags = without(a.tags, TAGS.resolvedExternally)
    delete a.doneAt
    delete a.archivedAt
  }

  private markDoneFields(a: Actionable) {
    a.column = 'done'
    a.doneAt = this.iso()
    delete a.snoozedUntil
    if (!this.deps.settings().keepCompleted) a.archivedAt = a.doneAt
  }

  ingest(signal: IngestSignal): IngestResult {
    const existing = this.byKey(signal.source.kind, signal.externalKey)
    const actor = sourceActor(signal)
    const received = (outcome: ReceivedOutcome): EventInput => ({ type: 'received', outcome, detail: signal.receivedDetail, actor })
    const tags = [TRIGGERS[signal.trigger].tag, ...(signal.tags ?? []), ...(signal.aiDetected ? [TAGS.aiDetected] : [])]

    if (!existing) {
      const needsRepository = signal.source.kind === 'api' && !findRepository(this.deps.repositories(), signal.repository)
      const a = this.insert(
        {
          id: signal.id,
          title: signal.title,
          body: signal.body,
          source: signal.source,
          externalKey: signal.externalKey,
          triggers: [signal.trigger],
          links: signal.links ?? [],
          repository: signal.repository,
          instructions: signal.instructions,
          priority: signal.priority,
          tags: unique(needsRepository ? [...tags, TAGS.needsRepository] : tags),
          metadata: { ...externalMetadata(signal.metadata), ...(needsRepository && signal.autoStart ? { autoStartOnRepository: true } : {}) },
        },
        received('created'),
      )
      if (signal.autoStart && !needsRepository) this.autoStart(a.id)
      return { outcome: 'created', actionableId: a.id }
    }

    const newTrigger = !existing.triggers.includes(signal.trigger)
    const unsnoozesQueue = existing.column === 'in_progress' && !!existing.snoozedUntil
    if (existing.dismissedAt && !newTrigger) {
      this.log(received('ignored:duplicate'), existing)
      return { outcome: 'ignored:duplicate', actionableId: existing.id }
    }
    this.update(
      existing.id,
      (a) => {
        const userEdited = (a.metadata.userEdited as string[] | undefined) ?? []
        const removedTags = (a.metadata.removedTags as string[] | undefined) ?? []
        if (!userEdited.includes('title')) a.title = signal.title
        if (signal.body !== undefined && !userEdited.includes('body')) a.body = signal.body
        if (signal.repository) a.repository = signal.repository
        a.links = mergeLinks(a.links, signal.links ?? [])
        a.tags = unique([...a.tags, ...tags.filter((t) => !removedTags.includes(t))])
        a.triggers = unique([...a.triggers, signal.trigger])
        a.metadata = { ...a.metadata, ...externalMetadata(signal.metadata) }
        if (signal.id && signal.id !== a.id) a.metadata.aliasIds = unique([...((a.metadata.aliasIds as string[] | undefined) ?? []), signal.id]).slice(-MAX_ALIASES)
        if (a.dismissedAt || a.column === 'done' || (a.snoozedUntil && a.column !== 'in_progress')) {
          this.reopenFields(a)
          delete a.dismissedAt
        }
        delete a.snoozedUntil
      },
      received('updated'),
    )
    if (unsnoozesQueue) this.agents?.drain()
    return { outcome: 'updated', actionableId: existing.id }
  }

  private autoStart(id: string) {
    void this.agents?.start(id, undefined, true).catch((err: Error) => this.log({ type: 'failed', actor: GANTRY, detail: err.message }, this.get(id)))
  }

  repositoryRegistered() {
    const repos = this.deps.repositories()
    const cards = this.where(HAS_TAG, TAGS.needsRepository).filter((a) => findRepository(repos, a.repository))
    const autoStart = cards.filter((a) => a.metadata.autoStartOnRepository && !a.dismissedAt && a.column === 'todo')
    this.updateEach(cards, (a) => {
      const { autoStartOnRepository: _, ...metadata } = a.metadata
      a.tags = without(a.tags, TAGS.needsRepository)
      a.metadata = metadata
    })
    for (const a of autoStart) this.autoStart(a.id)
  }

  logIgnored(signal: IngestSignal, outcome: Extract<ReceivedOutcome, `ignored:${string}`>, reason: string) {
    this.log(
      { type: 'received', outcome, detail: reason, title: signal.title, source: signal.source.name, actor: sourceActor(signal) },
      this.byKey(signal.source.kind, signal.externalKey),
    )
  }

  resolve(signal: ResolveSignal) {
    const def = TRIGGERS[signal.trigger]
    const card = def.autoResolves ? this.byKey(def.source, signal.externalKey) : undefined
    if (!card || card.dismissedAt || card.column === 'done' || !card.tags.includes(def.tag)) return
    this.update(
      card.id,
      (a) => {
        a.tags = without(a.tags, def.tag)
        if (a.triggers.some((t) => a.tags.includes(TRIGGERS[t as TriggerId]?.tag))) return
        a.tags.push(TAGS.resolvedExternally)
        if (a.column === 'todo') this.markDoneFields(a)
      },
      { type: 'resolved_externally', detail: `${def.label}: ${signal.reason}`, actor: { kind: 'source', name: card.source.name } },
    )
  }

  private apiTarget(target: string, action: string) {
    const card = this.resolveTarget(target)
    if (card?.source.kind === 'api') return card
    this.log({
      type: 'received',
      outcome: 'ignored:filtered',
      title: `${action} for ${card ? 'non-API' : 'unknown'} actionable ${target}`,
      source: 'API',
      actor: { kind: 'source', name: 'API' },
    })
  }

  applyPatch(target: string, patch: ActionablePatch) {
    const card = this.apiTarget(target, 'Update')
    if (!card) return
    this.update(
      card.id,
      (a) => {
        if (patch.title) a.title = patch.title
        if (patch.body !== undefined) a.body = patch.body
        if (patch.links) a.links = patch.links
        if (patch.tags) a.tags = unique([...a.tags, ...patch.tags])
      },
      { type: 'received', outcome: 'updated', detail: 'Updated via API', actor: { kind: 'source', name: card.source.name } },
    )
  }

  async dismiss(target: string) {
    const card = this.apiTarget(target, 'Dismiss')
    if (card) await this.dismissCard(card.id, { kind: 'source', name: card.source.name })
  }

  async dismissCard(id: string, actor: Actor) {
    const card = this.must(id)
    if (card.dismissedAt) return
    assertAction(card, 'dismiss')
    if (hasLiveAgent(card)) await this.agents?.stop(id)
    this.update(
      id,
      (a) => {
        a.dismissedAt = this.iso()
        delete a.snoozedUntil
      },
      { type: 'dismissed', actor },
    )
  }

  logConnection(provider: string, status: string, detail?: string) {
    this.log({ type: 'connection', title: `${provider}: ${status.replaceAll('_', ' ')}`, detail, source: provider, actor: { kind: 'source', name: provider } })
  }

  markSourceConnected(kind: SourceKind) {
    this.updateEach(this.where(`json_extract(data, '$.source.kind') = ? AND ${HAS_TAG}`, kind, TAGS.sourceDisconnected), (a) => {
      a.tags = without(a.tags, TAGS.sourceDisconnected)
    })
  }

  markSourceDisconnected(kind: SourceKind) {
    const clause = `json_extract(data, '$.source.kind') = ? AND dismissed_at IS NULL AND archived_at IS NULL AND NOT ${HAS_TAG}`
    this.updateEach(this.where(clause, kind, TAGS.sourceDisconnected), (a) => {
      a.tags = [...a.tags, TAGS.sourceDisconnected]
    })
  }

  edit(id: string, patch: CardEdit) {
    const title = patch.title?.trim()
    if (patch.title !== undefined && !title) throw new Error('Title is required')
    const systemTags: string[] = Object.values(TAGS)
    this.update(
      id,
      (a) => {
        const userEdited = (a.metadata.userEdited as string[] | undefined) ?? []
        if (title) a.title = title
        if (patch.body !== undefined) a.body = patch.body.trim() || undefined
        if (patch.priority !== undefined) a.priority = patch.priority ?? undefined
        if (patch.tags) {
          const tags = unique([...a.tags.filter((t) => systemTags.includes(t)), ...patch.tags.map((t) => t.trim()).filter(Boolean)])
          const removed = a.tags.filter((t) => !tags.includes(t))
          a.metadata.removedTags = unique([...((a.metadata.removedTags as string[] | undefined) ?? []), ...removed]).filter((t) => !tags.includes(t))
          a.tags = tags
        }
        a.metadata.userEdited = unique([...userEdited, ...(title ? ['title'] : []), ...(patch.body !== undefined ? ['body'] : [])])
      },
      { type: 'edited', actor: USER },
    )
  }

  create(input: ManualActionableInput) {
    const title = input.title.trim()
    if (!title) throw new Error('Title is required')
    return this.insert(
      {
        title,
        body: input.body,
        source: { kind: 'manual', name: input.sourceName?.trim() || 'Manual' },
        triggers: ['manual'],
        links: input.links ?? [],
        repository: input.repository,
        priority: input.priority,
        tags: [],
        metadata: {},
      },
      { type: 'received', outcome: 'created', actor: USER },
    )
  }

  assertMove(a: Actionable, column: ColumnId) {
    if (!this.columns().some((c) => c.id === column) || !canMove(a, column)) throw new Error(`${a.displayId} cannot move to ${column}`)
  }

  move(id: string, column: ColumnId, position: number) {
    const a = this.must(id)
    this.assertMove(a, column)
    const from = a.column
    if ((from === 'done') !== (column === 'done')) throw new Error(`${a.displayId} enters and leaves Done through Done and Reopen`)
    const columns = this.columns()
    a.column = column
    a.tags = without(a.tags, TAGS.snoozed)
    const siblings = this.where('board_column = ? AND id != ? AND archived_at IS NULL AND dismissed_at IS NULL', column, id).sort((x, y) => x.position - y.position)
    insertAt(siblings, position, a)
    const name = (cid: ColumnId) => columns.find((c) => c.id === cid)?.name ?? cid
    this.transaction(() => {
      siblings.forEach((c, i) => {
        if (c.position === i && c !== a) return
        c.position = i
        if (c !== a) this.write(c)
      })
      this.save(a, from === column ? undefined : { type: 'moved', detail: `${name(from)} → ${name(column)}`, actor: USER })
    })
  }

  snooze(id: string, until: string) {
    const at = Date.parse(until)
    assertAction(this.must(id), 'snooze')
    if (!(at > this.now().getTime())) throw new Error('Snooze time must be in the future')
    this.update(id, (a) => (a.snoozedUntil = new Date(at).toISOString()), { type: 'snoozed', detail: `Until ${new Date(at).toISOString()}`, actor: USER })
  }

  reopenToTodo(id: string, detail?: string) {
    const a = this.must(id)
    if (a.column !== 'done') throw new Error(`${a.displayId} is not done`)
    this.update(id, (a) => this.reopenFields(a), { type: 'reopened', detail, actor: USER })
  }

  markDone(id: string, detail?: string) {
    this.update(id, (a) => this.markDoneFields(a), { type: 'done', detail, actor: USER })
  }

  housekeeping() {
    const now = this.now().getTime()
    const s = this.deps.settings()
    const iso = new Date(now).toISOString()
    const archiveBefore = new Date(now - s.archiveDoneAfterDays * DAY_MS).toISOString()
    const due = this.where(
      "snoozed_until <= ? OR (board_column = 'done' AND archived_at IS NULL AND json_extract(data, '$.doneAt') <= ?)",
      iso,
      archiveBefore,
    )
    let unsnoozedInProgress = false
    this.updateEach(due, (c) => {
      if (!c.snoozedUntil || c.snoozedUntil > iso) return void (c.archivedAt = iso)
      delete c.snoozedUntil
      unsnoozedInProgress ||= c.column === 'in_progress'
      if (c.column !== 'in_progress' && c.column !== 'done') {
        c.tags = unique([...c.tags, TAGS.snoozed])
        this.reopenFields(c)
      }
      return { type: 'unsnoozed', actor: GANTRY }
    })
    const cutoff = new Date(now - s.activityRetentionDays * DAY_MS).toISOString()
    this.sql('DELETE FROM events WHERE created_at < ?').run(cutoff)
    this.sql('DELETE FROM transcript WHERE at < ?').run(cutoff)
    if (unsnoozedInProgress) this.agents?.drain()
  }

  snapshot(filter: BoardFilter = {}): BoardSnapshot {
    const actionables = this.where(
      '(? OR archived_at IS NULL) AND (? OR dismissed_at IS NULL) AND (? OR snoozed_until IS NULL)',
      Number(!!filter.showArchived),
      Number(!!filter.showDismissed),
      Number(!!filter.showSnoozed),
    )
      .filter(
        (a) =>
          (!filter.sources?.length || filter.sources.includes(a.source.name) || filter.sources.includes(a.source.kind)) &&
          (!filter.providers?.length || (!!a.dispatch && filter.providers.includes(a.dispatch.provider))),
      )
      .sort(compareCards)
    const today = this.startOfToday()
    const live = this.sql(
      "SELECT agent_state AS state, COUNT(*) AS n FROM actionables WHERE board_column = 'in_progress' AND dismissed_at IS NULL GROUP BY agent_state",
    ).all() as { state: AgentState | null; n: number }[]
    const count = (state: AgentState) => live.find((r) => r.state === state)?.n ?? 0
    return {
      columns: this.columns(),
      actionables: actionables.map(snapshotCard),
      stats: {
        total: actionables.length,
        running: count('running'),
        paused: count('paused'),
        awaitingInput: count('awaiting_input'),
        completedToday: (this.sql("SELECT COUNT(*) AS n FROM events WHERE type = 'completed' AND created_at >= ?").get(today) as { n: number }).n,
        costTodayUsd: (this.sql('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM dispatches WHERE started_at >= ?').get(today) as { c: number }).c,
      },
    }
  }

  search(query: string) {
    const q = query.trim().toLowerCase()
    return q ? this.where(SEARCH, q) : []
  }

  columns(): Column[] {
    return this.sql('SELECT id, name, kind, position FROM columns ORDER BY position').all() as unknown as Column[]
  }

  private writeColumnOrder(ids: ColumnId[]) {
    if (ids.filter((id) => !isCustomColumn(id)).join() !== FIXED_COLUMNS.join())
      throw new Error('Fixed columns keep their relative order')
    const stmt = this.db.prepare('UPDATE columns SET position = ? WHERE id = ?')
    ids.forEach((id, i) => stmt.run(i, id))
    this.deps.push({ type: 'board.changed' })
  }

  createColumn(name: string, position: number): Column {
    if (!name.trim()) throw new Error('Column name is required')
    const id = randomUUID()
    const ids = this.columns().map((c) => c.id)
    insertAt(ids, position, id)
    this.db.prepare("INSERT INTO columns (id, name, kind, position) VALUES (?, ?, 'custom', ?)").run(id, name.trim(), ids.length)
    this.writeColumnOrder(ids)
    return this.columns().find((c) => c.id === id)!
  }

  renameColumn(id: ColumnId, name: string) {
    if (!name.trim()) throw new Error('Column name is required')
    this.db.prepare('UPDATE columns SET name = ? WHERE id = ?').run(name.trim(), id)
    this.deps.push({ type: 'board.changed' })
  }

  moveColumn(id: ColumnId, position: number) {
    const ids = this.columns()
      .map((c) => c.id)
      .filter((c) => c !== id)
    insertAt(ids, position, id)
    this.writeColumnOrder(ids)
  }

  removeColumn(id: ColumnId) {
    if (!this.columns().some((c) => c.id === id && c.kind === 'custom')) throw new Error('Only custom columns can be removed')
    this.updateEach(this.inColumn(id), (c) => {
      c.column = 'todo'
      return { type: 'moved', detail: 'Column removed → To-do', actor: USER }
    })
    this.db.prepare('DELETE FROM columns WHERE id = ?').run(id)
    this.writeColumnOrder(this.columns().map((c) => c.id))
  }

  events(q: ActivityQuery) {
    const limit = q.limit ?? 100
    const where: string[] = []
    const args: SQLInputValue[] = []
    const add = (sql: string, ...values: SQLInputValue[]) => {
      where.push(sql)
      args.push(...values)
    }
    const list = (values: string[]) => values.map(() => '?').join(', ')
    if (q.types?.length) add(`type IN (${list(q.types)})`, ...q.types)
    if (q.sources?.length) add(`source IN (${list(q.sources)})`, ...q.sources)
    if (q.actionableId) add('actionable_id = ?', q.actionableId)
    if (q.text) add('(title LIKE ? OR detail LIKE ?)', `%${q.text}%`, `%${q.text}%`)
    if (q.since) add('created_at >= ?', q.since)
    if (q.until) add('created_at <= ?', q.until)
    if (q.cursor) add('rowid < ?', Number(q.cursor))
    const rows = this.db
      .prepare(`SELECT rowid, data FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid DESC LIMIT ?`)
      .all(...args, limit + 1) as { rowid: number; data: string }[]
    const page = rows.slice(0, limit)
    return {
      events: page.map((r) => JSON.parse(r.data) as ActivityEvent),
      nextCursor: rows.length > limit ? String(page.at(-1)!.rowid) : undefined,
      totalToday: (this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE created_at >= ?').get(this.startOfToday()) as { n: number }).n,
    }
  }

  appendTranscript(actionableId: string, dispatchId: string, event: AgentEvent) {
    if (event.type === 'raw') return
    this.sql('INSERT INTO transcript (dispatch_id, actionable_id, at, event) VALUES (?, ?, ?, ?)').run(dispatchId, actionableId, this.iso(), JSON.stringify(event))
    this.deps.push({ type: 'agent.event', actionableId, event })
  }

  transcript(actionableId: string): TranscriptEntry[] {
    const rows = this.sql('SELECT at, event FROM transcript WHERE actionable_id = ? ORDER BY rowid').all(actionableId) as { at: string; event: string }[]
    return rows.map((r) => ({ at: r.at, event: JSON.parse(r.event) as AgentEvent }))
  }

  awaitingInputCount() {
    return (
      this.sql("SELECT COUNT(*) AS n FROM actionables WHERE board_column = 'in_progress' AND agent_state = 'awaiting_input' AND dismissed_at IS NULL").get() as {
        n: number
      }
    ).n
  }

  recordedWorktrees() {
    return this.db
      .prepare("SELECT DISTINCT json_extract(data, '$.repositoryPath') AS repositoryPath, json_extract(data, '$.worktreePath') AS worktreePath FROM dispatches")
      .all() as { repositoryPath: string; worktreePath: string }[]
  }
}
