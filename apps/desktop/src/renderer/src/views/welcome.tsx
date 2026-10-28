import { PROVIDER_SOURCE, TRIGGERS, type OAuthProvider } from '@gantry/shared'
import { ArrowUpRight, Check, CircleCheck, CircleDashed, CircleDot, CircleHelp, Inbox, Lock, Pause, Plus, ShieldCheck, SlidersHorizontal, SquareTerminal, Webhook, X } from 'lucide-react'
import { useApp } from '../app'
import { api } from '../bridge'
import { Github, OAUTH_INPUTS, SOURCE_LABELS, SourceIcon } from '../ui'
import { useBrowserAuth } from './connections'

const HINTS = { github: 'Pull requests, issues, and alerts' } as const

function useSetupProgress() {
  const app = useApp()
  const connected = app.connections.filter((c) => c.provider !== 'api' && c.status === 'connected')
  const triggersChosen = connected.some((c) =>
    Object.entries(TRIGGERS).some(([id, t]) => c.provider !== 'api' && t.source === PROVIDER_SOURCE[c.provider] && app.settings?.triggers[id as keyof typeof TRIGGERS]),
  )
  const canDispatch = !!app.checks?.claude.available && (app.checks?.repositories ?? 0) > 0
  const dispatched = !!app.snapshot?.actionables.some((a) => a.dispatch)
  const steps = [connected.length > 0, triggersChosen, canDispatch && dispatched]
  return { steps, done: steps.filter(Boolean).length, canDispatch }
}

