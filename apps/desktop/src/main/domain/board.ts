import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import {
  actionsFor,
  canMove,
  FIXED_COLUMNS,
  isCustomColumn,
  TAGS,
  TRIGGERS,
  type Actionable,
  type ActionablePatch,
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
} from '@gantry/shared'
import type { KeyValueStore } from '../contracts'
import type { Db } from '../db'
import { nextDisplayId } from '../db/stores'
import { findRepository } from './repositories'

export interface AgentControl {
  start(id: string, overrides?: DispatchOverrides, auto?: boolean): Promise<void>
  stop(id: string): Promise<void>
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

export const unique = (xs: string[]) => [...new Set(xs)]
export const without = (xs: string[], ...remove: string[]) => xs.filter((x) => !remove.includes(x))
const dedupeKey = (kind: SourceKind, externalKey: string) => `${kind}:${externalKey}`
const mergeLinks = (current: Link[], incoming: Link[]) => [...current, ...incoming.filter((l) => !current.some((c) => c.url === l.url))]
const sourceActor = (signal: IngestSignal): Actor => ({ kind: 'source', name: signal.actor ?? signal.source.name })
const insertAt = <T>(xs: T[], index: number, x: T) => xs.splice(Math.max(0, Math.min(index, xs.length)), 0, x)
export const hasLiveAgent = (a: Pick<Actionable, 'column' | 'agentState'>) => a.column === 'in_progress' && a.agentState !== 'stopped'
const INTERNAL_METADATA = ['aliasIds', 'autoStartOnRepository']
const MAX_ALIASES = 20
const externalMetadata = (m: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(m).filter(([k]) => !INTERNAL_METADATA.includes(k)))
const parseRow = (row: unknown) => (row ? (JSON.parse((row as { data: string }).data) as Actionable) : undefined)

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

