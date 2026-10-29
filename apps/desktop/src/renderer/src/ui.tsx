import { PROVIDER_SOURCE, unique, type Actionable, type CardAction, type OAuthProvider, type Priority, type SourceKind } from '@gantry/shared'
import {
  Check,
  LoaderCircle,
  Pause,
  PencilLine,
  Play,
  RotateCcw,
  Square,
  SquareTerminal,
  Webhook,
  X,
  type LucideProps,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { parseMarkdown, type Inline } from './lib/markdown'

export function Github(props: LucideProps) {
  const { size = 24, strokeWidth = 2, ...rest } = props
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...(rest as object)}>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  )
}

const SOURCE_ICONS: Record<SourceKind, (p: LucideProps) => ReactNode> = {
  github: Github,
  api: Webhook,
  manual: PencilLine,
}
export const SOURCE_LABELS: Record<SourceKind, string> = { github: 'GitHub', api: 'API', manual: 'Manual' }
export const OAUTH_INPUTS = (Object.keys(PROVIDER_SOURCE) as OAuthProvider[]).map((provider) => ({ provider, kind: PROVIDER_SOURCE[provider] }))
export const INPUTS: { provider: OAuthProvider | 'api'; kind: SourceKind }[] = [...OAUTH_INPUTS, { provider: 'api', kind: 'api' }]

export function SourceIcon({ kind, size = 13 }: { kind: SourceKind | 'agent'; size?: number }) {
  const Icon = kind === 'agent' ? SquareTerminal : SOURCE_ICONS[kind]
  return <Icon size={size} />
}

export const sourceLabel = (s: Actionable['source']) => (s.kind === 'api' ? `${s.name} · API` : unique([SOURCE_LABELS[s.kind], s.name]).join(' · '))

export const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

export function PriorityTag({ priority }: { priority?: Priority }) {
  if (!priority || priority === 'normal') return null
  return <Tag tone={priority === 'low' ? '' : 'red'}>{priority[0]!.toUpperCase() + priority.slice(1)}</Tag>
}

export const ACTION_META: Record<CardAction, { label: string; icon: (p: LucideProps) => ReactNode }> = {
  start: { label: 'Start', icon: Play },
  pause: { label: 'Pause', icon: Pause },
  resume: { label: 'Resume', icon: Play },
  stop: { label: 'Stop', icon: Square },
  dismiss: { label: 'Dismiss', icon: X },
  done: { label: 'Done', icon: Check },
  reopen: { label: 'Reopen', icon: RotateCcw },
  open_terminal: { label: 'Open in terminal', icon: SquareTerminal },
  reopen_todo: { label: 'Reopen to To-do', icon: RotateCcw },
}

