import { GMAIL_CATEGORIES, TRIGGERS, type ApiTokenInfo, type ConnectionInfo, type CreatedApiToken, type OAuthProvider, type Settings, type TriggerId } from '@gantry/shared'
import { Activity, ArrowUpRight, Copy, ExternalLink, Hash, Info, KeyRound, Mail, RefreshCw, Send, ShieldCheck, Webhook, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useApp, usePush } from '../app'
import { api } from '../bridge'
import { ago, clock, Github, Modal, Popover, Select, Tag, toggle, Toggle, usePopover } from '../ui'

const STATUS_LABEL = { connected: 'Connected', reconnect_required: 'Reconnect required', disconnected: 'Disconnected' } as const
const TRIGGER_HINT: Partial<Record<TriggerId, string>> = {
  'slack.mention': 'Messages that mention you directly.',
  'slack.unreplied': 'An LLM checks whether a mention still needs your reply.',
  'slack.follow_up': 'An LLM finds answered threads with a remaining next step.',
  'email.new': 'Create an actionable for incoming messages in your inbox.',
}
const LLM_TRIGGERS = new Set<TriggerId>(['slack.unreplied', 'slack.follow_up'])
const SEVERITIES = (['low', 'medium', 'high', 'critical'] as const).map((v) => ({ value: v, label: `≥ ${v}` }))
const ISSUE_SCOPES = [
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'all', label: 'Any new issue' },
] as const
const UNREPLIED_MINUTES = [15, 30, 60, 120, 240].map((m) => ({ value: String(m), label: `${m} minutes` }))
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

type ListSection = 'slack' | 'email'
type Section = 'github' | ListSection

function useSection<K extends Section>(settings: Settings, key: K) {
  const app = useApp()
  return (patch: Partial<Settings[K]>) => app.updateSettings({ [key]: { ...settings[key], ...patch } })
}

function ListInputs<K extends ListSection>({ rows, values, onSave }: { rows: readonly (readonly [keyof Settings[K], string, string])[]; values: Settings[K]; onSave: (patch: Partial<Settings[K]>) => void }) {
  return rows.map(([key, label, placeholder]) => (
    <div key={String(key)} className="row">
      <span className="small muted" style={{ width: 120 }}>{label}</span>
      <input className="field grow" aria-label={label} placeholder={placeholder} defaultValue={(values[key] as string[]).join(', ')} onBlur={(e) => onSave({ [key]: list(e.target.value) } as Partial<Settings[K]>)} />
    </div>
  ))
}

export function useBrowserAuth() {
  const app = useApp()
  const [pending, setPending] = useState(false)
  const finished = `${app.account?.signedIn}:${app.connections.filter((c) => c.status === 'connected').map((c) => c.provider)}`
  useEffect(() => setPending(false), [finished])
  return {
    banner: pending && <FinishInBrowser onClose={() => setPending(false)} />,
    async start(p: Promise<void>) {
      const started = !!(await app.run(p.then(() => true)))
      if (started) setPending(true)
      return started
    },
  }
}

function FinishInBrowser({ onClose }: { onClose(): void }) {
  const app = useApp()
  const [code, setCode] = useState('')
  const submit = async () => void ((await app.run(api.account.completeAuth(code.trim()).then(() => (void api.connections.syncNow().catch(() => undefined), true)))) && onClose())
  return (
    <div className="banner">
      <ExternalLink size={15} />
      <div className="grow">
        <b>Finish in your browser</b>
        Gantry continues automatically. If it doesn't, paste the code shown in the browser.
      </div>
      <input className="field mono" style={{ width: 160 }} placeholder="Paste code" aria-label="Completion code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code.trim() && submit()} />
      <button className="btn sm" disabled={!code.trim()} onClick={submit}>
        Finish
      </button>
      <button className="icon-btn" aria-label="Cancel" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  )
}

export function ConnectionsView() {
  const app = useApp()
  const s = app.settings
  if (!s) return null
  const by = (p: ConnectionInfo['provider']) => app.connections.find((c) => c.provider === p) ?? { provider: p, status: 'disconnected' as const }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Connections</h1>
          <p>Choose which inputs become actionables.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => app.go('activity')}>
            <Activity size={13} /> Connection activity
          </button>
        </div>
      </div>
      <div className="page-body">
        <div className="row small muted" style={{ marginBottom: 18 }}>
          <ShieldCheck size={13} /> Connections use OAuth. Gantry only receives events for the triggers you enable.
          <span style={{ marginLeft: 'auto' }}>Changes save automatically</span>
        </div>
        <div className="grid2">
          <GithubCard info={by('github')} settings={s} />
          <SlackCard info={by('slack')} settings={s} />
          <EmailCard info={by('google')} settings={s} />
          <ApiCard />
        </div>
        <div className="row small muted" style={{ marginTop: 20 }}>
          <Info size={13} /> Turning a trigger off stops new actionables. It doesn't dismiss existing work or stop running agents.
        </div>
      </div>
    </>
  )
}

