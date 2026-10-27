import { actionsFor, canMove, isCustomColumn, SOURCE_KINDS, type Actionable, type CardFieldVisibility, type Column } from '@gantry/shared'
import { ChevronDown, Circle, CircleCheck, CircleDashed, CircleDot, CircleHelp, ExternalLink, GripVertical, Lock, MoreHorizontal, Plus, RefreshCw, SlidersHorizontal, SquareTerminal, X } from 'lucide-react'
import { useState, type DragEvent } from 'react'
import { columnCards, useApp, type Sort } from '../app'
import { api } from '../bridge'
import { ActionButton, AGENT_STATE_LABEL, ago, clock, elapsed, Popover, SOURCE_LABELS, SourceIcon, Tag, useNow, usePopover } from '../ui'
import { DetailsPanel } from './details'
import { Welcome, WelcomeBanner } from './welcome'

const FIELD_LABELS: [keyof CardFieldVisibility, string][] = [
  ['source', 'Source'],
  ['status', 'Status'],
  ['agent', 'Agent'],
  ['receivedTime', 'Received time'],
  ['repository', 'Repository'],
  ['links', 'Links'],
  ['priority', 'Priority'],
]
const FIXED_ICON = { todo: Circle, in_progress: CircleDot, review: CircleDashed, done: CircleCheck } as Record<string, typeof Circle>
const SORTS: { value: Sort; label: string }[] = [
  { value: 'manual', label: 'Manual order' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'priority', label: 'Priority' },
  { value: 'source', label: 'Source' },
]

type Drag = { kind: 'card'; card: Actionable } | { kind: 'column'; id: string }

export function TriageView() {
  const app = useApp()
  const s = app.snapshot
  const fields = app.settings?.cardFields
  const [drag, setDrag] = useState<Drag>()
  const [dropAt, setDropAt] = useState<{ column: string; before?: string }>()
  const fieldsPop = usePopover()

  if (!s || !fields) return null
  if (s.stats.total === 0 && !s.actionables.length) return <Welcome />

  const toggleField = (k: keyof CardFieldVisibility) => app.updateSettings({ cardFields: { ...fields, [k]: !fields[k] } })
  const addColumn = async () => {
    const name = await app.promptText('Add column', 'Column name')
    if (name) await app.run(api.columns.create(name, s.columns.length))
  }

  const allowed = (column: Column) => (drag?.kind === 'card' ? column.id !== 'in_progress' && canMove(drag.card, column.id) : drag?.kind === 'column')
  const onDrop = async (e: DragEvent, column: Column, beforeId?: string) => {
    e.preventDefault()
    e.stopPropagation()
    const d = drag
    setDrag(undefined)
    setDropAt(undefined)
    if (!d) return
    if (d.kind === 'column') {
      const target = s.columns.findIndex((c) => c.id === column.id)
      return void (await app.run(api.columns.move(d.id, target)))
    }
    if (!allowed(column)) return
    const list = columnCards(s, column.id, 'manual').filter((c) => c.id !== d.card.id)
    const index = beforeId ? list.findIndex((c) => c.id === beforeId) : list.length
    await app.run(api.board.move(d.card.id, column.id, index < 0 ? list.length : index))
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Triage</h1>
          <p>
            {s.stats.total} actionable{s.stats.total === 1 ? '' : 's'} · {s.stats.running} agent{s.stats.running === 1 ? '' : 's'} running
          </p>
        </div>
        <div className="actions">
          <button className="btn ghost" aria-label="Help" onClick={() => app.setShowWelcome(!app.showWelcome)}>
            <CircleHelp size={14} />
          </button>
          <button className="btn" onClick={(e) => fieldsPop.toggle(e.currentTarget)}>
            <SlidersHorizontal size={13} /> Card fields
          </button>
          <button className="btn" onClick={addColumn}>
            <Plus size={13} /> Add column
          </button>
          <button className="btn primary" onClick={() => app.setNewOpen(true)}>
            <Plus size={13} /> New actionable
          </button>
        </div>
        {fieldsPop.anchor && (
          <Popover anchor={fieldsPop.anchor} onClose={fieldsPop.close} align="right">
            <div className="menu-label">Card fields</div>
            <label className="menu-item check">
              <input type="checkbox" checked disabled /> Title
            </label>
            {FIELD_LABELS.map(([k, label]) => (
              <label key={k} className="menu-item check">
                <input type="checkbox" checked={fields[k]} onChange={() => toggleField(k)} /> {label}
              </label>
            ))}
          </Popover>
        )}
      </div>

      {app.showWelcome ? <Welcome embedded /> : app.account && !app.account.onboarded && <WelcomeBanner />}

      <div className="triage">
        <div className="board-wrap">
          <Toolbar />
          <div className="board">
            {s.columns.map((column) => {
              const cards = columnCards(s, column.id, app.sort)
              const Icon = FIXED_ICON[column.id] ?? GripVertical
              const dropClass = drag ? (allowed(column) ? (dropAt?.column === column.id ? 'drop-ok' : '') : 'drop-no') : ''
              return (
                <section
                  key={column.id}
                  className={`column ${dropClass} ${drag?.kind === 'column' && drag.id === column.id ? 'dragging' : ''}`}
                  aria-label={column.name}
                  onDragOver={(e) => {
                    if (!allowed(column)) return
                    e.preventDefault()
                    if (dropAt?.column !== column.id || dropAt.before) setDropAt({ column: column.id })
                  }}
                  onDrop={(e) => onDrop(e, column)}
                >
                  <ColumnHead column={column} count={cards.length} icon={Icon} onDragStart={() => setDrag({ kind: 'column', id: column.id })} onDragEnd={() => (setDrag(undefined), setDropAt(undefined))} />
                  {cards.map((card) => (
                    <Card
                      key={card.id}
                      card={card}
                      fields={fields}
                      columns={s.columns}
                      dropBefore={drag?.kind === 'card' && dropAt?.column === column.id && dropAt.before === card.id}
                      onDragStart={() => setDrag({ kind: 'card', card })}
                      onDragEnd={() => (setDrag(undefined), setDropAt(undefined))}
                      onDragOver={(e) => {
                        if (drag?.kind !== 'card' || !allowed(column) || column.id === 'in_progress') return
                        e.preventDefault()
                        e.stopPropagation()
                        if (dropAt?.before !== card.id) setDropAt({ column: column.id, before: card.id })
                      }}
                      onDrop={(e) => onDrop(e, column, card.id)}
                    />
                  ))}
                </section>
              )
            })}
            <div className="board-hint">
              <GripVertical size={14} />
              Drag to reorder custom columns.
            </div>
          </div>
          <div className="board-footer">
            <div className="row wrap">
              <span className="eyebrow">Card fields</span>
              <label className="check">
                <input type="checkbox" checked disabled /> Title
              </label>
              {FIELD_LABELS.slice(0, 4).map(([k, label]) => (
                <label key={k} className="check">
                  <input type="checkbox" checked={fields[k]} onChange={() => toggleField(k)} /> {label}
                </label>
              ))}
            </div>
            <div className="row">
              <Lock size={11} /> To-do → In Progress → Review → Done are fixed and follow agent execution. Custom columns are manual.
            </div>
          </div>
        </div>
        {app.panelOpen && app.selectedId && <DetailsPanel id={app.selectedId} />}
      </div>
    </>
  )
}

