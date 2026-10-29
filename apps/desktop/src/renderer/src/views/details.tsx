import { actionsFor, isAgentActive, isCustomColumn, PRIORITIES, TAGS, type Actionable, type Column, type ActivityEvent, type AgentEvent, type TranscriptEntry } from '@gantry/shared'
import { ChevronRight, ExternalLink, FileText, GitPullRequest, List, PanelRightClose, Pencil, Plus, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { useApp, usePush } from '../app'
import { CardEvent } from './activity'
import { api } from '../bridge'
import { Button, ActionButton, AGENT_STATE_LABEL, clock, clockSeconds, Markdown, PRESET_LABEL, Select, SourceIcon, Tag, PriorityTag, PROVIDER_LABEL, when } from '../ui'

export function stateLabel(a: Actionable, columns: Column[] = []) {
  if (a.dismissedAt) return 'Dismissed'
  if (a.archivedAt) return 'Archived'
  if (a.column === 'in_progress' && a.agentState) return a.agentState === 'running' ? 'Agent running' : AGENT_STATE_LABEL[a.agentState]
  if (a.column === 'review') return 'Ready for review'
  return columns.find((c) => c.id === a.column)?.name ?? (isCustomColumn(a.column) ? 'Custom column' : a.column)
}

const describeAgentEvent = (e: AgentEvent): string | undefined => {
  switch (e.type) {
    case 'message':
      return e.text
    case 'tool':
      return `${e.name}: ${e.summary}`
    case 'question':
      return `Asked: ${e.prompt}`
    case 'state':
      return `State → ${AGENT_STATE_LABEL[e.state]}`
    case 'result':
      return `Result: ${e.result.summary}`
    case 'error':
      return `Error: ${e.message}`
    case 'usage':
      return `Usage: ${e.inputTokens.toLocaleString()} in / ${e.outputTokens.toLocaleString()} out · $${e.costUsd.toFixed(2)}`
    case 'session':
      return `Session ${e.sessionId}`
    case 'raw':
      return undefined
  }
}

export function DetailsPanel({ id }: { id: string }) {
  const app = useApp()
  const [fetched, setFetched] = useState<Actionable>()
  const card = fetched?.id === id ? fetched : undefined
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [log, setLog] = useState<ActivityEvent[]>([])
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [side, setSide] = useState<'transcript' | 'log'>()
  const [editing, setEditing] = useState(false)
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState('')

  const version = app.snapshot?.actionables.find((a) => a.id === id)?.updatedAt
  const fetchCard = useCallback(() => void api.board.get(id).then((c) => c && setFetched((prev) => (prev?.id === c.id && prev.updatedAt > c.updatedAt ? prev : c))), [id])
  useEffect(() => {
    setAnswer('')
    setFeedback('')
    setEvents([])
    setTranscript([])
    setSide(undefined)
    setEditing(false)
    let current = true
    void api.activity.list({ actionableId: id, limit: 3 }).then((log) => current && setEvents(log.events))
    void api.board.transcript(id).then((t) => current && setTranscript(t))
    return () => {
      current = false
    }
  }, [id])
  useEffect(fetchCard, [fetchCard, version])
  usePush('board.changed', () => !version && fetchCard())
  usePush('activity.appended', ({ event }) => {
    if (event.actionableId !== id) return
    setEvents((list) => [event, ...list].slice(0, 3))
    setLog((list) => [event, ...list])
  })
  usePush('agent.event', ({ actionableId, event }) => actionableId === id && event.type !== 'raw' && setTranscript((list) => [...list, { at: new Date().toISOString(), event }]))
  const openLog = async () => {
    setLog((await api.activity.list({ actionableId: id, limit: 200 })).events)
    setSide('log')
  }

  if (!card) return <aside className="panel" />
  const messages = transcript.filter((t) => t.event.type === 'message').slice(-3)
  const actions = actionsFor(card)
  const d = card.dispatch
  const r = card.result
  const q = card.pendingQuestion
  const openLink = (url: string) => void app.run(api.board.openLink(url))
  const reopening = app.reopenFor === card.id && card.column === 'review'
  const sendAnswer = async (text: string) => {
    if (!q || !text.trim()) return
    await app.run(api.board.answer(card.id, q.id, text.trim()))
    setAnswer('')
  }

  return (
    <>
      {side && (
        <aside className="panel side-panel" aria-label={side === 'log' ? 'Activity log' : 'Transcript'}>
          <div className="row">
            <span className="eyebrow">
              {side === 'log' ? 'Activity log' : 'Transcript'} · {card.displayId}
            </span>
            <Button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="Close" onClick={() => setSide(undefined)}>
              <X size={14} />
            </Button>
          </div>
          {side === 'transcript' ? (
            <div className="transcript">
              {transcript.length === 0 && <span className="muted">No transcript events recorded yet.</span>}
              {transcript.map((t, i) => (
                <div key={i}>
                  <span className="faint">{clockSeconds(t.at)}</span> <b>{t.event.type}</b> {describeAgentEvent(t.event) ?? JSON.stringify(t.event)}
                </div>
              ))}
            </div>
          ) : (
            <ul className="timeline" style={{ margin: 0 }}>
              {log.map((e) => (
                <CardEvent key={e.id} e={e} time={when} />
              ))}
              {!log.length && <li className="muted">No activity yet</li>}
            </ul>
          )}
        </aside>
      )}
      <aside className="panel" aria-label="Actionable details">
        <div className="row">
          <span className="eyebrow">Actionable · {card.displayId}</span>
          <Button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="Edit card" onClick={() => setEditing(!editing)}>
            <Pencil size={13} />
          </Button>
          <Button className="icon-btn" aria-label="Close panel" onClick={app.closePanel}>
            <PanelRightClose size={14} />
          </Button>
        </div>
        <div className="row">
          <Tag tone={card.agentState === 'running' ? 'green' : undefined}>{stateLabel(card, app.snapshot?.columns)}</Tag>
          <span className="small muted" style={{ marginLeft: 'auto' }}>
            Created {when(card.createdAt)}
          </span>
        </div>
        {editing ? (
          <CardEditor card={card} onClose={() => setEditing(false)} />
        ) : (
          <>
            <h2 className="selectable">{card.title}</h2>
            <div className="row small">
              <SourceIcon kind={card.source.kind} />
              <span style={{ fontSize: 12 }}>{card.source.name}</span>
              {card.source.kind === 'api' && <Tag>Custom API source</Tag>}
              <PriorityTag priority={card.priority} />
            </div>
            <TagEditor card={card} />
            {card.body && <Markdown source={card.body} onLink={openLink} />}
          </>
        )}
        {card.links.length > 0 && (
          <div className="col" style={{ gap: 9 }}>
            {card.links.map((l) => (
              <a key={l.url} className="card-link" style={{ fontSize: 12 }} href={l.url} onClick={(e) => (e.preventDefault(), openLink(l.url))}>
                {/github\.com\/.+\/pull\//.test(l.url) ? <GitPullRequest size={12} /> : <ExternalLink size={12} />}
                <span className="truncate">{l.label}</span>
              </a>
            ))}
          </div>
        )}

        {actions.length > 0 && (
          <div className="col" style={{ gap: 10 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              {actions.map((a) => (
                <ActionButton key={a} action={a} large onClick={(el) => app.act(a, card, el)} />
              ))}
            </div>
          </div>
        )}

        {q && (
          <div className="question" role="group" aria-label="Agent question">
            <b>Agent needs input</b>
            <span>{q.prompt}</span>
            {q.options && (
              <div className="row wrap" style={{ gap: 6 }}>
                {q.options.map((o) => (
                  <Button key={o} className="btn sm" onClick={() => sendAnswer(o)}>
                    {o}
                  </Button>
                ))}
              </div>
            )}
            <textarea className="field" rows={2} placeholder="Type an answer…" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <div className="row">
              <Button className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={!answer.trim()} onClick={() => sendAnswer(answer)}>
                Send answer
              </Button>
            </div>
          </div>
        )}

        {reopening && (
          <section>
            <h3>Reopen with feedback</h3>
            <textarea className="field" rows={3} autoFocus placeholder="What should the agent change?" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
            <div className="row">
              <Button className="btn sm" onClick={() => app.setReopenFor(undefined)}>
                Cancel
              </Button>
              <Button
                className="btn sm primary"
                onClick={async () => {
                  await app.run(api.board.reopen(card.id, feedback.trim() || undefined))
                  app.setReopenFor(undefined)
                }}
              >
                Reopen and resume
              </Button>
            </div>
          </section>
        )}

        {d && (
          <details className="collapsible">
            <summary className="row">
              <ChevronRight size={13} className="chevron" />
              <h3>Agent dispatch</h3>
              <span className="small muted" style={{ marginLeft: 'auto' }}>
                Started by {d.startedBy}
              </span>
            </summary>
            <dl className="kv">
              <dt>Agent</dt>
              <dd>{PROVIDER_LABEL[d.provider] ?? d.provider}{d.model ? ` · ${d.model[0]!.toUpperCase()}${d.model.slice(1)}` : ''}</dd>
              <dt>Repository</dt>
              <dd>{d.repository}</dd>
              <dt>Workspace</dt>
              <dd className="mono selectable">{d.worktreePath}</dd>
              <dt>Permissions</dt>
              <dd>{PRESET_LABEL[d.permissionPreset]}</dd>
            </dl>
            <div className="box">
              <span className="eyebrow">Instructions</span>
              <span className="selectable" style={{ whiteSpace: 'pre-wrap' }}>{d.instructions}</span>
            </div>
          </details>
        )}

        {(r || card.error) && (
          <details className="collapsible">
            <summary className="row">
              <ChevronRight size={13} className="chevron" />
              <h3>Result</h3>
            </summary>
            {card.error && <div className="tag red" style={{ height: 'auto', padding: 6 }}>{card.error}</div>}
            {r && (
              <>
                <Markdown source={r.summary} onLink={openLink} />
                <dl className="kv">
                  {(
                    [
                      ['Files', r.filesChanged.length > 0 && <span className="mono">{r.filesChanged.map((f) => <div key={f}>{f}</div>)}</span>],
                      ['Branch', r.branch && <span className="mono">{r.branch}</span>],
                      ['Pull request', r.prUrl && <a href={r.prUrl} onClick={(e) => (e.preventDefault(), openLink(r.prUrl!))}>{r.prUrl.replace(/^https:\/\/github\.com\//, '')}</a>],
                      ['Tests', r.testsRun],
                      ['Cost', d && `$${d.costUsd.toFixed(2)} · ${Math.round(d.inputTokens / 1000)}k in / ${(d.outputTokens / 1000).toFixed(1)}k out`],
                    ] as [string, ReactNode][]
                  )
                    .filter(([, v]) => v)
                    .map(([label, v]) => (
                      <Fragment key={label}>
                        <dt>{label}</dt>
                        <dd>{v}</dd>
                      </Fragment>
                    ))}
                </dl>
                {r.openQuestions.length > 0 && (
                  <div className="box">
                    <span className="eyebrow">Open questions</span>
                    {r.openQuestions.map((oq) => (
                      <span key={oq}>{oq}</span>
                    ))}
                  </div>
                )}
              </>
            )}
          </details>
        )}

        <details className="collapsible">
          <summary className="row">
            <ChevronRight size={13} className="chevron" />
            <h3>Activity</h3>
          </summary>
          <ul className="timeline" style={{ margin: 0 }}>
            {events.map((e) => (
              <CardEvent key={e.id} e={e} time={when} />
            ))}
            {!events.length && <li className="muted">No activity yet</li>}
          </ul>
          <Button className={`btn sm ${side === 'log' ? 'active' : ''}`} style={{ alignSelf: 'flex-start' }} onClick={() => (side === 'log' ? setSide(undefined) : openLog())}>
            <List size={12} /> View log
          </Button>
        </details>

        {d && (
          <details className="collapsible" open>
            <summary className="row">
              <ChevronRight size={13} className="chevron" />
              <h3>Output</h3>
            </summary>
            <ul className="timeline" style={{ margin: 0 }}>
              {messages.map((t, i) => (
                <li key={i}>
                  <span className="selectable clamp-3">{describeAgentEvent(t.event)}</span>
                  <span className="mono">{clockSeconds(t.at)}</span>
                </li>
              ))}
              {!messages.length && <li className="muted">No agent messages yet</li>}
            </ul>
            <Button className={`btn sm ${side === 'transcript' ? 'active' : ''}`} style={{ alignSelf: 'flex-start' }} onClick={() => setSide(side === 'transcript' ? undefined : 'transcript')}>
              <FileText size={12} /> Open transcript
            </Button>
          </details>
        )}
      </aside>
    </>
  )
}

const SYSTEM_TAGS: string[] = Object.values(TAGS)

function TagEditor({ card }: { card: Actionable }) {
  const app = useApp()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const known = [...new Set(app.snapshot?.actionables.flatMap((a) => a.tags) ?? [])].filter((t) => !SYSTEM_TAGS.includes(t) && !card.tags.includes(t))
  const save = (tags: string[]) => app.run(api.board.edit(card.id, { tags }))
  const add = async () => {
    if (draft.trim()) await save([...card.tags, draft.trim()])
    setDraft('')
    setAdding(false)
  }
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {card.tags.map((t) => (
        <Tag key={t}>
          {t}
          {!SYSTEM_TAGS.includes(t) && (
            <Button className="tag-remove" aria-label={`Remove tag ${t}`} onClick={() => save(card.tags.filter((x) => x !== t))}>
              <X size={10} />
            </Button>
          )}
        </Tag>
      ))}
      {adding ? (
        <>
          <input
            className="field tag-input"
            autoFocus
            list="known-tags"
            placeholder="Tag name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => (e.key === 'Enter' ? void add() : e.key === 'Escape' && setAdding(false))}
            onBlur={() => void add()}
          />
          <datalist id="known-tags">
            {known.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </>
      ) : (
        <Button className="btn sm ghost" onClick={() => setAdding(true)}>
          <Plus size={11} /> Tag
        </Button>
      )}
    </div>
  )
}

function CardEditor({ card, onClose }: { card: Actionable; onClose: () => void }) {
  const app = useApp()
  const [title, setTitle] = useState(card.title)
  const [body, setBody] = useState(card.body ?? '')
  const [priority, setPriority] = useState(card.priority ?? 'normal')
  const save = async () => {
    await app.run(api.board.edit(card.id, { title, body, priority }))
    onClose()
  }
  return (
    <div className="col" style={{ gap: 10 }}>
      <input className="field" aria-label="Title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && void save()} />
      <textarea className="field" aria-label="Description" rows={6} placeholder="Description (Markdown)" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row">
        <Select label="Priority" value={priority} options={PRIORITIES.map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))} onChange={setPriority} />
        <Button className="btn sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
          Cancel
        </Button>
        <Button className="btn sm primary" disabled={!title.trim()} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}
