import { PERMISSION_PRESETS, type LlmProvider, type Repository, type Settings, type WorkspaceCleanup } from '@gantry/shared'
import { ArrowUpRight, FolderCheck, Mail, Plus, Trash2 } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../app'
import { api } from '../bridge'
import { SHORTCUT_LIST } from '../lib/shortcuts'
import { SNOOZE_PRESETS } from '../lib/snooze'
import { Github, Modal, PRESET_LABEL, Select, Tag, Toggle } from '../ui'
import { useBrowserAuth } from './connections'

function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="pref-row">
      <div className="grow">
        <b>{title}</b>
        {hint && <p>{hint}</p>}
      </div>
      <div className="end">{children}</div>
    </div>
  )
}

function Group({ title, sub, children, className = 'rows' }: { title: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <div className="group">
      <h2>{title}</h2>
      {sub ? <p className="section-sub">{sub}</p> : <div style={{ height: 12 }} />}
      <div className={className}>{children}</div>
    </div>
  )
}

const LLM_DEFAULT_MODEL: Record<LlmProvider, string> = { anthropic: 'claude-haiku-5-5', openai: 'gpt-5-mini', openai_compatible: '' }

export function PreferencesView() {
  const app = useApp()
  const s = app.settings
  const [repos, setRepos] = useState<Repository[]>([])
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [email, setEmail] = useState('')
  const auth = useBrowserAuth()
  const loadRepos = useCallback(async () => setRepos(await api.repos.list()), [])
  useEffect(() => {
    void loadRepos()
    void api.settings.hasLlmKey().then(setHasKey)
  }, [loadRepos])
  if (!s) return null
  const set = (patch: Partial<Settings>) => app.updateSettings(patch)
  const acc = app.account

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Preferences</h1>
          <p>Your workspace, agent defaults, and local data.</p>
        </div>
      </div>
      <div className="page-body">
        <div className="prefs">
          <div>
            <Group title="Agent defaults" sub="Applied when you start an actionable. You can change these before dispatch.">
              <Row title="Default agent" hint="Use an installed agent in an isolated workspace.">
                <Select label="Default agent" value={s.defaultProvider} options={[{ value: 'claude', label: 'Claude Code' }]} onChange={(v) => set({ defaultProvider: v })} />
                <Select
                  label="Default model"
                  value={s.defaultModel ?? 'sonnet'}
                  options={[
                    { value: 'sonnet', label: 'Sonnet' },
                    { value: 'opus', label: 'Opus' },
                    { value: 'haiku', label: 'Haiku' },
                  ]}
                  onChange={(v) => set({ defaultModel: v })}
                />
              </Row>
              <Row title="Workspace location" hint="Each actionable gets its own repository worktree.">
                <span className="mono muted">{s.workspaceLocation}</span>
                <button
                  className="btn"
                  onClick={async () => {
                    const loc = await app.run(api.settings.chooseWorkspaceLocation())
                    if (loc) await set({ workspaceLocation: loc })
                  }}
                >
                  Choose…
                </button>
              </Row>
              <div className="pref-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div className="row">
                  <div className="grow">
                    <b>Registered repositories</b>
                    <p>Local clones agents work in. The setup command runs inside each new worktree; a non-zero exit fails the dispatch.</p>
                  </div>
                  <button
                    className="btn"
                    onClick={async () => {
                      await app.run(api.repos.add())
                      await Promise.all([loadRepos(), app.reloadChecks()])
                    }}
                  >
                    <Plus size={13} /> Add repository
                  </button>
                </div>
                {repos.map((r) => (
                  <div key={r.id} className="row" style={{ gap: 10 }}>
                    <div style={{ width: 210 }}>
                      <div style={{ fontWeight: 600 }}>{r.remote}</div>
                      <div className="mono faint">
                        {r.path} · {r.defaultBranch}
                      </div>
                    </div>
                    <input
                      className="field grow mono"
                      placeholder="Setup command, e.g. cp ../../.env . && pnpm i"
                      defaultValue={r.setupCommand ?? ''}
                      aria-label={`Setup command for ${r.remote}`}
                      onBlur={(e) => e.target.value !== (r.setupCommand ?? '') && app.run(api.repos.update(r.id, { setupCommand: e.target.value }))}
                    />
                    <button
                      className="icon-btn"
                      aria-label={`Remove ${r.remote}`}
                      onClick={async () => {
                        if (!(await app.confirm(`Remove ${r.remote}?`, 'The local clone is not touched.', 'Remove'))) return
                        await app.run(api.repos.remove(r.id))
                        await Promise.all([loadRepos(), app.reloadChecks()])
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                {!repos.length && <span className="small faint">No repositories registered yet.</span>}
              </div>
              <Row title="Default permissions" hint={s.defaultPermissionPreset === 'full' ? 'Full requires `gh auth status` to pass.' : 'Full may push a branch and open a PR.'}>
                <Select label="Default permissions" value={s.defaultPermissionPreset} options={PERMISSION_PRESETS.map((p) => ({ value: p, label: PRESET_LABEL[p] }))} onChange={(v) => set({ defaultPermissionPreset: v })} />
              </Row>
              <Row title="Confirm before dispatching" hint="Review the instructions, repository, and permissions before an agent starts.">
                <Toggle label="Confirm before dispatching" checked={s.confirmBeforeDispatch} onChange={(v) => set({ confirmBeforeDispatch: v })} />
              </Row>
              <Row title="Max concurrent agents" hint="Extra dispatches wait in In Progress tagged Queued.">
                <input className="field" type="number" min={1} max={20} style={{ width: 64 }} aria-label="Max concurrent agents" value={s.maxConcurrentAgents} onChange={(e) => Number(e.target.value) >= 1 && set({ maxConcurrentAgents: Number(e.target.value) })} />
              </Row>
            </Group>

            <Group title="When work is done" sub="Cleanup runs after an actionable is marked Done, not when an agent is paused.">
              <Row title="Agent workspace" hint="Delete the local worktree after completion. Remote branches and pull requests are kept.">
                <Select<WorkspaceCleanup>
                  label="Agent workspace"
                  value={s.workspaceCleanup}
                  options={[
                    { value: 'delete', label: 'Delete agent workspace' },
                    { value: 'keep', label: 'Keep agent workspace' },
                    { value: 'ask', label: 'Ask each time' },
                  ]}
                  onChange={(v) => set({ workspaceCleanup: v })}
                />
              </Row>
              <Row title="Keep completed actionables" hint={s.keepCompleted ? 'Archived from Done after the set number of days; still searchable.' : 'Removed from the board on Done; still in Activity.'}>
                {s.keepCompleted && (
                  <>
                    <input className="field" type="number" min={1} style={{ width: 56 }} aria-label="Archive after days" value={s.archiveDoneAfterDays} onChange={(e) => Number(e.target.value) >= 1 && set({ archiveDoneAfterDays: Number(e.target.value) })} />
                    <span className="small muted">days</span>
                  </>
                )}
                <Toggle label="Keep completed actionables" checked={s.keepCompleted} onChange={(v) => set({ keepCompleted: v })} />
              </Row>
              <Row title="Confirm before stopping an agent" hint="Stopping ends execution; pausing preserves the current session.">
                <Toggle label="Confirm before stopping" checked={s.confirmBeforeStop} onChange={(v) => set({ confirmBeforeStop: v })} />
              </Row>
              <Row title="Snooze presets" hint="Available from every card’s Snooze menu, plus a custom date and time.">
                <span className="row wrap" style={{ gap: 4 }}>
                  {SNOOZE_PRESETS.map((p) => (
                    <Tag key={p.id}>{p.label}</Tag>
                  ))}
                  <Tag>Custom</Tag>
                </span>
              </Row>
            </Group>

            <Group title="AI" sub="Used to detect Slack replies owed, follow-ups, and emails that need action. Calls go directly from this Mac.">
              <Row title="Provider">
                <Select<LlmProvider>
                  label="AI provider"
                  value={s.llm.provider}
                  options={[
                    { value: 'anthropic', label: 'Anthropic' },
                    { value: 'openai', label: 'OpenAI' },
                    { value: 'openai_compatible', label: 'OpenAI-compatible URL' },
                  ]}
                  onChange={(v) => v !== s.llm.provider && set({ llm: { provider: v, model: LLM_DEFAULT_MODEL[v] } })}
                />
              </Row>
              <Row title="Model">
                <input className="field mono" style={{ width: 220 }} aria-label="Model id" required placeholder="model-id" defaultValue={s.llm.model} key={s.llm.model} onBlur={(e) => e.target.value.trim() && e.target.value !== s.llm.model && set({ llm: { ...s.llm, model: e.target.value.trim() } })} />
                {!s.llm.model && <Tag tone="amber">Required</Tag>}
              </Row>
              {s.llm.provider === 'openai_compatible' && (
                <Row title="Base URL">
                  <input className="field mono" style={{ width: 280 }} placeholder="https://llm.internal/v1" aria-label="Base URL" required type="url" defaultValue={s.llm.baseUrl ?? ''} onBlur={(e) => set({ llm: { ...s.llm, baseUrl: e.target.value.trim() || undefined } })} />
                  {!s.llm.baseUrl && <Tag tone="amber">Required</Tag>}
                </Row>
              )}
              <Row title="API key" hint="Stored in the macOS Keychain. It can be replaced, never read back.">
                <Tag tone={hasKey ? 'green' : 'amber'}>{hasKey ? 'Saved' : 'Not set'}</Tag>
                <input className="field" type="password" autoComplete="off" style={{ width: 200 }} placeholder={hasKey ? '••••••••••••' : 'Paste key'} aria-label="API key" value={key} onChange={(e) => setKey(e.target.value)} />
                <button
                  className="btn"
                  disabled={!key}
                  onClick={async () => {
                    await app.run(api.settings.setLlmKey(key))
                    setKey('')
                    setHasKey(await api.settings.hasLlmKey())
                    app.toast('API key saved to Keychain')
                  }}
                >
                  Save
                </button>
              </Row>
            </Group>

            <Group title="Notifications" sub="Clicking a notification opens the card.">
              {(
                [
                  ['needsInput', 'Agent needs input'],
                  ['completed', 'Agent completed'],
                  ['failed', 'Agent failed'],
                  ['newActionable', 'New actionable'],
                ] as const
              ).map(([k, label]) => (
                <Row key={k} title={label}>
                  <Toggle label={label} checked={s.notifications[k]} onChange={(v) => set({ notifications: { ...s.notifications, [k]: v } })} />
                </Row>
              ))}
            </Group>

            <Group title="Inputs & integrations">
              <Row title="Manage connections and triggers" hint="OAuth access, GitHub and Slack triggers, email, and custom API sources.">
                <button className="btn" onClick={() => app.go('connections')}>
                  <ArrowUpRight size={13} /> Open Connections
                </button>
              </Row>
            </Group>

            <Group title="Local data" className="rows danger-box">
                <Row
                  title="Delete all Gantry data"
                  hint={
                    <>
                      Permanently remove actionables, activity, agent workspaces, and saved connections from this Mac.
                      <br />
                      <span style={{ color: 'var(--red)', fontSize: 11 }}>Stops running agents and removes API tokens. This cannot be undone. You’ll be asked to confirm.</span>
                    </>
                  }
                >
                  <button className="btn danger" onClick={() => setDeleting(true)}>
                    <Trash2 size={13} /> Delete all data…
                  </button>
                </Row>
            </Group>
          </div>

          <div>
            <Group title="General">
                <Row title="Launch at login">
                  <Toggle label="Launch at login" checked={s.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} />
                </Row>
                <Row title="Dock badge" hint="Count of cards awaiting input.">
                  <Toggle label="Dock badge" checked={s.dockBadge} onChange={(v) => set({ dockBadge: v })} />
                </Row>
                <Row title="Appearance">
                  <Select
                    label="Appearance"
                    value={s.appearance}
                    options={[
                      { value: 'system', label: 'System' },
                      { value: 'light', label: 'Light' },
                      { value: 'dark', label: 'Dark' },
                    ]}
                    onChange={(v) => set({ appearance: v })}
                  />
                </Row>
                <Row title="Activity retention">
                  <input className="field" type="number" min={1} style={{ width: 64 }} aria-label="Activity retention days" value={s.activityRetentionDays} onChange={(e) => Number(e.target.value) >= 1 && set({ activityRetentionDays: Number(e.target.value) })} />
                  <span className="small muted">days</span>
                </Row>
            </Group>

            <div className="note group">
              <FolderCheck size={18} color="var(--accent)" />
              <b style={{ color: 'var(--text)', fontSize: 13 }}>Clean workspaces, kept context</b>
              <span>Deleting an agent workspace removes only the local working directory. Your source links, completion summary, and agent log remain available in Gantry.</span>
              <div className="divider" />
              <span className="small">Need to inspect a result locally? Choose “Keep agent workspace” in the completion setting.</span>
            </div>

            <Group title="Account">
                <Row title="Name">
                  <input className="field" style={{ width: 180 }} aria-label="Name" defaultValue={acc?.name} key={acc?.name} onBlur={async (e) => e.target.value.trim() && e.target.value !== acc?.name && (await app.run(api.account.setName(e.target.value.trim())), await app.reloadAccount())} />
                </Row>
                <Row title={acc?.signedIn ? 'Signed in' : 'Not signed in'} hint={acc?.signedIn ? (acc.githubLogin ? `GitHub · ${acc.githubLogin}` : acc.email) : 'Local account. Sign in to enable multi-device later.'}>
                  {acc?.signedIn ? (
                    <button
                      className="btn"
                      onClick={async () => {
                        await app.run(api.account.signOut())
                        await app.reloadAccount()
                      }}
                    >
                      Sign out
                    </button>
                  ) : (
                    <button
                      className="btn"
                      onClick={() => auth.start(api.account.signIn('github'))}
                    >
                      <Github size={13} /> GitHub
                    </button>
                  )}
                </Row>
                {!acc?.signedIn && (
                  <Row title="Sign in with email" hint="We’ll send a magic link.">
                    <input className="field" type="email" style={{ width: 170 }} placeholder="you@company.com" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <button
                      className="btn"
                      disabled={!/^\S+@\S+\.\S+$/.test(email)}
                      onClick={async () => (await auth.start(api.account.signIn('email', email))) && app.toast(`Magic link sent to ${email}`)}
                    >
                      <Mail size={13} /> Send
                    </button>
                  </Row>
                )}
                {auth.banner}
                <Row title="Device">
                  <span className="mono muted selectable">{acc?.deviceId ?? '—'}</span>
                </Row>
            </Group>

            <Group title="Keyboard shortcuts" className="shortcuts">
                {SHORTCUT_LIST.map(([k, label]) => (
                  <Fragment key={k}>
                    <kbd>{k}</kbd>
                    <span>{label}</span>
                  </Fragment>
                ))}
            </Group>

            <div className="col small muted" style={{ gap: 6 }}>
              <b style={{ color: 'var(--text)', fontSize: 12 }}>Gantry for macOS</b>
              <span>Version 0.1.0 · Personal workspace</span>
              <span>Settings are saved automatically on this Mac.</span>
            </div>
          </div>
        </div>
      </div>
      {deleting && <DeleteAllDialog onClose={() => setDeleting(false)} />}
    </>
  )
}

function DeleteAllDialog({ onClose }: { onClose: () => void }) {
  const app = useApp()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title="Delete all Gantry data?"
      subtitle="Stops all agents, removes Gantry-created worktrees, wipes local data and Keychain entries, and revokes OAuth grants and API tokens at the Worker. Remote branches and PRs are kept."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger solid"
            disabled={typed !== 'DELETE' || busy}
            onClick={async () => {
              setBusy(true)
              await app.run(api.system.deleteAllData())
              onClose()
              await app.reloadAccount()
              app.go('triage')
            }}
          >
            Delete everything
          </button>
        </>
      }
    >
      <label className="form-label">
        Type DELETE to confirm
        <input className="field" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
    </Modal>
  )
}
