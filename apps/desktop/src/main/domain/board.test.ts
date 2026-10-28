import { TAGS } from '@gantry/shared'
import { describe, expect, it, vi } from 'vitest'
import { flush, setup, signal } from './testing'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const apiSignal = (over = {}) =>
  signal({
    id: 'wrk-1',
    trigger: 'api.custom',
    source: { kind: 'api', name: 'Honeybadger' },
    externalKey: 'Honeybadger:hb-1',
    title: 'Checkout timeout',
    links: [],
    ...over,
  })

describe('ingest dedupe', () => {
  it('keeps one card per external entity and adds the new trigger tag', () => {
    const { board, eventTypes } = setup()
    const first = board.ingest(signal({ body: 'old' }))
    const second = board.ingest(signal({ trigger: 'github.merge_conflict', body: 'new', links: [{ label: 'Checks', url: 'https://ci/1' }] }))
    expect(first.outcome).toBe('created')
    expect(second).toEqual({ outcome: 'updated', actionableId: first.actionableId })
    const card = board.must(first.actionableId!)
    expect(board.all()).toHaveLength(1)
    expect(card.tags).toEqual(['CI failed', 'Merge conflicts'])
    expect(card.body).toBe('new')
    expect(card.links.map((l) => l.url)).toEqual(['https://github.com/acme/api/pull/1', 'https://ci/1'])
    expect(card.displayId).toBe('GT-001')
    expect(eventTypes(card.id)).toEqual(['received', 'received'])
  })

  it('edits title, body, priority and user tags while keeping system tags', () => {
    const { board, eventTypes } = setup()
    const { actionableId: id } = board.ingest(signal())
    board.update(id!, (a) => (a.tags = ['issue', TAGS.failed]))
    board.edit(id!, { title: ' Renamed ', body: '', priority: 'high', tags: ['bug', ' ', 'bug'] })
    expect(board.must(id!)).toMatchObject({ title: 'Renamed', priority: 'high', tags: [TAGS.failed, 'bug'] })
    expect(board.must(id!).body).toBeUndefined()
    expect(eventTypes(id!).at(-1)).toBe('edited')
    expect(() => board.edit(id!, { title: '  ' })).toThrow('Title is required')
  })

  it('filters the snapshot by any selected tag', () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal())
    board.create({ title: 'Untagged' })
    board.edit(id!, { tags: ['bug'] })
    expect(board.snapshot({ tags: ['bug', 'other'] }).actionables.map((a) => a.id)).toEqual([id])
  })

  it('keeps user edits and removed tags when the source signals again', () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal({ tags: ['issue'] }))
    board.edit(id!, { title: 'Mine', tags: [] })
    board.ingest(signal({ tags: ['issue'], title: 'From source', body: 'new body' }))
    expect(board.must(id!)).toMatchObject({ title: 'Mine', body: 'new body', tags: [] })
  })

  it('returns Done cards to To-do', () => {
    const { board } = setup()
    const { actionableId } = board.ingest(signal())
    board.markDone(actionableId!)
    board.ingest(signal())
    expect(board.must(actionableId!)).toMatchObject({ column: 'todo' })
    expect(board.must(actionableId!).doneAt).toBeUndefined()
  })

  it('returns snoozed cards to To-do', () => {
    const { board } = setup()
    board.createColumn('Waiting', 1)
    const waiting = board.columns().find((c) => c.name === 'Waiting')!.id
    const { actionableId: id } = board.ingest(signal())
    board.move(id!, waiting, 0)
    board.snooze(id!, '2026-10-28T09:00:00.000Z')
    board.ingest(signal())
    expect(board.must(id!).column).toBe('todo')
    expect(board.must(id!).snoozedUntil).toBeUndefined()
  })

  it('keeps dismissed cards dismissed unless the trigger type is new', async () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal())
    await board.dismissCard(id!, { kind: 'user', name: 'You' })
    expect(board.ingest(signal()).outcome).toBe('ignored:duplicate')
    expect(board.must(id!).dismissedAt).toBeDefined()
    expect(board.ingest(signal({ trigger: 'github.changes_requested' })).outcome).toBe('updated')
    expect(board.must(id!).dismissedAt).toBeUndefined()
    expect(board.must(id!).column).toBe('todo')
  })
})

