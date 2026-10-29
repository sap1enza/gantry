import { PERMISSION_PRESETS, PRIORITIES, type Actionable, type Link, type PermissionPreset, type Priority, type Repository } from '@gantry/shared'
import { Plus, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useApp } from '../app'
import { api } from '../bridge'
import { Button, Modal, Popover, PRESET_HINT, PRESET_LABEL, PROVIDER_LABEL, Select, SourceIcon, Tag } from '../ui'
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
          {!query && <div className="palette-item muted">Searches every card, including Done and Dismissed.</div>}
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
          <Button className="btn" onClick={close}>
            Cancel
          </Button>
          <Button className="btn primary" disabled={!title.trim()} onClick={create}>
            Create actionable
          </Button>
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
          <Select label="Repository" value={repository} options={[{ value: '', label: 'None' }, ...repos.map((r) => ({ value: r.remote, label: r.remote }))]} onChange={setRepository} />
        </label>
        <label className="form-label">
          Priority
          <Select label="Priority" value={priority} options={PRIORITIES.map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))} onChange={setPriority} />
        </label>
      </div>
      <div className="form-label">
        Links
        {links.map((l, i) => (
          <div key={i} className="row">
            <input className="field" style={{ width: 150 }} placeholder="Label" value={l.label} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <input className="field grow" placeholder="https://" value={l.url} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
            <Button className="icon-btn" aria-label="Remove link" onClick={() => setLinks(links.filter((_, j) => j !== i))}>
              <X size={13} />
            </Button>
          </div>
        ))}
        <Button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setLinks([...links, { label: '', url: '' }])}>
          <Plus size={12} /> Add link
        </Button>
      </div>
    </Modal>
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
          <Button className="btn" onClick={close}>
            Cancel
          </Button>
          <Button className="btn primary" disabled={!repository || !instructions.trim()} onClick={start}>
            Start agent
          </Button>
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
          <Select
            label="Repository"
            value={repository}
            options={[...(preview.repository ? [] : [{ value: '', label: 'Choose a repository…' }]), ...preview.repositoryCandidates.map((r) => ({ value: r, label: r }))]}
            onChange={setRepository}
          />
          {!preview.repositoryCandidates.length && <span className="small" style={{ color: 'var(--red)', fontWeight: 400 }}>Register a repository in Preferences first.</span>}
        </label>
        <label className="form-label grow">
          Agent
          <Select label="Agent" value={model} options={preview.models.map((m) => ({ value: m.id, label: `${PROVIDER_LABEL[preview.provider] ?? preview.provider} · ${m.label}` }))} onChange={setModel} />
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