export function ActionButton({ action, onClick, large }: { action: CardAction; onClick: (anchor: HTMLElement) => unknown; large?: boolean }) {
  const { label, icon: Icon } = ACTION_META[action]
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={`btn ${large ? '' : 'sm'} ${action === 'start' || action === 'done' ? 'primary' : ''}`}
      disabled={busy}
      aria-busy={busy}
      onClick={async (e) => {
        e.stopPropagation()
        setBusy(true)
        try {
          await onClick(e.currentTarget)
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? <LoaderCircle size={12} className="spin" /> : <Icon size={12} />}
      {label}
    </button>
  )
}

const TAG_TONE: [RegExp, string][] = [
  [/fail|ci failed|changes requested|disconnected/i, 'red'],
  [/needs|ai detected|conflict|stopped|queued|paused|awaiting|reconnect/i, 'amber'],
  [/completed|resolved|connected|enabled/i, 'green'],
  [/running/i, 'blue'],
]
const toneFor = (text: string) => TAG_TONE.find(([re]) => re.test(text))?.[1] ?? ''

export function Tag({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone ?? (typeof children === 'string' ? toneFor(children) : '')}`}>{children}</span>
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button className="toggle" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />
}

export function Select<T extends string>({ value, options, onChange, label, className, style }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; label: string; className?: string; style?: CSSProperties }) {
  return (
    <select className={`select ${className ?? ''}`} style={style} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Modal({ title, subtitle, children, footer, onClose, wide }: { title: string; subtitle?: ReactNode; children?: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {children && <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Popover({ anchor, onClose, children, align = 'left' }: { anchor?: DOMRect; onClose: () => void; children: ReactNode; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>()
  useLayoutEffect(() => {
    const el = ref.current!
    const { width, height } = el.getBoundingClientRect()
    const a = anchor ?? new DOMRect(window.innerWidth / 2 - width / 2, window.innerHeight / 3, width, 0)
    const left = align === 'right' ? a.right - width : a.left
    setPos({ left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), top: a.bottom + height + 12 > window.innerHeight ? Math.max(8, a.top - height - 4) : a.bottom + 4 })
  }, [anchor, align])
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    const t = setTimeout(() => window.addEventListener('mousedown', onDown))
    window.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
  return (
    <div ref={ref} className="popover" role="menu" style={pos ?? { visibility: 'hidden', left: 0, top: 0 }} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}

export function usePopover() {
  const [anchor, setAnchor] = useState<DOMRect>()
  return {
    anchor,
    open: (el: HTMLElement) => setAnchor(el.getBoundingClientRect()),
    toggle: (el: HTMLElement) => setAnchor((a) => (a ? undefined : el.getBoundingClientRect())),
    close: () => setAnchor(undefined),
  }
}

function InlineNodes({ nodes, onLink }: { nodes: Inline[]; onLink: (url: string) => void }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <span key={i}>{n.v}</span>
          case 'code':
            return <code key={i}>{n.v}</code>
          case 'strong':
            return <strong key={i}><InlineNodes nodes={n.c} onLink={onLink} /></strong>
          case 'em':
            return <em key={i}><InlineNodes nodes={n.c} onLink={onLink} /></em>
          case 'link':
            return (
              <a key={i} href={n.href} onClick={(e) => (e.preventDefault(), onLink(n.href))}>
                <InlineNodes nodes={n.c} onLink={onLink} />
              </a>
            )
        }
      })}
    </>
  )
}

export function Markdown({ source, onLink }: { source: string; onLink: (url: string) => void }) {
  return (
    <div className="md">
      {parseMarkdown(source).map((b, i) => {
        switch (b.t) {
          case 'p':
            return <p key={i}><InlineNodes nodes={b.c} onLink={onLink} /></p>
          case 'quote':
            return <blockquote key={i}><InlineNodes nodes={b.c} onLink={onLink} /></blockquote>
          case 'h':
            return <h4 key={i}><InlineNodes nodes={b.c} onLink={onLink} /></h4>
          case 'pre':
            return <pre key={i}>{b.v}</pre>
          case 'ul':
          case 'ol': {
            const List = b.t
            return (
              <List key={i}>
                {b.items.map((item, j) => (
                  <li key={j}><InlineNodes nodes={item} onLink={onLink} /></li>
                ))}
              </List>
            )
          }
        }
      })}
    </div>
  )
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
export const clockSeconds = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?'
const relative = new Intl.RelativeTimeFormat('en')
export function ago(iso?: string) {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return relative.format(-Math.round(s / 60), 'minute')
  if (s < 86_400) return relative.format(-Math.round(s / 3600), 'hour')
  return new Date(iso).toLocaleDateString()
}
const pad = (n: number) => String(n).padStart(2, '0')
export function when(iso: string, now = new Date()) {
  const d = new Date(iso)
  if (d.toDateString() === now.toDateString() && d <= now) return ago(iso)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const elapsed = (iso: string, now: number) => {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`
}

export function useNow(ms: number, active = true) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms, active])
  return now
}

export const AGENT_STATE_LABEL: Record<NonNullable<Actionable['agentState']>, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  awaiting_input: 'Awaiting input',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
}

export const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude Code' }

export const PRESET_LABEL = { read_only: 'Read-only', edit_test: 'Edit + test', full: 'Full' } as const
export const PRESET_HINT = {
  read_only: 'Investigate only, no edits',
  edit_test: 'Edit files, run commands, no push or PR',
  full: 'May push a branch and open a PR',
} as const