describe('auto-resolve', () => {
  it('moves To-do cards to Done tagged Resolved externally', () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal())
    board.resolve({ trigger: 'github.ci_failed', externalKey: signal().externalKey, reason: 'checks green' })
    expect(board.must(id!)).toMatchObject({ column: 'done', tags: [TAGS.resolvedExternally] })
  })

  it('only tags cards that are in progress', async () => {
    const { board, runner } = setup()
    const { actionableId: id } = board.ingest(signal())
    await runner.start(id!)
    board.resolve({ trigger: 'github.ci_failed', externalKey: signal().externalKey, reason: 'checks green' })
    expect(board.must(id!).column).toBe('in_progress')
    expect(board.must(id!).tags).toContain(TAGS.resolvedExternally)
  })

  it('stays open while another trigger is still active', () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal())
    board.ingest(signal({ trigger: 'github.merge_conflict' }))
    board.resolve({ trigger: 'github.ci_failed', externalKey: signal().externalKey, reason: 'checks green' })
    expect(board.must(id!)).toMatchObject({ column: 'todo', tags: ['Merge conflicts'] })
  })

  it('never resolves triggers without autoResolves', () => {
    const { board } = setup()
    const custom = signal({ trigger: 'api.custom', source: { kind: 'api', name: 'Honeybadger' }, externalKey: 'hb-1' })
    const { actionableId: id } = board.ingest(custom)
    board.resolve({ trigger: 'api.custom', externalKey: 'hb-1', reason: 'fixed' })
    expect(board.must(id!).column).toBe('todo')
  })
})

describe('api actionables', () => {
  it('is idempotent on source name + external id and adopts the worker id', () => {
    const { board } = setup()
    const first = board.ingest(apiSignal({ repository: 'acme/api' }))
    const again = board.ingest(apiSignal({ id: 'wrk-2', title: 'Checkout timeout (x2)', repository: 'acme/api' }))
    expect(first.actionableId).toBe('wrk-1')
    expect(again).toEqual({ outcome: 'updated', actionableId: 'wrk-1' })
    expect(board.must('wrk-1').tags).not.toContain(TAGS.needsRepository)
  })

  it('resolves deduped worker ids as aliases of the existing card', async () => {
    const { board } = setup()
    board.ingest(apiSignal())
    board.ingest(apiSignal({ id: 'wrk-2' }))
    expect(board.resolveTarget('wrk-2')?.id).toBe('wrk-1')
    board.ingest(apiSignal({ id: 'wrk-3', metadata: { aliasIds: 5, autoStartOnRepository: true } }))
    expect(board.must('wrk-1').metadata).toEqual({ aliasIds: ['wrk-2', 'wrk-3'] })
    board.applyPatch('wrk-2', { title: 'Via alias' })
    expect(board.must('wrk-1').title).toBe('Via alias')
    board.dismiss('wrk-2')
    await vi.waitFor(() => expect(board.must('wrk-1').dismissedAt).toBeDefined())
  })

  it('tags Needs repository when no registered repository matches and skips auto start', () => {
    const { board } = setup()
    const start = vi.spyOn(board.agents!, 'start')
    board.ingest(apiSignal({ repository: 'acme/unknown', autoStart: true }))
    expect(board.must('wrk-1').tags).toContain(TAGS.needsRepository)
    expect(start).not.toHaveBeenCalled()
  })

  it('auto starts with defaults, bypassing confirmation', () => {
    const { board, settings } = setup()
    settings.update({ confirmBeforeDispatch: true })
    const start = vi.spyOn(board.agents!, 'start')
    board.ingest(apiSignal({ repository: 'acme/api', autoStart: true }))
    expect(start).toHaveBeenCalledWith('wrk-1', undefined, true)
  })

  it('patches and dismisses by id, display id, or source:external_id', async () => {
    const { board } = setup()
    board.ingest(apiSignal())
    board.applyPatch('Honeybadger:hb-1', { title: 'Renamed', tags: ['production'] })
    board.applyPatch('gt-001', { body: 'details' })
    expect(board.must('wrk-1')).toMatchObject({ title: 'Renamed', body: 'details' })
    expect(board.must('wrk-1').tags).toContain('production')
    board.dismiss('wrk-1')
    await vi.waitFor(() => expect(board.must('wrk-1').dismissedAt).toBeDefined())
  })

  it('matches a bare external id against the stored source:external_id key', () => {
    const { board } = setup()
    board.ingest(apiSignal())
    board.applyPatch('hb-1', { title: 'By external id' })
    expect(board.must('wrk-1').title).toBe('By external id')
    board.ingest(apiSignal({ id: 'wrk-9', source: { kind: 'api', name: 'Sentry' }, externalKey: 'Sentry:hb-1' }))
    expect(board.resolveTarget('hb-1')).toBeUndefined()
  })

  it('ignores patches and dismissals aimed at non-API cards', async () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal())
    board.applyPatch('GT-001', { title: 'Hijacked' })
    board.dismiss(id!)
    await flush()
    expect(board.must(id!).title).toBe('Fix CI')
    expect(board.must(id!).dismissedAt).toBeUndefined()
    const outcomes = board.events({ types: ['received'] }).events.map((e) => e.outcome)
    expect(outcomes.slice(0, 2)).toEqual(['ignored:filtered', 'ignored:filtered'])
  })
})

