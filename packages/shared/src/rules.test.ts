import { describe, expect, it } from 'vitest'
import type { Actionable } from './actionable'
import { actionsFor, canMove } from './rules'

const card = (over: Partial<Actionable>): Actionable =>
  ({ column: 'todo', tags: [], links: [], triggers: [], metadata: {}, ...over }) as Actionable

describe('actionsFor', () => {
  it('matches the PRD button table', () => {
    expect(actionsFor(card({ column: 'todo' }))).toEqual(['start', 'dismiss'])
    expect(actionsFor(card({ column: 'in_progress', agentState: 'running' }))).toEqual(['pause', 'stop', 'dismiss'])
    expect(actionsFor(card({ column: 'in_progress', agentState: 'awaiting_input' }))).toEqual(['pause', 'stop', 'dismiss'])
    expect(actionsFor(card({ column: 'in_progress', agentState: 'paused' }))).toEqual(['resume', 'stop', 'dismiss'])
    expect(actionsFor(card({ column: 'in_progress', agentState: 'queued' }))).toEqual(['stop', 'dismiss'])
    expect(actionsFor(card({ column: 'review' }))).toEqual(['done', 'reopen', 'dismiss'])
    expect(actionsFor(card({ column: 'done' }))).toEqual(['reopen_todo', 'dismiss'])
    expect(actionsFor(card({ column: 'waiting' }))).toEqual(['start', 'dismiss'])
    expect(actionsFor(card({ dismissedAt: 'x' }))).toEqual([])
  })
})

describe('canMove', () => {
  it('never drags into agent-driven columns', () => {
    expect(canMove(card({ column: 'todo' }), 'in_progress')).toBe(false)
    expect(canMove(card({ column: 'todo' }), 'review')).toBe(false)
  })
  it('allows manual moves between todo, done, and custom', () => {
    expect(canMove(card({ column: 'todo' }), 'done')).toBe(true)
    expect(canMove(card({ column: 'done' }), 'todo')).toBe(true)
    expect(canMove(card({ column: 'review' }), 'waiting')).toBe(true)
  })
  it('only moves in-progress cards to custom columns when the agent is not active', () => {
    expect(canMove(card({ column: 'in_progress', agentState: 'running' }), 'waiting')).toBe(false)
    expect(canMove(card({ column: 'in_progress', agentState: 'paused' }), 'waiting')).toBe(true)
    expect(canMove(card({ column: 'in_progress', agentState: 'paused' }), 'todo')).toBe(false)
  })
})