function ConnHead({ icon, name, info, sub, children }: { icon: ReactNode; name: string; info: ConnectionInfo; sub?: string; children?: ReactNode }) {
  const app = useApp()
  const auth = useBrowserAuth()
  const provider = info.provider as OAuthProvider
  const account = info.account ? [info.account.name ?? info.account.login, info.account.team].filter(Boolean).join(' · ') : 'Not connected'
  return (
    <>
      <div className="conn-head">
        <div className="conn-icon">{icon}</div>
        <div className="grow">
          <h3>{name}</h3>
          <span className="small muted">{account}</span>
        </div>
        <Tag tone={info.status === 'connected' ? 'green' : info.status === 'reconnect_required' ? 'amber' : ''}>{STATUS_LABEL[info.status]}</Tag>
      </div>
      <div className="row">
        <span className="small" style={{ color: info.status === 'reconnect_required' ? 'var(--amber)' : 'var(--text-muted)' }}>
          {info.status === 'reconnect_required' ? (info.detail ?? 'OAuth session expired. Existing actionables are kept.') : info.status === 'connected' ? `OAuth · Synced ${ago(info.lastSyncAt)}${sub ? ` · ${sub}` : ''}` : 'Connect to start receiving events.'}
        </span>
        <span className="spacer" />
        {info.status === 'connected' && (
          <button className="btn sm" onClick={() => app.run(api.connections.manageAccess(provider))}>
            Manage access
          </button>
        )}
        {info.status !== 'disconnected' && (
          <button
            className="btn sm"
            onClick={async () => {
              if (await app.confirm(`Disconnect ${name}?`, 'Gantry revokes the grant. Existing cards are kept and tagged “Source disconnected”.', 'Disconnect')) await app.run(api.connections.disconnect(provider))
            }}
          >
            Disconnect
          </button>
        )}
        {info.status !== 'connected' && (
          <button className={`btn ${info.status === 'disconnected' ? 'primary' : ''}`} onClick={() => auth.start(api.connections.connect(provider))}>
            {info.status === 'reconnect_required' ? <RefreshCw size={13} /> : <ArrowUpRight size={13} />}
            {info.status === 'reconnect_required' ? 'Reconnect' : 'Connect'}
          </button>
        )}
      </div>
      {auth.banner}
      {children}
    </>
  )
}

function TriggerRow({ id, settings, children }: { id: TriggerId; settings: Settings; children?: ReactNode }) {
  const app = useApp()
  const t = TRIGGERS[id]
  return (
    <div className="trigger">
      <div className="grow">
        <span className="row" style={{ gap: 6 }}>
          {t.label}
          {LLM_TRIGGERS.has(id) && <Tag tone="blue">AI detected</Tag>}
        </span>
        {TRIGGER_HINT[id] && <p>{TRIGGER_HINT[id]}</p>}
      </div>
      {children}
      <Toggle label={t.label} checked={settings.triggers[id]} onChange={(v) => app.run(api.settings.setTrigger(id, v))} />
    </div>
  )
}

const triggersFor = (source: string) => (Object.keys(TRIGGERS) as TriggerId[]).filter((id) => TRIGGERS[id].source === source)