describe('source disconnect', () => {
  it('tags open cards from that source once and leaves other sources alone', () => {
    const { board } = setup()
    const { actionableId: gh } = board.ingest(signal())
    const { actionableId: api } = board.ingest(apiSignal())
    board.markSourceDisconnected('github')
    board.markSourceDisconnected('github')
    expect(board.must(gh!).tags.filter((t) => t === TAGS.sourceDisconnected)).toHaveLength(1)
    expect(board.must(api!).tags).not.toContain(TAGS.sourceDisconnected)
  })

  it('clears the tag when the source reconnects', () => {
    const { board } = setup()
    const { actionableId: gh } = board.ingest(signal())
    board.markSourceDisconnected('github')
    board.markSourceConnected('api')
    expect(board.must(gh!).tags).toContain(TAGS.sourceDisconnected)
    board.markSourceConnected('github')
    expect(board.must(gh!).tags).not.toContain(TAGS.sourceDisconnected)
  })
})

describe('guarded user transitions', () => {
  it('rejects drags into agent-driven columns and unknown columns', () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal())
    expect(() => board.move(id!, 'in_progress', 0)).toThrow()
    expect(() => board.move(id!, 'review', 0)).toThrow()
    expect(() => board.move(id!, 'nope', 0)).toThrow()
  })

  it('only moves into or out of Done through the runner', () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal())
    expect(() => board.move(id!, 'done', 0)).toThrow(/Done/)
    board.markDone(id!)
    expect(() => board.move(id!, 'todo', 0)).toThrow(/Done/)
  })

  it('archives immediately on Done when keepCompleted is off', async () => {
    const { board, runner, settings } = setup()
    settings.update({ keepCompleted: false })
    const { actionableId: id } = board.ingest(signal())
    await runner.move(id!, 'done', 0)
    expect(board.must(id!).archivedAt).toBeDefined()
    expect(board.snapshot().actionables).toHaveLength(0)
    await runner.move(id!, 'todo', 0)
    expect(board.must(id!).column).toBe('todo')
    expect(board.must(id!).archivedAt).toBeUndefined()
  })

  it('reopens Done cards to To-do only from Done', () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal())
    expect(() => board.reopenToTodo(id!)).toThrow()
    board.markDone(id!)
    board.reopenToTodo(id!)
    expect(board.must(id!).column).toBe('todo')
  })

  it('logs done and reopened when a card is dragged into and out of Done', async () => {
    const { board, runner, eventTypes } = setup()
    const { actionableId: id } = board.ingest(signal())
    const blocked = board.createColumn('Blocked', 1)
    await runner.move(id!, 'done', 0)
    await runner.move(id!, blocked.id, 0)
    expect(eventTypes(id).slice(-3)).toEqual(['done', 'reopened', 'moved'])
    expect(board.must(id!).column).toBe(blocked.id)
    expect(board.must(id!).doneAt).toBeUndefined()
  })

  it('refuses to snooze from Review or into the past', async () => {
    const { board, runner, provider } = setup()
    const { actionableId: id } = board.ingest(signal())
    expect(() => board.snooze(id!, '2026-10-27T11:00:00.000Z')).toThrow()
    await runner.start(id!)
    await flush()
    provider.emit(id!, { type: 'state', state: 'completed' })
    expect(() => board.snooze(id!, '2026-10-28T09:00:00.000Z')).toThrow()
  })

  it('reorders within a column', () => {
    const { board } = setup()
    const a = board.create({ title: 'A' })
    const b = board.create({ title: 'B' })
    expect(board.snapshot().actionables.map((c) => c.title)).toEqual(['B', 'A'])
    board.move(b.id, 'todo', 1)
    expect(board.snapshot().actionables.map((c) => c.title)).toEqual(['A', 'B'])
    expect(a.source).toEqual({ kind: 'manual', name: 'Manual' })
  })

  it('keeps fixed columns in relative order', () => {
    const { board } = setup()
    expect(() => board.moveColumn('done', 0)).toThrow()
    const custom = board.createColumn('Blocked', 0)
    board.moveColumn('todo', 0)
    expect(board.columns().map((c) => c.id)).toEqual(['todo', custom.id, 'in_progress', 'review', 'done'])
    expect(() => board.moveColumn('todo', 2)).toThrow()
    expect(() => board.removeColumn('todo')).toThrow()
  })
})

