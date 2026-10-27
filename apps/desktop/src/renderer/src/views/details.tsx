import { actionsFor, isAgentActive, isCustomColumn, type Actionable, type Column, type ActivityEvent, type AgentEvent, type TranscriptEntry } from '@gantry/shared'
import { ArrowUpRight, ExternalLink, FileText, GitPullRequest, PanelRightClose } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { useApp, usePush } from '../app'
import { api } from '../bridge'
import { ActionButton, AGENT_STATE_LABEL, clock, clockSeconds, Markdown, Modal, PRESET_LABEL, SOURCE_LABELS, SourceIcon, Tag, PriorityTag, PROVIDER_LABEL } from '../ui'

export function stateLabel(a: Actionable, columns: Column[] = []) {
  if (a.dismissedAt) return 'Dismissed'
  if (a.archivedAt) return 'Archived'
  if (a.snoozedUntil && new Date(a.snoozedUntil) > new Date()) return 'Snoozed'
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
  const [live, setLive] = useState<{ at: string; text: string }[]>([])
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState('')
  const [transcript, setTranscript] = useState<TranscriptEntry[]>()

  const version = app.snapshot?.actionables.find((a) => a.id === id)?.updatedAt
  const fetchCard = useCallback(() => void api.board.get(id).then((c) => c && setFetched((prev) => (prev?.id === c.id && prev.updatedAt > c.updatedAt ? prev : c))), [id])
  useEffect(() => {
    setLive([])
    setAnswer('')
    setFeedback('')
    void api.activity.list({ actionableId: id, limit: 6 }).then((log) => setEvents(log.events))
  }, [id])
  useEffect(fetchCard, [fetchCard, version])
  usePush('board.changed', () => !version && fetchCard())
  usePush('activity.appended', ({ event }) => event.actionableId === id && setEvents((list) => [event, ...list].slice(0, 6)))
  usePush('agent.event', ({ actionableId, event }) => {
    const text = actionableId === id && describeAgentEvent(event)
    if (text) setLive((list) => [{ at: new Date().toISOString(), text }, ...list].slice(0, 20))
  })

  if (!card) return <aside className="panel" />
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
    <aside className="panel" aria-label="Actionable details">
      <div className="row">
        <span className="eyebrow">Actionable · {card.displayId}</span>
        <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="Close panel" onClick={app.closePanel}>
          <PanelRightClose size={14} />
        </button>
      </div>
      <div className="row">
        <Tag tone={card.agentState === 'running' ? 'green' : undefined}>{stateLabel(card, app.snapshot?.columns)}</Tag>
        <span className="small muted" style={{ marginLeft: 'auto' }}>
          Created {clock(card.createdAt)}
        </span>
      </div>
      <h2 className="selectable">{card.title}</h2>
      <div className="row small">
        <SourceIcon kind={card.source.kind} />
        <span style={{ fontSize: 12 }}>{card.source.name}</span>
        <Tag>{card.source.kind === 'api' ? 'Custom API source' : SOURCE_LABELS[card.source.kind]}</Tag>
        <PriorityTag priority={card.priority} />
      </div>
      {card.tags.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {card.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </div>
      )}
      {card.body && <Markdown source={card.body} onLink={openLink} />}
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

      {q && (
        <div className="question" role="group" aria-label="Agent question">
          <b>Agent needs input</b>
          <span>{q.prompt}</span>
          {q.options && (
            <div className="row wrap" style={{ gap: 6 }}>
              {q.options.map((o) => (
                <button key={o} className="btn sm" onClick={() => sendAnswer(o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <textarea className="field" rows={2} placeholder="Type an answer…" value={answer} onChange={(e) => setAnswer(e.target.value)} />
          <div className="row">
            <button className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={!answer.trim()} onClick={() => sendAnswer(answer)}>
              Send answer
            </button>
          </div>
        </div>
      )}

      {d && (
        <section>
          <div className="row">
            <h3>Agent dispatch</h3>
            <span className="small muted" style={{ marginLeft: 'auto' }}>
              Started by {d.startedBy}
            </span>
          </div>
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
        </section>
      )}

      {(r || card.error) && (
        <section>
          <h3>Result</h3>
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
        </section>
      )}

      <section>
        <div className="row">
          <h3>Latest activity</h3>
          <a className="small" style={{ marginLeft: 'auto' }} onClick={() => app.go('activity', { activityCard: card.id })}>
            View log <ArrowUpRight size={11} />
          </a>
        </div>
        <ul className="timeline" style={{ margin: 0 }}>
          {live.map((l, i) => (
            <li key={`live-${i}`}>
              {l.text}
              <span className="mono">{clockSeconds(l.at)} · live</span>
            </li>
          ))}
          {events.map((e) => (
            <li key={e.id}>
              {e.title}
              <span className="mono">{clockSeconds(e.createdAt)}</span>
            </li>
          ))}
          {!live.length && !events.length && <li className="muted">No activity yet</li>}
        </ul>
        {d && (
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={async () => setTranscript(await api.board.transcript(card.id))}>
            <FileText size={12} /> Open transcript
          </button>
        )}
      </section>

      {reopening && (
        <section>
          <h3>Reopen with feedback</h3>
          <textarea className="field" rows={3} autoFocus placeholder="What should the agent change?" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <div className="row">
            <button className="btn sm" onClick={() => app.setReopenFor(undefined)}>
              Cancel
            </button>
            <button
              className="btn sm primary"
              onClick={async () => {
                await app.run(api.board.reopen(card.id, feedback.trim() || undefined))
                app.setReopenFor(undefined)
              }}
            >
              Reopen and resume
            </button>
          </div>
        </section>
      )}

      {actions.length > 0 && (
        <div className="col" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            {actions.map((a) => (
              <ActionButton key={a} action={a} large onClick={(el) => app.act(a, card, el)} />
            ))}
          </div>
          {isAgentActive(card) && <span className="small muted">Pause or stop the agent before snoozing.</span>}
        </div>
      )}

      {transcript && (
        <Modal title={`Transcript · ${card.displayId}`} wide onClose={() => setTranscript(undefined)} footer={<button className="btn" onClick={() => setTranscript(undefined)}>Close</button>}>
          <div className="transcript">
            {transcript.length === 0 && <span className="muted">No transcript events recorded yet.</span>}
            {transcript.map((t, i) => (
              <div key={i}>
                <span className="faint">{clockSeconds(t.at)}</span> <b>{t.event.type}</b> {describeAgentEvent(t.event) ?? JSON.stringify(t.event)}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </aside>
  )
}