function GithubCard({ info, settings }: { info: ConnectionInfo; settings: Settings }) {
  const pop = usePopover()
  const [repos, setRepos] = useState<{ fullName: string; selected: boolean }[]>([])
  useEffect(() => void (info.status === 'connected' && api.connections.githubRepositories().then(setRepos)), [info.status])
  const selected = settings.github.repositories
  const setGithub = useSection(settings, 'github')
  return (
    <div className="conn">
      <ConnHead icon={<Github size={18} />} name="GitHub" info={info} sub={`${selected.length} repositories`}>
        <hr />
        <div className="row">
          <span className="eyebrow">Create actionables for</span>
          <a className="small" style={{ marginLeft: 'auto' }} onClick={(e) => pop.toggle(e.currentTarget)}>
            Repositories: {selected.length} selected <ArrowUpRight size={11} />
          </a>
          {pop.anchor && (
            <Popover anchor={pop.anchor} onClose={pop.close} align="right">
              <div className="menu-label">Selected repositories</div>
              {repos.length === 0 && <span className="menu-item muted">Connect GitHub to list repositories</span>}
              {repos.map((r) => (
                <label key={r.fullName} className="menu-item check">
                  <input
                    type="checkbox"
                    checked={selected.includes(r.fullName)}
                    onChange={() => setGithub({ repositories: toggle(selected, r.fullName) })}
                  />
                  {r.fullName}
                </label>
              ))}
            </Popover>
          )}
        </div>
        <div>
          {triggersFor('github').map((id) => (
            <TriggerRow key={id} id={id} settings={settings}>
              {id === 'github.dependabot' && (
                <Select label="Minimum severity" value={settings.github.dependabotMinSeverity} options={SEVERITIES} onChange={(v) => setGithub({ dependabotMinSeverity: v })} />
              )}
              {id === 'github.issue' && (
                <Select label="Issues scope" value={settings.github.issuesScope} options={ISSUE_SCOPES} onChange={(v) => setGithub({ issuesScope: v })} />
              )}
            </TriggerRow>
          ))}
        </div>
      </ConnHead>
    </div>
  )
}

function SlackCard({ info, settings }: { info: ConnectionInfo; settings: Settings }) {
  const setSlack = useSection(settings, 'slack')
  return (
    <div className="conn">
      <ConnHead icon={<Hash size={18} />} name="Slack" info={info}>
        <hr />
        <span className="eyebrow">Create actionables for</span>
        <div className="col" style={{ gap: 10 }}>
          {triggersFor('slack').map((id) => (
            <TriggerRow key={id} id={id} settings={settings} />
          ))}
        </div>
        <div className="box" style={{ gap: 10, padding: 12 }}>
          <div className="row">
            <span className="muted">Check for unreplied mentions after</span>
            <Select style={{ marginLeft: 'auto' }} label="Unreplied after" value={String(settings.slack.unrepliedAfterMinutes)} options={UNREPLIED_MINUTES} onChange={(v) => setSlack({ unrepliedAfterMinutes: Number(v) })} />
          </div>
          <ListInputs<'slack'>
            rows={[
              ['channelAllow', 'Allow channels', '#engineering, #platform (empty = all)'],
              ['channelDeny', 'Ignore channels', '#random'],
            ]}
            values={settings.slack}
            onSave={setSlack}
          />
          <span className="muted">AI suggestions include the original Slack message so you can verify context before dispatching.</span>
        </div>
      </ConnHead>
    </div>
  )
}

function EmailCard({ info, settings }: { info: ConnectionInfo; settings: Settings }) {
  const e = settings.email
  const setEmail = useSection(settings, 'email')
  return (
    <div className="conn">
      <ConnHead icon={<Mail size={18} />} name="Email" info={info}>
        <hr />
        <TriggerRow id="email.new" settings={settings} />
        <div className="trigger">
          <span className="grow muted">Mailbox scope</span>
          <label className="check">
            <input type="checkbox" checked={e.inboxOnly} onChange={() => setEmail({ inboxOnly: !e.inboxOnly })} /> Inbox only
          </label>
          <label className="check">
            <input type="checkbox" checked={e.unreadOnly} onChange={() => setEmail({ unreadOnly: !e.unreadOnly })} /> Unread only
          </label>
        </div>
        <div className="trigger">
          <span className="grow muted">Exclude categories</span>
          {GMAIL_CATEGORIES.map((c) => (
            <label key={c} className="check">
              <input type="checkbox" checked={e.excludeCategories.includes(c)} onChange={() => setEmail({ excludeCategories: toggle(e.excludeCategories, c) })} />
              {c[0]!.toUpperCase() + c.slice(1)}
            </label>
          ))}
        </div>
        <ListInputs<'email'>
          rows={[
            ['domainAllow', 'Only from domains', 'acme.dev, northstar.io'],
            ['domainDeny', 'Ignore domains', 'newsletter.com'],
            ['labels', 'Only with labels', 'Clients'],
          ]}
          values={e}
          onSave={setEmail}
        />
        <div className="trigger">
          <div className="grow">
            <span className="row" style={{ gap: 6 }}>
              “Needs action” gate <Tag tone="blue">AI detected</Tag>
            </span>
            <p>Only create actionables when an LLM decides the email needs action.</p>
          </div>
          <Toggle label="Needs action gate" checked={e.llmGate} onChange={(v) => setEmail({ llmGate: v })} />
        </div>
        {info.status === 'reconnect_required' && <span className="small muted">Receiving resumes after reconnecting. Last received: {info.lastSyncAt ? clock(info.lastSyncAt) : '—'}.</span>}
      </ConnHead>
    </div>
  )
}