function Toolbar() {
  const app = useApp()
  const f = app.filter
  const srcPop = usePopover()
  const agentPop = usePopover()
  const [refreshedAt, setRefreshedAt] = useState(new Date().toISOString())
  useNow(30_000)
  const sources = f.sources ?? []
  const setSources = (next: string[]) => app.setFilter({ ...f, sources: next.length ? next : undefined })

  return (
    <div className="toolbar">
      <button className="btn sm" onClick={(e) => srcPop.toggle(e.currentTarget)}>
        <ChevronDown size={12} />
        {sources.length === 0 ? 'All sources' : sources.length === 1 ? SOURCE_LABELS[sources[0] as keyof typeof SOURCE_LABELS] : `${sources.length} sources`}
        {(f.showSnoozed || f.showDismissed) && <Tag tone="blue">+{[f.showSnoozed && 'snoozed', f.showDismissed && 'dismissed'].filter(Boolean).join(', ')}</Tag>}
      </button>
      {srcPop.anchor && (
        <Popover anchor={srcPop.anchor} onClose={srcPop.close}>
          <button className={`menu-item ${sources.length === 0 ? 'active' : ''}`} onClick={() => setSources([])}>
            All sources
          </button>
          {SOURCE_KINDS.map((k) => (
            <label key={k} className="menu-item check">
              <input type="checkbox" checked={sources.includes(k)} onChange={() => setSources(sources.includes(k) ? sources.filter((x) => x !== k) : [...sources, k])} />
              <SourceIcon name={k} /> {SOURCE_LABELS[k]}
            </label>
          ))}
          <div className="menu-sep" />
          <label className="menu-item check">
            <input type="checkbox" checked={!!f.showSnoozed} onChange={() => app.setFilter({ ...f, showSnoozed: !f.showSnoozed })} /> Show snoozed
          </label>
          <label className="menu-item check">
            <input type="checkbox" checked={!!f.showDismissed} onChange={() => app.setFilter({ ...f, showDismissed: !f.showDismissed })} /> Show dismissed
          </label>
        </Popover>
      )}
      <button className="btn sm" onClick={(e) => agentPop.toggle(e.currentTarget)}>
        <ChevronDown size={12} />
        {f.providers?.length ? 'Claude Code' : 'All agents'}
      </button>
      {agentPop.anchor && (
        <Popover anchor={agentPop.anchor} onClose={agentPop.close}>
          <button className={`menu-item ${!f.providers ? 'active' : ''}`} onClick={() => (app.setFilter({ ...f, providers: undefined }), agentPop.close())}>
            All agents
          </button>
          <button className={`menu-item ${f.providers ? 'active' : ''}`} onClick={() => (app.setFilter({ ...f, providers: ['claude'] }), agentPop.close())}>
            <SquareTerminal size={13} /> Claude Code
          </button>
        </Popover>
      )}
      <select className="select" style={{ height: 25, fontSize: 11 }} aria-label="Sort" value={app.sort} onChange={(e) => app.setSort(e.target.value as Sort)}>
        {SORTS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="small muted">Updated {ago(refreshedAt)}</span>
      <button
        className="icon-btn"
        style={{ marginLeft: 'auto' }}
        aria-label="Sync now"
        onClick={async () => {
          await app.run(api.connections.syncNow())
          setRefreshedAt(new Date().toISOString())
        }}
      >
        <RefreshCw size={13} />
      </button>
    </div>
  )
}

function ColumnHead({ column, count, icon: Icon, onDragStart, onDragEnd }: { column: Column; count: number; icon: typeof Circle; onDragStart: () => void; onDragEnd: () => void }) {
  const app = useApp()
  const menu = usePopover()
  const [editing, setEditing] = useState(false)
  const custom = column.kind === 'custom'
  const cols = app.snapshot!.columns
  const index = cols.findIndex((c) => c.id === column.id)
  const rename = async (name: string) => {
    setEditing(false)
    if (name.trim() && name !== column.name) await app.run(api.columns.rename(column.id, name.trim()))
  }
  return (
    <div className="column-head" draggable={custom && !editing} onDragStart={(e) => (e.dataTransfer.setData('text/plain', column.id), onDragStart())} onDragEnd={onDragEnd}>
      <Icon size={14} className={custom ? 'faint' : ''} style={custom ? { cursor: 'grab' } : undefined} />
      {editing ? (
        <input className="field" autoFocus defaultValue={column.name} onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rename(e.currentTarget.value)} />
      ) : (
        <span onDoubleClick={() => custom && setEditing(true)}>{column.name}</span>
      )}
      <span className="n">{count}</span>
      <span className="end">
        {custom ? (
          <button className="icon-btn" aria-label={`${column.name} column menu`} onClick={(e) => menu.toggle(e.currentTarget)}>
            <MoreHorizontal size={14} />
          </button>
        ) : (
          <Lock size={12} aria-label="Fixed column" />
        )}
      </span>
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} align="right">
          <button className="menu-item" onClick={() => (menu.close(), setEditing(true))}>
            Rename
          </button>
          <button className="menu-item" disabled={index === 0} onClick={() => (menu.close(), app.run(api.columns.move(column.id, index - 1)))}>
            Move left
          </button>
          <button className="menu-item" disabled={index === cols.length - 1} onClick={() => (menu.close(), app.run(api.columns.move(column.id, index + 1)))}>
            Move right
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            style={{ color: 'var(--red)' }}
            onClick={async () => {
              menu.close()
              if (await app.confirm(`Delete “${column.name}”?`, 'Cards in this column move back to To-do.', 'Delete column')) await app.run(api.columns.remove(column.id))
            }}
          >
            Delete column
          </button>
        </Popover>
      )}
    </div>
  )
}