describe('housekeeping', () => {
  it('unsnoozes expired cards', () => {
    const { board, advance, eventTypes } = setup()
    const { actionableId: id } = board.ingest(signal())
    board.snooze(id!, '2026-10-27T13:00:00.000Z')
    expect(board.snapshot().actionables).toHaveLength(0)
    advance(HOUR)
    board.housekeeping()
    expect(board.must(id!).snoozedUntil).toBeUndefined()
    expect(eventTypes(id)).toEqual(['received', 'snoozed', 'unsnoozed'])
  })

  it('returns expired snoozes to To-do tagged Snoozed until the user acts', () => {
    const { board, advance } = setup()
    const { actionableId: id } = board.ingest(signal())
    board.createColumn('Later', 1)
    const later = board.columns().find((c) => c.name === 'Later')!.id
    board.move(id!, later, 0)
    board.snooze(id!, '2026-10-27T13:00:00.000Z')
    advance(HOUR)
    board.housekeeping()
    expect(board.must(id!)).toMatchObject({ column: 'todo', tags: expect.arrayContaining([TAGS.snoozed]) })
    board.ingest(signal({ trigger: 'github.review_requested' }))
    expect(board.must(id!).tags).toContain(TAGS.snoozed)
    board.move(id!, 'todo', 0)
    expect(board.must(id!).tags).not.toContain(TAGS.snoozed)
  })

  it('leaves cards finished while snoozed in Done', () => {
    const { board, advance, eventTypes } = setup()
    const { actionableId: id } = board.ingest(signal())
    board.snooze(id!, '2026-10-27T13:00:00.000Z')
    board.markDone(id!)
    expect(board.must(id!).snoozedUntil).toBeUndefined()
    advance(HOUR)
    board.housekeeping()
    expect(board.must(id!).column).toBe('done')
    expect(board.must(id!).tags).not.toContain(TAGS.snoozed)
    expect(eventTypes(id)).not.toContain('unsnoozed')
  })

  it('clears the snooze when a source resolves a card to Done', () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal())
    board.snooze(id!, '2026-10-27T13:00:00.000Z')
    board.resolve({ trigger: 'github.ci_failed', externalKey: signal().externalKey, reason: 'CI passed' })
    expect(board.must(id!).column).toBe('done')
    expect(board.must(id!).snoozedUntil).toBeUndefined()
  })

  it('starts a queued card when its snooze expires and a slot is free', async () => {
    const { board, runner, settings, advance } = setup()
    settings.update({ maxConcurrentAgents: 1 })
    const a = board.ingest(signal({ externalKey: 'k1' })).actionableId!
    const b = board.ingest(signal({ externalKey: 'k2' })).actionableId!
    await runner.start(a)
    await runner.start(b)
    board.snooze(b, '2026-10-27T13:00:00.000Z')
    await runner.stop(a)
    expect(board.must(b).agentState).toBe('queued')
    advance(HOUR)
    board.housekeeping()
    await flush()
    expect(board.must(b).agentState).toBe('running')
  })

  it('starts a snoozed queued card when ingest clears its snooze', async () => {
    const { board, runner, settings } = setup()
    settings.update({ maxConcurrentAgents: 1 })
    const a = board.ingest(signal({ externalKey: 'k1' })).actionableId!
    const b = board.ingest(signal({ externalKey: 'k2' })).actionableId!
    await runner.start(a)
    await runner.start(b)
    board.snooze(b, '2026-10-27T13:00:00.000Z')
    await runner.stop(a)
    board.ingest(signal({ externalKey: 'k2' }))
    await flush()
    expect(board.must(b).agentState).toBe('running')
  })

  it('archives Done cards after archiveDoneAfterDays and prunes old activity', () => {
    const { board, advance } = setup()
    const { actionableId: id } = board.ingest(signal())
    board.markDone(id!)
    advance(6 * DAY)
    board.housekeeping()
    expect(board.must(id!).archivedAt).toBeUndefined()
    advance(DAY)
    board.housekeeping()
    expect(board.must(id!).archivedAt).toBeDefined()
    expect(board.search('fix ci')).toHaveLength(1)
    advance(90 * DAY)
    board.housekeeping()
    expect(board.events({}).events).toHaveLength(0)
  })
})