function ApiCard() {
  const app = useApp()
  const [endpoint, setEndpoint] = useState('')
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([])
  const [created, setCreated] = useState<CreatedApiToken>()
  const [docs, setDocs] = useState(false)
  const load = useCallback(async () => {
    const [ep, t] = await Promise.all([api.connections.endpoint(), api.connections.apiTokens()])
    setEndpoint(ep)
    setTokens(t)
  }, [])
  useEffect(() => void load(), [load])
  usePush('connections.changed', () => void load())
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    app.toast('Copied to clipboard')
  }
  const create = async () => {
    const name = await app.promptText('Create API token', 'Token name (e.g. Honeybadger)')
    if (!name) return
    const t = await app.run(api.connections.createApiToken(name))
    if (t) setCreated(t)
    await load()
  }
  const active = tokens.filter((t) => !t.revokedAt)
  const path = endpoint.replace(/^https?:\/\/[^/]+/, '')

  return (
    <div className="conn">
      <div className="conn-head">
        <div className="conn-icon">
          <Webhook size={18} />
        </div>
        <div className="grow">
          <h3>API &amp; custom sources</h3>
          <span className="small muted">Automations, error trackers, and other agents</span>
        </div>
        <Tag tone="green">Enabled</Tag>
      </div>
      <span className="muted" style={{ fontSize: 12 }}>
        Create actionables with a title, custom source, context, and optional source links.
      </span>
      <div className="endpoint">
        <Tag tone="blue">POST</Tag>
        <span className="mono grow truncate selectable" title={endpoint}>
          {path || '/v1/actionables'}
        </span>
        <button className="icon-btn" aria-label="Copy endpoint" onClick={() => copy(endpoint)}>
          <Copy size={13} />
        </button>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <span className="small muted">Tokens</span>
        {active.length === 0 && <span className="small faint">No API tokens yet.</span>}
        {active.map((t) => (
          <div key={t.id} className="row small">
            <KeyRound size={12} className="muted" />
            <span>{t.name}</span>
            <span className="faint">· last used {ago(t.lastUsedAt)}</span>
            <span className="mono" style={{ marginLeft: 'auto' }}>
              {t.prefix}••••••••{t.lastFour}
            </span>
            <button
              className="btn sm danger"
              onClick={async () => {
                if (await app.confirm(`Revoke “${t.name}”?`, 'Requests using this token will be rejected immediately.', 'Revoke token')) {
                  await app.run(api.connections.revokeApiToken(t.id))
                  await load()
                }
              }}
            >
              Revoke
            </button>
          </div>
        ))}
      </div>
      <div className="row wrap">
        <button className="btn" onClick={create}>
          <KeyRound size={13} /> Create API token
        </button>
        <button
          className="btn"
          onClick={async () => {
            await app.run(api.connections.sendTestActionable())
            app.toast('Test actionable sent — it will appear in To-do')
          }}
        >
          <Send size={13} /> Send test actionable
        </button>
        <button className="btn" onClick={() => setDocs(!docs)}>
          <ExternalLink size={13} /> API docs
        </button>
      </div>
      {docs && (
        <pre className="box mono selectable" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          {`curl -X POST ${endpoint} \\
  -H "Authorization: Bearer $GANTRY_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Fix checkout timeout after payment retry",
    "body": "markdown",
    "source": { "name": "Honeybadger", "icon": "bug" },
    "external_id": "hb-4821",
    "links": [{ "label": "Honeybadger event #4821", "url": "https://…" }],
    "repository": "acme/storefront",
    "priority": "high",
    "auto_start": false
  }'
→ { "id": "…", "url": "gantry://actionable/<id>" }
Also: PATCH /v1/actionables/:id · POST /v1/actionables/:id/dismiss`}
        </pre>
      )}
      {created && (
        <Modal
          title="API token created"
          subtitle="Copy it now. For your security it won't be shown again."
          onClose={() => setCreated(undefined)}
          footer={
            <>
              <button className="btn" onClick={() => copy(created.token)}>
                <Copy size={13} /> Copy token
              </button>
              <button className="btn primary" onClick={() => setCreated(undefined)}>
                Done
              </button>
            </>
          }
        >
          <div className="endpoint mono selectable" style={{ wordBreak: 'break-all' }}>
            {created.token}
          </div>
        </Modal>
      )}
    </div>
  )
}
