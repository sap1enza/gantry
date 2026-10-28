import { actionsFor, canMove, isCustomColumn, SOURCE_KINDS, type Actionable, type BoardSnapshot, type CardFieldVisibility, type Column, type ColumnId } from '@gantry/shared'
import { ChevronDown, Circle, CircleCheck, CircleDashed, CircleDot, CircleHelp, ExternalLink, GitBranch, GripVertical, Lock, MoreHorizontal, Plus, RefreshCw, SlidersHorizontal, SquareTerminal } from 'lucide-react'
import { memo, useCallback, useMemo, useRef, useState, type DragEvent } from 'react'
import { columnCards, useApp, type AppState, type Sort } from '../app'
import { api } from '../bridge'
import { ACTION_META, ActionButton, AGENT_STATE_LABEL, ago, clock, elapsed, Popover, PriorityTag, PROVIDER_LABEL, Select, SOURCE_LABELS, SourceIcon, sourceLabel, Tag, toggle, useNow, usePopover } from '../ui'
import { DetailsPanel } from './details'
import { Welcome } from './welcome'

const FIELD_LABELS: [keyof CardFieldVisibility, string][] = [
  ['source', 'Source'],
  ['status', 'Status'],
  ['agent', 'Agent'],
  ['receivedTime', 'Received time'],
  ['repository', 'Repository'],
  ['branch', 'Branch'],
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
type DropAt = { column: string; before?: string }

const canDropOn = (card: Actionable, column: ColumnId) => column !== 'in_progress' && canMove(card, column)

function FieldChecks({ fields, keys, itemClass, onToggle }: { fields: CardFieldVisibility; keys: typeof FIELD_LABELS; itemClass: string; onToggle: (k: keyof CardFieldVisibility) => void }) {
  return (
    <>
      <label className={itemClass}>
        <input type="checkbox" checked disabled /> Title
      </label>
      {keys.map(([k, label]) => (
        <label key={k} className={itemClass}>
          <input type="checkbox" checked={fields[k]} onChange={() => onToggle(k)} /> {label}
        </label>
      ))}
    </>
  )
}

export function TriageView() {
  const app = useApp()
  const s = app.snapshot
  const fields = app.settings?.cardFields
  const fieldsPop = usePopover()

  if (!s || !fields) return null
  if (s.stats.total === 0 && !s.actionables.length) return <Welcome />

  const toggleField = (k: keyof CardFieldVisibility) => app.updateSettings({ cardFields: { ...fields, [k]: !fields[k] } })
  const addColumn = async () => {
    const name = await app.promptText('Add column', 'Column name')
    if (name) await app.run(api.columns.create(name, s.columns.length))
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
            <FieldChecks fields={fields} keys={FIELD_LABELS} itemClass="menu-item check" onToggle={toggleField} />
          </Popover>
        )}
      </div>

      {app.showWelcome && <Welcome embedded />}

      <div className="triage">
        <div className="board-wrap">
          <Toolbar />
          <Board snapshot={s} fields={fields} />
          <div className="board-footer">
            <div className="row wrap">
              <span className="eyebrow">Card fields</span>
              <FieldChecks fields={fields} keys={FIELD_LABELS.slice(0, 4)} itemClass="check" onToggle={toggleField} />
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

function Board({ snapshot: s, fields }: { snapshot: BoardSnapshot; fields: CardFieldVisibility }) {
  const { sort, selectedId, act, move, open, select, run } = useApp()
  const [drag, setDrag] = useState<Drag>()
  const [dropAt, setDropAt] = useState<DropAt>()
  const byColumn = useMemo(() => new Map(s.columns.map((c) => [c.id, columnCards(s, c.id, sort)])), [s, sort])
  const live = useRef({ s, drag, dropAt })
  live.current = { s, drag, dropAt }

  const allowed = (d: Drag | undefined, column: ColumnId) => (d?.kind === 'card' ? canDropOn(d.card, column) : d?.kind === 'column')
  const endDrag = useCallback(() => (setDrag(undefined), setDropAt(undefined)), [])
  const hover = (next: DropAt) => {
    const cur = live.current.dropAt
    if (cur?.column !== next.column || cur.before !== next.before) setDropAt(next)
  }
  const drop = useCallback(
    async (e: DragEvent, column: ColumnId, beforeId?: string) => {
      e.preventDefault()
      e.stopPropagation()
      const { s, drag: d } = live.current
      endDrag()
      if (!d) return
      if (d.kind === 'column') return void (await run(api.columns.move(d.id, s.columns.findIndex((c) => c.id === column))))
      if (!canDropOn(d.card, column)) return
      const list = columnCards(s, column, 'manual').filter((c) => c.id !== d.card.id)
      const index = beforeId ? list.findIndex((c) => c.id === beforeId) : -1
      await move(d.card, column, index < 0 ? list.length : index)
    },
    [run, move, endDrag],
  )
  const cardHandlers = useMemo<CardHandlers>(
    () => ({
      act,
      move,
      open,
      select,
      run,
      dragStart: (card) => setDrag({ kind: 'card', card }),
      dragEnd: endDrag,
      dragOver: (e, card) => {
        const d = live.current.drag
        if (d?.kind !== 'card' || card.column === 'in_progress' || !canDropOn(d.card, card.column)) return
        e.preventDefault()
        e.stopPropagation()
        hover({ column: card.column, before: card.id })
      },
      drop: (e, card) => drop(e, card.column, card.id),
    }),
    [act, move, open, select, run, endDrag, drop],
  )

  return (
    <div className="board">
      {s.columns.map((column) => {
        const cards = byColumn.get(column.id) ?? []
        const ok = allowed(drag, column.id)
        const dropClass = drag ? (ok ? (dropAt?.column === column.id ? 'drop-ok' : '') : 'drop-no') : ''
        return (
          <section
            key={column.id}
            className={`column ${dropClass} ${drag?.kind === 'column' && drag.id === column.id ? 'dragging' : ''}`}
            aria-label={column.name}
            onDragOver={(e) => {
              if (!allowed(live.current.drag, column.id)) return
              e.preventDefault()
              hover({ column: column.id })
            }}
            onDrop={(e) => drop(e, column.id)}
          >
            <ColumnHead column={column} count={cards.length} icon={FIXED_ICON[column.id] ?? GripVertical} onDragStart={() => setDrag({ kind: 'column', id: column.id })} onDragEnd={endDrag} />
            {cards.map((card) => (
              <Card
                key={card.id}
                card={card}
                fields={fields}
                columns={s.columns}
                selected={selectedId === card.id}
                dropBefore={drag?.kind === 'card' && dropAt?.column === column.id && dropAt.before === card.id}
                on={cardHandlers}
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
  )
}

function Toolbar() {
  const app = useApp()
  const f = app.filter
  const srcPop = usePopover()
  const agentPop = usePopover()
  const tagPop = usePopover()
  const seenTags = useRef(new Set<string>())
  for (const a of app.snapshot?.actionables ?? []) for (const t of a.tags) seenTags.current.add(t)
  const tags = f.tags ?? []
  const setTags = (next: string[]) => app.setFilter({ ...f, tags: next.length ? next : undefined })
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
              <input type="checkbox" checked={sources.includes(k)} onChange={() => setSources(toggle(sources, k))} />
              <SourceIcon kind={k} /> {SOURCE_LABELS[k]}
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
        {f.providers?.length ? f.providers.map((p) => PROVIDER_LABEL[p] ?? p).join(', ') : 'All agents'}
      </button>
      {agentPop.anchor && (
        <Popover anchor={agentPop.anchor} onClose={agentPop.close}>
          <button className={`menu-item ${!f.providers ? 'active' : ''}`} onClick={() => (app.setFilter({ ...f, providers: undefined }), agentPop.close())}>
            All agents
          </button>
          {Object.entries(PROVIDER_LABEL).map(([id, label]) => (
            <button key={id} className={`menu-item ${f.providers?.includes(id) ? 'active' : ''}`} onClick={() => (app.setFilter({ ...f, providers: [id] }), agentPop.close())}>
              <SquareTerminal size={13} /> {label}
            </button>
          ))}
        </Popover>
      )}
      <button className="btn sm" onClick={(e) => tagPop.toggle(e.currentTarget)}>
        <ChevronDown size={12} />
        {tags.length === 0 ? 'All tags' : tags.length === 1 ? tags[0] : `${tags.length} tags`}
      </button>
      {tagPop.anchor && (
        <Popover anchor={tagPop.anchor} onClose={tagPop.close}>
          <button className={`menu-item ${tags.length === 0 ? 'active' : ''}`} onClick={() => setTags([])}>
            All tags
          </button>
          {[...seenTags.current].sort().map((t) => (
            <label key={t} className="menu-item check">
              <input type="checkbox" checked={tags.includes(t)} onChange={() => setTags(toggle(tags, t))} /> {t}
            </label>
          ))}
          {seenTags.current.size === 0 && <span className="menu-item muted">No tags yet</span>}
        </Popover>
      )}
      <Select style={{ height: 25, fontSize: 11 }} label="Sort" value={app.sort} options={SORTS} onChange={app.setSort} />
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
  return [...out, ...card.tags]
}

interface CardHandlers {
  act: AppState['act']
  move: AppState['move']
  open: AppState['open']
  select: AppState['select']
  run: AppState['run']
  dragStart: (card: Actionable) => void
  dragEnd: () => void
  dragOver: (e: DragEvent, card: Actionable) => void
  drop: (e: DragEvent, card: Actionable) => void
}

const Card = memo(function Card({ card, fields, columns, selected, dropBefore, on }: { card: Actionable; fields: CardFieldVisibility; columns: Column[]; selected: boolean; dropBefore: boolean; on: CardHandlers }) {
  const menu = usePopover()
  const now = useNow(1000, card.agentState === 'running')
  const actions = card.column === 'done' ? [] : actionsFor(card)
  const moveTargets = columns.filter((c) => c.id !== card.column && canDropOn(card, c.id))
  const tags = fields.status ? statusTags(card, now) : []
  if (fields.status && !tags.length && isCustomColumn(card.column)) tags.push('Manual column')
  const priority = fields.priority && <PriorityTag priority={card.priority} />

  return (
    <article
      className={`card ${selected ? 'selected' : ''} ${dropBefore ? 'drop-before' : ''}`}
      draggable={moveTargets.length > 0}
      tabIndex={0}
      aria-label={card.title}
      onClick={() => on.open(card.id)}
      onFocus={() => on.select(card.id)}
      onDragStart={(e) => (e.dataTransfer.setData('text/plain', card.id), (e.dataTransfer.effectAllowed = 'move'), on.dragStart(card))}
      onDragEnd={on.dragEnd}
      onDragOver={(e) => on.dragOver(e, card)}
      onDrop={(e) => on.drop(e, card)}
      style={card.dismissedAt ? { opacity: 0.6 } : undefined}
    >
      <div className="card-meta">
        {fields.source && (
          <>
            <SourceIcon kind={card.source.kind} size={12} />
            <span className="truncate">{sourceLabel(card.source)}</span>
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
          <a key={l.url} className="card-link" href={l.url} onClick={(e) => (e.preventDefault(), e.stopPropagation(), void on.run(api.board.openLink(l.url)))}>
            <ExternalLink size={11} />
            <span className="truncate">{l.label}</span>
          </a>
        ))}
      {fields.repository && card.repository && <span className="mono muted">{card.repository}</span>}
      {fields.branch && card.dispatch && (
        <span className="row mono muted small" style={{ gap: 5 }}>
          <GitBranch size={11} />
          <span className="truncate">{card.dispatch.branch}</span>
        </span>
      )}
      {(tags.length > 0 || priority) && (
        <div className="row wrap" style={{ gap: 6 }}>
          {tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
          {priority}
        </div>
      )}
      {fields.agent && card.dispatch && card.column === 'in_progress' && (
        <div className="card-agent">
          <SquareTerminal size={11} /> {PROVIDER_LABEL[card.dispatch.provider] ?? card.dispatch.provider} · {card.dispatch.worktreePath.split('/').at(-1)}
          {card.agentState && !['running', 'paused'].includes(card.agentState) && <span className="faint">· {AGENT_STATE_LABEL[card.agentState]}</span>}
        </div>
      )}
      {actions.length > 0 && (
        <div className="card-actions">
          {actions.map((a) => (
            <ActionButton key={a} action={a} onClick={(el) => on.act(a, card, el)} />
          ))}
        </div>
      )}
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} align="right">
          <button className="menu-item" onClick={() => (menu.close(), on.open(card.id))}>
            Open details
          </button>
          {card.column === 'done' &&
            actionsFor(card).map((a) => {
              const { label, icon: Icon } = ACTION_META[a]
              return (
                <button key={a} className="menu-item" onClick={() => (menu.close(), on.act(a, card))}>
                  <Icon size={12} /> {label}
                </button>
              )
            })}
          {moveTargets.length > 0 && <div className="menu-label">Move to</div>}
          {moveTargets.map((c) => (
            <button key={c.id} className="menu-item" onClick={() => (menu.close(), void on.move(card, c.id, 0))}>
              {c.name}
            </button>
          ))}
        </Popover>
      )}
    </article>
  )
})
