import { EVENT_TYPES, PROVIDER_SOURCE, SOURCE_KINDS, unique, type OAuthProvider, type SourceKind, type ActivityEvent, type ActivityQuery, type EventType } from '@gantry/shared'
import { Calendar, ChevronDown, Download, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, usePush } from '../app'
import { api } from '../bridge'
import { Button, clockSeconds, Popover, SOURCE_LABELS, SourceIcon, Tag, toggle, usePopover } from '../ui'

const TYPE_LABEL: Record<EventType, string> = {
  received: 'Received',
  dispatched: 'Dispatched',
  agent_update: 'Agent update',
  paused: 'Paused',
  resumed: 'Resumed',
  awaiting_input: 'Awaiting input',
  answered: 'Answered',
  stopped: 'Stopped',
  completed: 'Completed',
  failed: 'Failed',
  done: 'Done',
  reopened: 'Reopened',
  dismissed: 'Dismissed',
  deleted: 'Deleted',
  snoozed: 'Snoozed',
  unsnoozed: 'Unsnoozed',
  moved: 'Moved',
  edited: 'Edited',
  resolved_externally: 'Resolved externally',
  connection: 'Connection',
}
const OUTCOME_LABEL: Record<string, string> = {
  created: 'created card',
  updated: 'updated card',
  'ignored:trigger-off': 'ignored, trigger off',
  'ignored:filtered': 'ignored, filtered',
  'ignored:duplicate': 'no change',
  'ignored:error': 'failed',
}

export function CardEvent({ e, time }: { e: ActivityEvent; time: (iso: string) => string }) {
  const actor = e.actor.kind === 'user' ? 'You' : e.actor.name
  return (
    <li>
      <span className="row" style={{ gap: 6 }}>
        <Tag tone={TYPE_TONE[e.type]}>{TYPE_LABEL[e.type]}</Tag>
        <span className="muted small">{[actor, e.outcome && OUTCOME_LABEL[e.outcome]].filter(Boolean).join(' · ')}</span>
      </span>
      {e.detail && <div className="muted selectable clamp-3">{e.detail}</div>}
      <span className="mono">{time(e.createdAt)}</span>
    </li>
  )
}

const TYPE_TONE: Partial<Record<EventType, string>> = {
  dispatched: 'blue',
  completed: 'green',
  done: 'green',
  resolved_externally: 'green',
  connection: 'amber',
  paused: 'amber',
  awaiting_input: 'amber',
  stopped: 'amber',
  failed: 'red',
}
const CHIPS: { label: string; types?: EventType[] }[] = [
  { label: 'All events' },
  { label: 'Received', types: ['received'] },
  { label: 'Dispatched', types: ['dispatched'] },
  { label: 'Agent updates', types: ['agent_update'] },
  { label: 'Completed', types: ['completed'] },
  { label: 'Dismissed', types: ['dismissed'] },
]
const RANGES = [
  { id: 'today', label: 'Today', days: 0 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: 'all', label: 'All time', days: -1 },
] as const
const PAGE = 25

const iconKind = (e: ActivityEvent): SourceKind | 'agent' => {
  const name = e.source.toLowerCase()
  if (e.actor.kind === 'agent' || name === 'claude code') return 'agent'
  if (Object.hasOwn(PROVIDER_SOURCE, name)) return PROVIDER_SOURCE[name as OAuthProvider]
  return SOURCE_KINDS.find((k) => name === k || name === SOURCE_LABELS[k].toLowerCase()) ?? 'api'
}

