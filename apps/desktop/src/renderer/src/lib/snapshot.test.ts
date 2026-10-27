import type { Actionable, BoardSnapshot, Column } from '@gantry/shared'
import { describe, expect, it } from 'vitest'
import { reuseSnapshot } from './snapshot'

const card = (id: string, updatedAt: string, position = 0) => ({ id, updatedAt, position }) as Actionable
const snap = (actionables: Actionable[], columns: Column[] = [{ id: 'todo', name: 'To-do', kind: 'fixed', position: 0 } as Column]) => ({ columns, actionables, stats: {} }) as BoardSnapshot

describe('reuseSnapshot', () => {
  it('keeps unchanged cards and columns by identity and takes changed ones', () => {
    const prev = snap([card('a', '1'), card('b', '1'), card('c', '1', 1)])
    const next = reuseSnapshot(prev, snap([card('a', '1'), card('b', '2'), card('c', '1', 0)]))
    expect(next.actionables[0]).toBe(prev.actionables[0])
    expect(next.actionables[1]).not.toBe(prev.actionables[1])
    expect(next.actionables[2]!.position).toBe(0)
    expect(next.columns).toBe(prev.columns)
  })

  it('replaces columns when they change', () => {
    const prev = snap([])
    const columns = [{ id: 'todo', name: 'Inbox', kind: 'fixed', position: 0 } as Column]
    expect(reuseSnapshot(prev, snap([], columns)).columns).toBe(columns)
  })
})
