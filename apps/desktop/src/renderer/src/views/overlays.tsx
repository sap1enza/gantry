import { PERMISSION_PRESETS, PRIORITIES, type Actionable, type Link, type PermissionPreset, type Priority, type Repository } from '@gantry/shared'
import { Mail, Plus, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useApp } from '../app'
import { api } from '../bridge'
import { SNOOZE_PRESETS, snoozeUntil } from '../lib/snooze'
import { Github, Modal, Popover, PRESET_HINT, PRESET_LABEL, PROVIDER_LABEL, SourceIcon, Tag } from '../ui'
import { useBrowserAuth } from './connections'
import { stateLabel } from './details'

export function SearchPalette() {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Actionable[]>([])
  const [active, setActive] = useState(0)
  useEffect(() => {
    const t = setTimeout(async () => {
      setResults((await api.board.search(query)) ?? [])
      setActive(0)
    }, 120)
    return () => clearTimeout(t)
  }, [query])
  const close = () => app.setSearchOpen(false)
  const choose = (a?: Actionable) => {
    if (!a) return
    close()
    app.open(a.id)
  }
  return (
    <div className="overlay top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Search actionables">
        <div className="row" style={{ paddingLeft: 14 }}>
          <Search size={15} className="muted" />
          <input
            autoFocus
            placeholder="Search title, body, source, or GT-id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              else if (e.key === 'ArrowDown') (e.preventDefault(), setActive((i) => Math.min(results.length - 1, i + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((i) => Math.max(0, i - 1)))
              else if (e.key === 'Enter') choose(results[active])
            }}
          />
        </div>
        <div className="palette-list" role="listbox">
          {query && !results.length && <div className="palette-item muted">No matches</div>}
          {!query && <div className="palette-item muted">Searches every card, including Done, Dismissed, and Snoozed.</div>}
          {results.map((a, i) => (
            <div key={a.id} role="option" aria-selected={i === active} className={`palette-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(a)}>
              <SourceIcon kind={a.source.kind} />
              <span className="mono muted">{a.displayId}</span>
              <span className="grow truncate">{a.title}</span>
              <Tag>{stateLabel(a, app.snapshot?.columns)}</Tag>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function NewActionableModal() {
  const app = useApp()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [links, setLinks] = useState<Link[]>([])
  const [repository, setRepository] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [repos, setRepos] = useState<Repository[]>([])
  useEffect(() => void api.repos.list().then(setRepos), [])
  const close = () => app.setNewOpen(false)
  const validLinks = links.filter((l) => l.label.trim() && /^https?:\/\//.test(l.url.trim()))
  const create = async () => {
    const a = await app.run(
      api.board.create({ title: title.trim(), body: body.trim() || undefined, sourceName: sourceName.trim() || undefined, links: validLinks, repository: repository || undefined, priority }),
    )
    if (!a) return
    close()
    app.open(a.id)
  }
  return (
    <Modal
      title="New actionable"
      subtitle="Create a card manually. You can dispatch an agent to it from To-do."
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!title.trim()} onClick={create}>
            Create actionable
          </button>
        </>
      }
    >
      <label className="form-label">
        Title
        <input className="field" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs attention?" onKeyDown={(e) => e.key === 'Enter' && title.trim() && create()} />
      </label>
      <label className="form-label">
        Body (markdown)
        <textarea className="field" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <label className="form-label grow">
          Source name
          <input className="field" value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="Manual" />
        </label>
        <label className="form-label grow">
          Repository
          <select className="select" value={repository} onChange={(e) => setRepository(e.target.value)}>
            <option value="">None</option>
            {repos.map((r) => (
              <option key={r.id} value={r.remote}>
                {r.remote}
              </option>
            ))}
          </select>
        </label>
        <label className="form-label">
          Priority
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p[0]!.toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-label">
        Links
        {links.map((l, i) => (
          <div key={i} className="row">
            <input className="field" style={{ width: 150 }} placeholder="Label" value={l.label} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <input className="field grow" placeholder="https://" value={l.url} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
            <button className="icon-btn" aria-label="Remove link" onClick={() => setLinks(links.filter((_, j) => j !== i))}>
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setLinks([...links, { label: '', url: '' }])}>
          <Plus size={12} /> Add link
        </button>
      </div>
    </Modal>
  )
}

export function SnoozeMenu() {
  const app = useApp()
  const { card, anchor } = app.snoozeFor!
  const [custom, setCustom] = useState('')
  const close = () => app.setSnoozeFor(undefined)
  const snooze = async (until: Date) => {
    close()
    await app.run(api.board.snooze(card.id, until.toISOString()))
  }
  return (
    <Popover anchor={anchor} onClose={close}>
      <div className="menu-label">Snooze {card.displayId} until</div>
      {SNOOZE_PRESETS.map((p) => (
        <button key={p.id} className="menu-item" onClick={() => snooze(snoozeUntil(p.id))}>
          {p.label}
          <span className="faint small" style={{ marginLeft: 'auto' }}>
            {snoozeUntil(p.id).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
          </span>
        </button>
      ))}
      <div className="menu-sep" />
      <div className="row" style={{ padding: '4px 6px' }}>
        <input className="field grow" type="datetime-local" aria-label="Custom snooze time" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button className="btn sm" disabled={!custom || new Date(custom) <= new Date()} onClick={() => snooze(new Date(custom))}>
          Snooze
        </button>
      </div>
    </Popover>
  )
}

export function DispatchSheet() {
  const app = useApp()
  const { card, preview } = app.dispatchFor!
  const [instructions, setInstructions] = useState(preview.instructions)
  const [repository, setRepository] = useState(preview.repository ?? '')
  const [model, setModel] = useState(preview.model ?? preview.models[0]?.id ?? '')
  const [preset, setPreset] = useState<PermissionPreset>(preview.permissionPreset === 'full' && !preview.fullPresetAvailable ? 'edit_test' : preview.permissionPreset)
  const close = () => app.setDispatchFor(undefined)
  const start = async () => {
    close()
    await app.run(api.board.start(card.id, { instructions, repository, model, permissionPreset: preset }))
  }
  return (
    <Modal
      wide
      title={`Start ${card.displayId}`}
      subtitle={card.title}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!repository || !instructions.trim()} onClick={start}>
            Start agent
          </button>
        </>
      }
    >
      <label className="form-label">
        Instructions
        <textarea className="field mono" rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </label>
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <label className="form-label grow">
          Repository
          <select className="select" value={repository} onChange={(e) => setRepository(e.target.value)}>
            {!preview.repository && <option value="">Choose a repository…</option>}
            {preview.repositoryCandidates.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {!preview.repositoryCandidates.length && <span className="small" style={{ color: 'var(--red)', fontWeight: 400 }}>Register a repository in Preferences first.</span>}
        </label>
        <label className="form-label grow">
          Agent
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
            {preview.models.map((m) => (
              <option key={m.id} value={m.id}>
                {PROVIDER_LABEL[preview.provider] ?? preview.provider} · {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="form-label" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ marginBottom: 6 }}>Permissions</legend>
        {PERMISSION_PRESETS.map((p) => {
          const disabled = p === 'full' && !preview.fullPresetAvailable
          return (
            <label key={p} className="check" style={{ fontWeight: 400, color: 'var(--text)', opacity: disabled ? 0.55 : 1, padding: '3px 0' }}>
              <input type="radio" name="preset" checked={preset === p} disabled={disabled} onChange={() => setPreset(p)} />
              <b style={{ fontWeight: 600 }}>{PRESET_LABEL[p]}</b>
              <span className="muted">{PRESET_HINT[p]}</span>
              {disabled && <span className="small" style={{ color: 'var(--amber)' }}>Requires GitHub CLI auth — run <code>gh auth login</code></span>}
            </label>
          )
        })}
      </fieldset>
    </Modal>
  )
}

export function NameModal() {
  const app = useApp()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [askEmail, setAskEmail] = useState(false)
  const signedIn = app.account?.signedIn
  const auth = useBrowserAuth()
  const signIn = async (method: 'github' | 'email') => {
    if ((await auth.start(api.account.setName(name.trim()).then(() => api.account.signIn(method, method === 'email' ? email : undefined)))) && method === 'email') app.toast(`Magic link sent to ${email}`)
  }
  const save = async () => {
    await app.run(api.account.setName(name.trim()))
    await app.reloadAccount()
  }
  return (
    <div className="overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Welcome to Gantry">
        <div className="modal-head">
          <h2>Welcome to Gantry</h2>
          <p>Tell us what to call you. Signing in is optional and enables multi-device later.</p>
        </div>
        <div className="modal-body">
          <label className="form-label">
            Your name
            <input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && save()} />
          </label>
          <div className="row">
            <span className="small muted">Optional</span>
            <div className="divider grow" />
          </div>
          {signedIn ? (
            <Tag tone="green">Signed in{app.account?.githubLogin ? ` as ${app.account.githubLogin}` : app.account?.email ? ` as ${app.account.email}` : ''}</Tag>
          ) : (
            <div className="row wrap">
              <button className="btn" onClick={() => signIn('github')}>
                <Github size={13} /> Sign in with GitHub
              </button>
              {askEmail ? (
                <>
                  <input className="field grow" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <button className="btn" disabled={!/^\S+@\S+\.\S+$/.test(email)} onClick={() => signIn('email')}>
                    Send link
                  </button>
                </>
              ) : (
                <button className="btn" onClick={() => setAskEmail(true)}>
                  <Mail size={13} /> Sign in with email
                </button>
              )}
            </div>
          )}
          {auth.banner}
        </div>
        <div className="modal-foot">
          <button className="btn primary" disabled={!name.trim()} onClick={save}>
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