const sinceFor = (days: number) => {
  if (days < 0) return undefined
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

const matches = (e: ActivityEvent, q: ActivityQuery) =>
  (!q.types?.length || q.types.includes(e.type)) &&
  (!q.sources?.length || q.sources.includes(e.source)) &&
  (!q.actionableId || e.actionableId === q.actionableId) &&
  (!q.since || e.createdAt >= q.since) &&
  (!q.text || [e.title, e.detail, e.actionableDisplayId].some((v) => v?.toLowerCase().includes(q.text!.toLowerCase())))

export function ActivityView() {
  const app = useApp()
  const { run } = app
  const [types, setTypes] = useState<EventType[]>([])
  const [sources, setSources] = useState<string[]>([])
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('today')
  const [text, setText] = useState('')
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [more, setMore] = useState(false)
  const [totalToday, setTotalToday] = useState(0)
  const [cardLabel, setCardLabel] = useState<string>()
  const typePop = usePopover()
  const srcPop = usePopover()
  const datePop = usePopover()
  const exportPop = usePopover()

  const filters = useMemo<ActivityQuery>(
    () => ({ types, sources, actionableId: app.activityCard, text: text.trim() || undefined, since: sinceFor(RANGES.find((r) => r.id === range)!.days) }),
    [types, sources, app.activityCard, text, range],
  )
  const loaded = useRef(0)
  loaded.current = events.length
  const [page, setPage] = useState({ filters, limit: PAGE })
  const limit = page.filters === filters ? page.limit : PAGE
  const query = useMemo(() => ({ ...filters, limit }), [filters, limit])
  const load = useCallback(async () => {
    const res = await run(api.activity.list(query))
    if (!res) return
    setEvents(res.events)
    setMore(!!res.nextCursor)
    setTotalToday(res.totalToday)
  }, [query, run])
  useEffect(() => {
    const t = setTimeout(() => void load(), text ? 150 : 0)
    return () => clearTimeout(t)
  }, [load, text])
  useEffect(() => {
    if (app.activityCard) void api.board.get(app.activityCard).then((a) => setCardLabel(a?.displayId))
  }, [app.activityCard])
  usePush('activity.appended', ({ event }) => {
    setTotalToday((n) => n + 1)
    if (!matches(event, query)) return
    if (loaded.current >= limit) setMore(true)
    else loaded.current++
    setEvents((list) => [event, ...list].slice(0, limit))
  })

  const exportLog = async (format: 'json' | 'csv') => {
    exportPop.close()
    const path = await app.run(api.activity.export(format, filters))
    if (path) app.toast(`Exported to ${path}`)
  }
  const sourceOptions = useMemo(() => unique([...sources, ...events.map((e) => e.source)]).sort(), [sources, events])
  const chip = CHIPS.find((c) => (c.types ?? []).join() === types.join())

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Activity</h1>
          <p>Incoming events and every change to your work.</p>
        </div>
        <div className="actions">
          <Button className="btn" onClick={(e) => exportPop.toggle(e.currentTarget)}>
            <Download size={13} /> Export log
          </Button>
          {exportPop.anchor && (
            <Popover anchor={exportPop.anchor} onClose={exportPop.close} align="right">
              <Button className="menu-item" onClick={() => exportLog('json')}>
                Export JSON
              </Button>
              <Button className="menu-item" onClick={() => exportLog('csv')}>
                Export CSV
              </Button>
            </Popover>
          )}
        </div>
      </div>
      <div className="page-body">
        <div className="filters">
          <Button className="btn" onClick={(e) => typePop.toggle(e.currentTarget)}>
            <ChevronDown size={12} /> {types.length ? `${types.length} event type${types.length > 1 ? 's' : ''}` : 'All event types'}
          </Button>
          {typePop.anchor && (
            <Popover anchor={typePop.anchor} onClose={typePop.close}>
              <Button className="menu-item" onClick={() => setTypes([])}>
                All event types
              </Button>
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                {EVENT_TYPES.map((t) => (
                  <label key={t} className="menu-item check">
                    <input type="checkbox" checked={types.includes(t)} onChange={() => setTypes(toggle(types, t))} /> {TYPE_LABEL[t]}
                  </label>
                ))}
              </div>
            </Popover>
          )}
          <Button className="btn" onClick={(e) => srcPop.toggle(e.currentTarget)}>
            <ChevronDown size={12} /> {sources.length ? sources.join(', ') : 'All sources'}
          </Button>
          {srcPop.anchor && (
            <Popover anchor={srcPop.anchor} onClose={srcPop.close}>
              <Button className="menu-item" onClick={() => setSources([])}>
                All sources
              </Button>
              {sourceOptions.map((s) => (
                <label key={s} className="menu-item check">
                  <input type="checkbox" checked={sources.includes(s)} onChange={() => setSources(toggle(sources, s))} />
                  {s}
                </label>
              ))}
            </Popover>
          )}
          <Button className="btn" onClick={(e) => datePop.toggle(e.currentTarget)}>
            <Calendar size={13} /> {RANGES.find((r) => r.id === range)!.label}
          </Button>
          {datePop.anchor && (
            <Popover anchor={datePop.anchor} onClose={datePop.close}>
              {RANGES.map((r) => (
                <Button key={r.id} className={`menu-item ${r.id === range ? 'active' : ''}`} onClick={() => (setRange(r.id), datePop.close())}>
                  {r.label}
                </Button>
              ))}
            </Popover>
          )}
          <div className="row field" style={{ width: 290, height: 30, gap: 6 }}>
            <Search size={13} className="muted" />
            <input style={{ border: 0, outline: 0, background: 'none', flex: 1, fontSize: 12 }} placeholder="Filter by title, ID, or repository" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          {app.activityCard && (
            <span className="tag blue" style={{ height: 24 }}>
              Card {cardLabel ?? '…'}
              <Button className="icon-btn" style={{ width: 16, height: 16 }} aria-label="Clear card filter" onClick={() => app.setActivityCard(undefined)}>
                <X size={11} />
              </Button>
            </span>
          )}
          <span className="live">Live updates</span>
        </div>
        <div className="chips">
          {CHIPS.map((c) => (
            <Button key={c.label} className={`chip ${chip === c ? 'active' : ''}`} onClick={() => setTypes(c.types ?? [])}>
              {c.label}
            </Button>
          ))}
          <span className="small muted" style={{ marginLeft: 'auto' }}>
            {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </span>
        </div>
        <div className="table" role="table">
          <div className="table-row head" role="row">
            <span>Time ↓</span>
            <span>Event type</span>
            <span>Source</span>
            <span>Event</span>
            <span>Actor</span>
          </div>
          {events.map((e) => (
            <div
              key={e.id}
              role="row"
              className="table-row"
              style={e.actionableId ? undefined : { cursor: 'default' }}
              onClick={() => e.actionableId && app.open(e.actionableId)}
            >
              <span className="mono">{clockSeconds(e.createdAt)}</span>
              <span>
                <Tag tone={TYPE_TONE[e.type]}>{TYPE_LABEL[e.type]}</Tag>
              </span>
              <span className="row" style={{ gap: 7 }}>
                <SourceIcon kind={iconKind(e)} /> <span className="truncate">{e.source}</span>
              </span>
              <span className="col" style={{ gap: 3, minWidth: 0, padding: '10px 12px 10px 0' }}>
                <span className="row" style={{ gap: 6 }}>
                  <b style={{ fontWeight: 600 }} className="truncate">{e.title}</b>
                  {e.outcome && <Tag tone={e.outcome === 'created' ? 'green' : e.outcome === 'updated' ? 'blue' : ''}>{e.outcome}</Tag>}
                </span>
                <span className="small muted truncate">{[e.actionableDisplayId, e.detail].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="small muted truncate">{e.actor.name}</span>
            </div>
          ))}
          {!events.length && <div className="empty-state muted">No events match these filters.</div>}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <span className="small muted">
            Showing {events.length} {range === 'today' ? `of ${totalToday} events today` : 'events'} · All times local
          </span>
          {more && (
            <Button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setPage({ filters, limit: limit + PAGE })}>
              <ChevronDown size={12} /> Load earlier events
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