describe('queries', () => {
  it('searches all cards including dismissed', async () => {
    const { board } = setup()
    const { actionableId: id } = board.ingest(signal())
    await board.dismissCard(id!, { kind: 'user', name: 'You' })
    expect(board.search('GT-001').map((a) => a.id)).toEqual([id])
    expect(board.search('github')).toHaveLength(1)
  })

  it('searches literally and case-insensitively beyond ASCII, newest first', () => {
    const { board, advance } = setup()
    const plain = board.create({ title: '100 tasks' })
    advance(1000)
    const pct = board.create({ title: '100% Ação' })
    expect(board.search('100%').map((a) => a.id)).toEqual([pct.id])
    expect(board.search('1_0')).toEqual([])
    expect(board.search('AÇÃO').map((a) => a.id)).toEqual([pct.id])
    expect(board.search('100').map((a) => a.id)).toEqual([pct.id, plain.id])
  })

  it('paginates activity with a cursor', () => {
    const { board } = setup()
    for (let i = 0; i < 5; i++) board.create({ title: `Card ${i}` })
    const page1 = board.events({ limit: 3 })
    const page2 = board.events({ limit: 3, cursor: page1.nextCursor })
    expect(page1.events.map((e) => e.title)).toEqual(['Card 4', 'Card 3', 'Card 2'])
    expect(page2.events.map((e) => e.title)).toEqual(['Card 1', 'Card 0'])
    expect(page2.nextCursor).toBeUndefined()
    expect(page1.totalToday).toBe(5)
  })

  it('trims snapshot cards to a summary', async () => {
    const { board, runner } = setup()
    const id = board.ingest(signal({ body: 'x'.repeat(500) })).actionableId!
    await runner.start(id)
    const [card] = board.snapshot().actionables
    expect(card!.body).toHaveLength(280)
    expect(card!.dispatch!.instructions).toBe('')
    expect(board.must(id).dispatch!.instructions).toContain('x'.repeat(500))
  })

  it('does not persist raw agent events', () => {
    const { board } = setup()
    board.appendTranscript('a', 'd', { type: 'raw', payload: {} })
    board.appendTranscript('a', 'd', { type: 'message', text: 'hi' })
    expect(board.transcript('a').map((e) => e.event.type)).toEqual(['message'])
  })

  it('applies bulk updates in one transaction with one board push', () => {
    const { board, pushes } = setup()
    board.ingest(signal())
    board.ingest(signal({ externalKey: 'https://github.com/acme/api/pull/2' }))
    pushes.length = 0
    board.markSourceDisconnected('github')
    expect(pushes.filter((p) => p.type === 'board.changed')).toHaveLength(1)
    expect(board.all().every((a) => a.tags.includes(TAGS.sourceDisconnected))).toBe(true)
  })

  it('pushes board and activity changes', () => {
    const { board, pushes } = setup()
    board.create({ title: 'A' })
    expect(pushes.map((p) => p.type)).toEqual(['board.changed', 'activity.appended'])
  })
})