export function Welcome({ embedded }: { embedded?: boolean }) {
  const app = useApp()
  const { steps, done, canDispatch } = useSetupProgress()
  const current = steps.findIndex((s) => !s)
  const statusOf = (provider: string) => app.connections.find((c) => c.provider === provider)?.status
  const auth = useBrowserAuth()
  const connect = (p: OAuthProvider) => auth.start(api.connections.connect(p))
  const stepClass = (i: number) => `step ${steps[i] ? 'complete' : i === current ? 'current' : ''}`

  const stepsGrid = (
    <>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 24, fontWeight: 600 }}>Bring your work into focus.</h2>
          <p className="muted" style={{ marginTop: 10 }}>Connect an input, choose what needs attention, and hand the next step to an agent.</p>
        </div>
        <span className="tag" style={{ marginLeft: 'auto' }}>
          {done} of 3 steps complete
        </span>
        {embedded && (
          <button className="icon-btn" aria-label="Close setup" onClick={() => app.setShowWelcome(false)}>
            <X size={14} />
          </button>
        )}
      </div>
      <div className="welcome-steps">
        <div className={stepClass(0)}>
          <h3>
            <span className="step-n">{steps[0] ? <Check size={12} /> : 1}</span> Connect your inputs
          </h3>
          <span className="muted">Start with one. You can add more connections later.</span>
          {OAUTH_INPUTS.map(({ provider, kind }, i) => (
            <div key={provider} className="row">
              <SourceIcon kind={kind} size={17} />
              <div className="grow">
                <b>{SOURCE_LABELS[kind]}</b>
                <div className="tiny muted">{HINTS[provider]}</div>
              </div>
              {statusOf(provider) === 'connected' ? (
                <span className="tag green">Connected</span>
              ) : (
                <button className={`btn sm ${i === 0 && !steps[0] ? 'primary' : ''}`} onClick={() => connect(provider)}>
                  <ArrowUpRight size={12} /> {statusOf(provider) === 'reconnect_required' ? 'Reconnect' : 'Connect'}
                </button>
              )}
            </div>
          ))}
          {auth.banner}
          <span className="tiny muted row" style={{ gap: 5 }}>
            <Lock size={10} /> Secure OAuth · Revoke access anytime
          </span>
        </div>
        <div className={stepClass(1)}>
          <h3>
            <span className="step-n">{steps[1] ? <Check size={12} /> : 2}</span> Choose your triggers
          </h3>
          <span className="muted">After connecting, decide what becomes an actionable. Suggested starting points:</span>
          <ul>
            {['PRs with red CI, conflicts, or changes requested', 'Review requests and direct mentions'].map((t) => (
              <li key={t}>
                <Check size={13} color="var(--accent)" /> {t}
              </li>
            ))}
          </ul>
          <a className="tiny" onClick={() => app.go('connections')}>
            You control each trigger in Connections.
          </a>
        </div>
        <div className={stepClass(2)}>
          <h3>
            <span className="step-n">{steps[2] ? <Check size={12} /> : 3}</span> Dispatch your first agent
          </h3>
          <span className="muted">Open an actionable, review its context, and select Start. Gantry creates an isolated workspace.</span>
          <ul>
            <li>
              <SquareTerminal size={13} />
              {app.checks?.claude.available ? `Claude Code · Available locally${app.checks.claude.version ? ` (${app.checks.claude.version})` : ''}` : `Claude Code not found — ${app.checks?.claude.reason ?? 'install it and add it to PATH'}`}
            </li>
            <li>
              {(app.checks?.repositories ?? 0) > 0 ? <CircleCheck size={13} /> : <CircleDashed size={13} />}
              {app.checks?.repositories ?? 0} registered repositor{app.checks?.repositories === 1 ? 'y' : 'ies'}
            </li>
            <li>
              {app.checks?.gh.authenticated ? <CircleCheck size={13} /> : <CircleDashed size={13} />}
              {app.checks?.gh.authenticated ? (
                'GitHub CLI · Authenticated'
              ) : (
                <>
                  GitHub CLI not authenticated — run <code>gh auth login</code> to use the Full preset
                </>
              )}
            </li>
            <li>
              <ShieldCheck size={13} /> Review permissions before dispatch
            </li>
            <li>
              <Pause size={13} /> Pause or stop at any time
            </li>
          </ul>
          <div className="row">
            <button className="btn sm" onClick={() => app.go('preferences')}>
              <SlidersHorizontal size={12} /> Agent preferences
            </button>
            <span className="tag">{canDispatch ? 'Waiting for an actionable' : 'Needs Claude Code and a repository'}</span>
          </div>
        </div>
      </div>
    </>
  )

  if (embedded) return <div style={{ padding: '16px 16px 0' }}>{stepsGrid}</div>

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Welcome to Gantry</h1>
          <p>A quiet place to triage work and dispatch agents.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => app.go('preferences')}>
            <CircleHelp size={13} /> Help
          </button>
        </div>
      </div>
      <div className="page-body">
        {stepsGrid}
        <div className="empty-board">
          <div className="heads">
            <span className="row">
              <CircleDashed size={14} /> To-do <span className="muted small">0</span>
            </span>
            <span className="row">
              <CircleDot size={14} /> In Progress <span className="muted small">0</span>
            </span>
            <span className="row">
              <CircleCheck size={14} /> Done <span className="muted small">0</span>
            </span>
          </div>
          <div className="empty-state">
            <div className="empty-icon">
              <Inbox size={20} />
            </div>
            <h3>No actionables yet</h3>
            <span className="muted">Your connected inputs will appear here. Nothing runs until you start it.</span>
            <div className="row">
              <button className="btn primary" onClick={() => connect('github')}>
                <Github size={13} /> Connect GitHub
              </button>
              <button className="btn" onClick={() => app.setNewOpen(true)}>
                <Plus size={13} /> Create manually
              </button>
            </div>
            <span className="tiny faint">No sample data has been added to your workspace.</span>
          </div>
        </div>
        <div className="banner" style={{ marginTop: 22 }}>
          <Webhook size={17} />
          <div className="grow">
            <b>Work can come from anywhere.</b>
            Use the API to create actionables from Honeybadger, your automations, or another agent.
          </div>
          <button className="btn sm" onClick={() => app.go('connections')}>
            <ArrowUpRight size={12} /> Set up API access
          </button>
        </div>
      </div>
    </>
  )
}