  constructor(private deps: BoardDeps) {}

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
    return this.db.prepare('SELECT data FROM actionables').all().map((r) => parseRow(r)!)
  }

  get(id: string) {
    return parseRow(this.db.prepare('SELECT data FROM actionables WHERE id = ?').get(id))
  }

  must(id: string) {
    const a = this.get(id)
    if (!a) throw new Error(`Unknown actionable ${id}`)
    return a
  }

  resolveTarget(target: string) {
    return parseRow(
      this.db.prepare('SELECT data FROM actionables WHERE id = ? OR display_id = ? OR dedupe_key = ?').get(target, target.toUpperCase(), dedupeKey('api', target)) ??
        this.db.prepare("SELECT data FROM actionables WHERE ? IN (SELECT value FROM json_each(data, '$.metadata.aliasIds'))").get(target) ??
        this.byBareExternalId(target),
    )
  }

  private byBareExternalId(externalId: string) {
    const rows = this.db
      .prepare("SELECT data FROM actionables WHERE dedupe_key LIKE 'api:%' AND substr(dedupe_key, -?) = ? LIMIT 2")
      .all(externalId.length + 1, `:${externalId}`)
    return rows.length === 1 ? rows[0] : undefined
  }

  private byKey(kind: SourceKind, externalKey: string) {
    return parseRow(this.db.prepare('SELECT data FROM actionables WHERE dedupe_key = ?').get(dedupeKey(kind, externalKey)))
  }

  private write(a: Actionable) {
    this.db
      .prepare(
        'INSERT INTO actionables (id, display_id, dedupe_key, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(a.id, a.displayId, a.externalKey ? dedupeKey(a.source.kind, a.externalKey) : null, JSON.stringify(a))
    if (a.dispatch)
      this.db
        .prepare(
          'INSERT INTO dispatches (id, actionable_id, started_at, cost_usd, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cost_usd = excluded.cost_usd, data = excluded.data',
        )
        .run(a.dispatch.id, a.id, a.dispatch.startedAt, a.dispatch.costUsd, JSON.stringify(a.dispatch))
  }

  private top(column: ColumnId) {
    const row = this.db
      .prepare("SELECT MIN(json_extract(data, '$.position')) AS p FROM actionables WHERE json_extract(data, '$.column') = ?")
      .get(column) as { p: number | null }
    return (row.p ?? 1) - 1
  }

  save(a: Actionable, event?: EventInput) {
    a.updatedAt = this.iso()
    if (event?.actor.kind === 'user') a.tags = without(a.tags, TAGS.snoozed)
    this.write(a)
    this.deps.push({ type: 'board.changed' })
    if (event) this.log(event, a)
    return a
  }

  update(id: string, mutate: (a: Actionable) => void, event?: EventInput) {
    const a = this.must(id)
    const column = a.column
    mutate(a)
    if (a.column !== column) a.position = this.top(a.column)
    return this.save(a, event)
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
    this.db
      .prepare('INSERT INTO events (id, type, actionable_id, source, title, detail, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(event.id, event.type, event.actionableId ?? null, event.source, event.title, event.detail ?? null, event.createdAt, JSON.stringify(event))
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
    if (existing.dismissedAt && !newTrigger) {
      this.log(received('ignored:duplicate'), existing)
      return { outcome: 'ignored:duplicate', actionableId: existing.id }
    }
    this.update(
      existing.id,
      (a) => {
        a.title = signal.title
        if (signal.body !== undefined) a.body = signal.body
        if (signal.repository) a.repository = signal.repository
        a.links = mergeLinks(a.links, signal.links ?? [])
        a.tags = unique([...a.tags, ...tags])
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
    return { outcome: 'updated', actionableId: existing.id }
  }

  private autoStart(id: string) {
    void this.agents?.start(id, undefined, true).catch((err: Error) => this.log({ type: 'failed', actor: GANTRY, detail: err.message }, this.get(id)))
  }

  repositoryRegistered() {
    const repos = this.deps.repositories()
    for (const card of this.all()) {
      if (!card.tags.includes(TAGS.needsRepository) || !findRepository(repos, card.repository)) continue
      const { autoStartOnRepository, ...metadata } = card.metadata
      this.update(card.id, (a) => {
        a.tags = without(a.tags, TAGS.needsRepository)
        a.metadata = metadata
      })
      if (autoStartOnRepository && !card.dismissedAt && card.column === 'todo') this.autoStart(card.id)
    }
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

  dismiss(target: string) {
    const card = this.apiTarget(target, 'Dismiss')
    if (card) void this.dismissCard(card.id, { kind: 'source', name: card.source.name }).catch((err) => console.error('dismiss failed', err))
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
    if (status !== 'connected') return
    const kind = provider === 'google' ? 'email' : provider
    for (const card of this.all()) {
      if (card.source.kind === kind && card.tags.includes(TAGS.sourceDisconnected)) this.update(card.id, (a) => (a.tags = without(a.tags, TAGS.sourceDisconnected)))
    }
  }

  markSourceDisconnected(kind: SourceKind) {
    for (const card of this.all()) {
      if (card.source.kind !== kind || card.dismissedAt || card.archivedAt || card.tags.includes(TAGS.sourceDisconnected)) continue
      this.update(card.id, (a) => {
        a.tags = unique([...a.tags, TAGS.sourceDisconnected])
      })
    }
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
    const columns = this.columns()
    const from = a.column
    if (column === 'done' && from !== 'done') this.markDoneFields(a)
    if (from === 'done' && column !== 'done') this.reopenFields(a)
    a.column = column
    a.tags = without(a.tags, TAGS.snoozed)
    const siblings = this.all()
      .filter((c) => c.column === column && c.id !== id && !c.archivedAt && !c.dismissedAt)
      .sort((x, y) => x.position - y.position)
    insertAt(siblings, position, a)
    const name = (cid: ColumnId) => columns.find((c) => c.id === cid)?.name ?? cid
    this.db.exec('BEGIN')
    try {
      siblings.forEach((c, i) => {
        if (c.position === i && c !== a) return
        c.position = i
        if (c !== a) this.write(c)
      })
      this.save(a, from === column ? undefined : { type: from === 'done' ? 'reopened' : 'moved', detail: `${name(from)} → ${name(column)}`, actor: USER })
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  snooze(id: string, until: string) {
    const at = Date.parse(until)
    assertAction(this.must(id), 'snooze')
    if (!(at > this.now().getTime())) throw new Error('Snooze time must be in the future')
    this.update(id, (a) => (a.snoozedUntil = new Date(at).toISOString()), { type: 'snoozed', detail: `Until ${new Date(at).toISOString()}`, actor: USER })
  }

  reopenToTodo(id: string, detail?: string) {
    assertAction(this.must(id), 'reopen_todo')
    this.update(
      id,
      (a) => this.reopenFields(a),
      { type: 'reopened', detail, actor: USER },
    )
  }

  markDone(id: string, detail?: string) {
    this.update(id, (a) => this.markDoneFields(a), { type: 'done', detail, actor: USER })
  }

  housekeeping() {
    const now = this.now().getTime()
    const s = this.deps.settings()
    for (const a of this.all()) {
      if (a.snoozedUntil && Date.parse(a.snoozedUntil) <= now)
        this.update(
          a.id,
          (c) => {
            delete c.snoozedUntil
            if (c.column === 'in_progress' || c.column === 'done') return
            c.tags = unique([...c.tags, TAGS.snoozed])
            this.reopenFields(c)
          },
          { type: 'unsnoozed', actor: GANTRY },
        )
      else if (a.column === 'done' && a.doneAt && !a.archivedAt && Date.parse(a.doneAt) <= now - s.archiveDoneAfterDays * DAY_MS)
        this.update(a.id, (c) => (c.archivedAt = this.iso()))
    }
    const cutoff = new Date(now - s.activityRetentionDays * DAY_MS).toISOString()
    this.db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff)
    this.db.prepare('DELETE FROM transcript WHERE at < ?').run(cutoff)
  }

  snapshot(filter: BoardFilter = {}): BoardSnapshot {
    const all = this.all()
    const actionables = all
      .filter(
        (a) =>
          (filter.showArchived || !a.archivedAt) &&
          (filter.showDismissed || !a.dismissedAt) &&
          (filter.showSnoozed || !a.snoozedUntil) &&
          (!filter.sources?.length || filter.sources.includes(a.source.name) || filter.sources.includes(a.source.kind)) &&
          (!filter.providers?.length || (!!a.dispatch && filter.providers.includes(a.dispatch.provider))),
      )
      .sort(compareCards)
    const today = this.startOfToday()
    const live = all.filter((a) => a.column === 'in_progress' && !a.dismissedAt)
    const count = (state: AgentState) => live.filter((a) => a.agentState === state).length
    return {
      columns: this.columns(),
      actionables,
      stats: {
        total: actionables.length,
        running: count('running'),
        paused: count('paused'),
        awaitingInput: count('awaiting_input'),
        completedToday: (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'completed' AND created_at >= ?").get(today) as { n: number }).n,
        costTodayUsd: (this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM dispatches WHERE started_at >= ?').get(today) as { c: number }).c,
      },
    }
  }

  search(query: string) {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return this.all()
      .filter((a) => [a.title, a.body, a.source.name, a.displayId, a.id].some((f) => f?.toLowerCase().includes(q)))
      .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
      .slice(0, 50)
  }

  columns(): Column[] {
    return this.db.prepare('SELECT id, name, kind, position FROM columns ORDER BY position').all() as unknown as Column[]
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
    for (const a of this.all().filter((c) => c.column === id))
      this.update(a.id, (c) => (c.column = 'todo'), { type: 'moved', detail: 'Column removed → To-do', actor: USER })
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
    this.db.prepare('INSERT INTO transcript (dispatch_id, actionable_id, at, event) VALUES (?, ?, ?, ?)').run(dispatchId, actionableId, this.iso(), JSON.stringify(event))
    if (event.type !== 'raw') this.deps.push({ type: 'agent.event', actionableId, event })
  }

  transcript(actionableId: string): TranscriptEntry[] {
    return (this.db.prepare('SELECT at, event FROM transcript WHERE actionable_id = ? ORDER BY rowid').all(actionableId) as { at: string; event: string }[]).map(
      (r) => ({ at: r.at, event: JSON.parse(r.event) as AgentEvent }),
    )
  }

  awaitingInputCount() {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM actionables WHERE json_extract(data, '$.column') = 'in_progress' AND json_extract(data, '$.agentState') = 'awaiting_input' AND json_extract(data, '$.dismissedAt') IS NULL",
        )
        .get() as { n: number }
    ).n
  }

  recordedWorktrees() {
    return this.db
      .prepare("SELECT DISTINCT json_extract(data, '$.repositoryPath') AS repositoryPath, json_extract(data, '$.worktreePath') AS worktreePath FROM dispatches")
      .all() as { repositoryPath: string; worktreePath: string }[]
  }
}