function statusTags(card: Actionable, now: number): string[] {
  const state = card.agentState
  const out: string[] = []
  if (card.column === 'in_progress' && state === 'running' && card.dispatch) out.push(`Running ${elapsed(card.dispatch.startedAt, now)}`)
  else if (card.column === 'in_progress' && state === 'paused') out.push(card.pendingQuestion ? 'Paused · awaiting input' : 'Paused')
  else if (state === 'awaiting_input') out.push('Awaiting input')
  else if ((card.column === 'done' || card.column === 'review') && state === 'completed') out.push(`Completed · ${clock(card.doneAt ?? card.updatedAt)}`)
  if (card.dismissedAt) out.push('Dismissed')
  if (card.snoozedUntil && new Date(card.snoozedUntil).getTime() > now) out.push(`Snoozed until ${clock(card.snoozedUntil)}`)
  const tags = card.tags.filter((t) => t !== 'AI detected')
  if (card.tags.includes('AI detected') && tags.length) tags[0] = `${tags[0]} · AI detected`
  else if (card.tags.includes('AI detected')) tags.push('AI detected')
  return [...out, ...tags]
}

function Card({
  card,
  fields,
  columns,
  dropBefore,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  card: Actionable
  fields: CardFieldVisibility
  columns: Column[]
  dropBefore: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}) {
  const app = useApp()
  const menu = usePopover()
  const now = useNow(1000, card.agentState === 'running')
  const actions = card.column === 'done' ? [] : actionsFor(card)
  const draggable = !card.dismissedAt && (card.column !== 'in_progress' || card.agentState === 'paused' || card.agentState === 'stopped')
  const selected = app.selectedId === card.id
  const moveTargets = columns.filter((c) => c.id !== card.column && c.id !== 'in_progress' && canMove(card, c.id))
  const tags = fields.status ? statusTags(card, now) : []
  if (fields.status && !tags.length && isCustomColumn(card.column)) tags.push('Manual column')

  return (
    <article
      className={`card ${selected ? 'selected' : ''} ${dropBefore ? 'drop-before' : ''}`}
      draggable={draggable}
      tabIndex={0}
      aria-label={card.title}
      onClick={() => app.open(card.id)}
      onFocus={() => app.select(card.id)}
      onDragStart={(e) => (e.dataTransfer.setData('text/plain', card.id), (e.dataTransfer.effectAllowed = 'move'), onDragStart())}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={card.dismissedAt ? { opacity: 0.6 } : undefined}
    >
      <div className="card-meta">
        {fields.source && (
          <>
            <SourceIcon name={card.source.kind} size={12} />
            <span className="truncate">
              {card.source.kind === 'api' ? `${card.source.name} · API` : [...new Set([SOURCE_LABELS[card.source.kind], card.source.name])].join(' · ')}
            </span>
          </>
        )}
        {fields.receivedTime && <span>{fields.source ? '· ' : ''}{clock(card.createdAt)}</span>}
        <button className="icon-btn" style={{ marginLeft: 'auto', height: 18 }} aria-label="Card menu" onClick={(e) => (e.stopPropagation(), menu.toggle(e.currentTarget))}>
          <MoreHorizontal size={14} />
        </button>
      </div>
      <div className="card-title">{card.title}</div>
      {!card.links.length && card.body && <div className="small muted">{card.body.replace(/[*_`>#]/g, '').slice(0, 140)}</div>}
      {fields.links &&
        card.links.slice(0, 2).map((l) => (
          <a key={l.url} className="card-link" href={l.url} onClick={(e) => (e.preventDefault(), e.stopPropagation(), void app.run(api.board.openLink(l.url)))}>
            <ExternalLink size={11} />
            <span className="truncate">{l.label}</span>
          </a>
        ))}
      {fields.repository && card.repository && <span className="mono muted">{card.repository}</span>}
      {(tags.length > 0 || (fields.priority && card.priority)) && (
        <div className="row wrap" style={{ gap: 6 }}>
          {tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
          {fields.priority && card.priority && <Tag tone={card.priority === 'urgent' || card.priority === 'high' ? 'red' : ''}>{card.priority[0]!.toUpperCase() + card.priority.slice(1)}</Tag>}
        </div>
      )}
      {fields.agent && card.dispatch && card.column === 'in_progress' && (
        <div className="card-agent">
          <SquareTerminal size={11} /> Claude Code · {card.dispatch.worktreePath.split('/').at(-1)}
          {card.agentState && !['running', 'paused'].includes(card.agentState) && <span className="faint">· {AGENT_STATE_LABEL[card.agentState]}</span>}
        </div>
      )}
      {actions.length > 0 && (
        <div className="card-actions">
          {actions.map((a) => (
            <ActionButton key={a} action={a} onClick={(el) => app.act(a, card, el)} />
          ))}
        </div>
      )}
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} align="right">
          <button className="menu-item" onClick={() => (menu.close(), app.open(card.id))}>
            Open details
          </button>
          {card.column === 'done' &&
            actionsFor(card).map((a) => (
              <button key={a} className="menu-item" onClick={() => (menu.close(), app.act(a, card))}>
                {a === 'dismiss' ? <X size={12} /> : null}
                {a === 'reopen_todo' ? 'Reopen to To-do' : 'Dismiss'}
              </button>
            ))}
          {moveTargets.length > 0 && <div className="menu-label">Move to</div>}
          {moveTargets.map((c) => (
            <button key={c.id} className="menu-item" onClick={() => (menu.close(), app.run(api.board.move(card.id, c.id, 0)))}>
              {c.name}
            </button>
          ))}
        </Popover>
      )}
    </article>
  )
}
