import type { BoardSnapshot } from '@gantry/shared'

export function reuseSnapshot(prev: BoardSnapshot | undefined, next: BoardSnapshot): BoardSnapshot {
  if (!prev) return next
  const old = new Map(prev.actionables.map((a) => [a.id, a]))
  return {
    ...next,
    actionables: next.actionables.map((a) => {
      const p = old.get(a.id)
      return p && p.updatedAt === a.updatedAt && p.position === a.position ? p : a
    }),
    columns: JSON.stringify(prev.columns) === JSON.stringify(next.columns) ? prev.columns : next.columns,
  }
}
