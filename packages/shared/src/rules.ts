import { FIXED_COLUMNS, type Actionable, type ColumnId } from './actionable'

export type CardAction =
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'snooze'
  | 'dismiss'
  | 'done'
  | 'reopen'
  | 'open_terminal'
  | 'reopen_todo'

const FIXED = new Set<string>(FIXED_COLUMNS)
export const isCustomColumn = (column: ColumnId) => !FIXED.has(column)

export function isAgentActive(a: Pick<Actionable, 'column' | 'agentState'>) {
  return a.column === 'in_progress' && (a.agentState === 'running' || a.agentState === 'awaiting_input')
}

export const hasLiveAgent = (a: Pick<Actionable, 'column' | 'agentState'>) => a.column === 'in_progress' && a.agentState !== 'stopped'

export function actionsFor(a: Actionable): CardAction[] {
  if (a.dismissedAt || a.archivedAt) return []
  switch (a.column) {
    case 'todo':
      return ['start', 'snooze', 'dismiss']
    case 'in_progress':
      if (isAgentActive(a)) return ['pause', 'stop', 'dismiss']
      if (a.agentState === 'paused') return ['resume', 'stop', 'snooze', 'dismiss']
      return ['stop', 'snooze', 'dismiss']
    case 'review':
      return a.dispatch?.sessionId ? ['done', 'reopen', 'open_terminal', 'dismiss'] : ['done', 'reopen', 'dismiss']
    case 'done':
      return ['reopen_todo', 'dismiss']
    default:
      return ['start', 'snooze', 'dismiss']
  }
}

export function canMove(a: Pick<Actionable, 'column' | 'agentState' | 'dismissedAt'>, target: ColumnId): boolean {
  if (a.dismissedAt) return false
  if (target === a.column) return true
  if (target === 'in_progress' || target === 'review') return false
  if (a.column === 'in_progress') return isCustomColumn(target) && (a.agentState === 'paused' || a.agentState === 'stopped')
  return true
}
