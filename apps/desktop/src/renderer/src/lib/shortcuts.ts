export type Shortcut =
  | 'search'
  | 'new'
  | 'triage'
  | 'activity'
  | 'connections'
  | 'prev'
  | 'next'
  | 'open'
  | 'close'
  | 'start'
  | 'pause'
  | 'snooze'
  | 'dismiss'
  | 'done'

export const SHORTCUT_LIST: [string, string][] = [
  ['⌘K', 'Search actionables'],
  ['⌘N', 'New actionable'],
  ['⌘1 / ⌘2 / ⌘3', 'Triage / Activity / Connections'],
  ['← / →', 'Previous / next card'],
  ['Enter', 'Open details panel'],
  ['Esc', 'Close panel'],
  ['S', 'Start or resume'],
  ['P', 'Pause'],
  ['Z', 'Snooze'],
  ['D', 'Dismiss'],
  ['⌘⏎', 'Done (in Review)'],
]

interface KeyInput {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  target: EventTarget | null
}

const MOD: Record<string, Shortcut> = { k: 'search', n: 'new', '1': 'triage', '2': 'activity', '3': 'connections', Enter: 'done' }
const PLAIN: Record<string, Shortcut> = {
  ArrowLeft: 'prev',
  ArrowRight: 'next',
  Enter: 'open',
  Escape: 'close',
  s: 'start',
  p: 'pause',
  z: 'snooze',
  d: 'dismiss',
}

export function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

export function shortcutFor(e: KeyInput): Shortcut | undefined {
  if (e.altKey) return undefined
  const mod = e.metaKey || e.ctrlKey
  if (isTyping(e.target)) return mod && e.key.toLowerCase() === 'k' ? 'search' : undefined
  return mod ? MOD[e.key.length === 1 ? e.key.toLowerCase() : e.key] : PLAIN[e.key.length === 1 ? e.key.toLowerCase() : e.key]
}
