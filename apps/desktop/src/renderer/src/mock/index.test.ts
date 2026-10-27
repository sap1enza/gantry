import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockBridge } from './index'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const byDisplay = (m: ReturnType<typeof createMockBridge>, id: string) => m.state.actionables.find((a) => a.displayId === id)!

describe('mock api', () => {
  it('hides snoozed and dismissed cards unless asked', async () => {
    const m = createMockBridge()
    const ids = (await m.api.board.snapshot()).actionables.map((a) => a.displayId)
    expect(ids).not.toContain('GT-117')
    expect(ids).not.toContain('GT-118')
    const all = (await m.api.board.snapshot({ showSnoozed: true, showDismissed: true })).actionables.map((a) => a.displayId)
    expect(all).toEqual(expect.arrayContaining(['GT-117', 'GT-118']))
  })

  it('runs an agent from start to review and stop returns it to To-do tagged Stopped', async () => {
    const m = createMockBridge({ agentStepMs: 10 })
    const ci = byDisplay(m, 'GT-127')
    await m.api.board.start(ci.id)
    expect(ci.column).toBe('in_progress')
    expect(ci.agentState).toBe('running')
    await vi.advanceTimersByTimeAsync(200)
    expect(ci.column).toBe('review')
    expect(ci.result?.summary).toBeTruthy()

    const mail = byDisplay(m, 'GT-125')
    await m.api.board.start(mail.id, { repository: 'acme/api' })
    await m.api.board.stop(mail.id)
    expect(mail.column).toBe('todo')
    expect(mail.tags).toContain('Stopped')
  })

  it('rejects moves that canMove forbids', async () => {
    const m = createMockBridge()
    const running = byDisplay(m, 'GT-128')
    await expect(m.api.board.move(running.id, 'col_waiting', 0)).rejects.toThrow()
    const paused = byDisplay(m, 'GT-124')
    await m.api.board.move(paused.id, 'col_waiting', 0)
    expect(paused.column).toBe('col_waiting')
  })

  it('refuses to snooze a running agent', async () => {
    const m = createMockBridge()
    await expect(m.api.board.snooze(byDisplay(m, 'GT-128').id, new Date().toISOString())).rejects.toThrow()
  })

  it('paginates activity with a cursor', async () => {
    const m = createMockBridge()
    const first = await m.api.activity.list({ limit: 11 })
    expect(first.events).toHaveLength(11)
    const second = await m.api.activity.list({ limit: 11, cursor: first.nextCursor })
    expect(second.events[0]!.id).not.toBe(first.events[0]!.id)
    expect(second.events[0]!.createdAt <= first.events[10]!.createdAt).toBe(true)
  })

  it('keeps fixed columns locked', async () => {
    const m = createMockBridge()
    await expect(m.api.columns.rename('todo', 'x')).rejects.toThrow()
    const col = await m.api.columns.create('Blocked', 1)
    const order = (await m.api.board.snapshot()).columns.map((c) => c.id)
    expect(order.slice(0, 3)).toEqual(['todo', col.id, 'in_progress'])
  })
})
