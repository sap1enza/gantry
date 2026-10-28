import { CLAUDE_MODELS, PERMISSION_PRESETS, type Repository, type Settings, type WorkspaceCleanup } from '@gantry/shared'
import { ArrowUpRight, FolderCheck, Mail, Plus, Trash2 } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../app'
import { api } from '../bridge'
import { SHORTCUT_LIST } from '../lib/shortcuts'
import { SNOOZE_PRESETS } from '../lib/snooze'
import { Github, Modal, Popover, PRESET_LABEL, Select, Tag, Toggle, usePopover } from '../ui'
import { useBrowserAuth } from './connections'

export function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
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

export function Group({ title, sub, children, className = 'rows' }: { title: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <div className="group">
      <h2>{title}</h2>
      {sub ? <p className="section-sub">{sub}</p> : <div style={{ height: 12 }} />}
      <div className={className}>{children}</div>
    </div>
  )
}

export function PreferencesView() {
  const app = useApp()
  const s = app.settings
  const [deleting, setDeleting] = useState(false)
  const [email, setEmail] = useState('')
  const auth = useBrowserAuth()
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
              <AgentSettings />
            </Group>

            <Group title="When work is done" sub="Cleanup runs after an actionable is marked Done, not when an agent is paused.">
              <WorkspaceCleanupRow />
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
              <Row title="Manage connections and triggers" hint="GitHub access and triggers, and custom API sources.">
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

function BranchSelect({ repo, onChange }: { repo: Repository; onChange: () => void }) {
  const app = useApp()
  const pop = usePopover()
  const [branches, setBranches] = useState([repo.defaultBranch])
  const [query, setQuery] = useState('')
  useEffect(() => void api.repos.branches(repo.id).then((b) => b.length && setBranches(b)), [repo.id])
  const matches = branches.filter((b) => b.toLowerCase().includes(query.trim().toLowerCase()))
  const pick = async (defaultBranch: string) => {
    pop.close()
    setQuery('')
    await app.run(api.repos.update(repo.id, { defaultBranch }))
    onChange()
  }
  return (
    <>
      <button className="select branch-select" aria-label={`Base branch for ${repo.remote}`} onClick={(e) => pop.toggle(e.currentTarget)}>
        {repo.defaultBranch}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} align="right">
          <input className="field" autoFocus placeholder="Search branches" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && matches[0] && pick(matches[0])} />
          <div className="branch-list">
            {matches.map((b) => (
              <button key={b} className={`menu-item ${b === repo.defaultBranch ? 'active' : ''}`} onClick={() => pick(b)}>
                {b}
              </button>
            ))}
            {!matches.length && <div className="menu-label">No matching branches</div>}
          </div>
        </Popover>
      )}
    </>
  )
}

export function AgentSettings() {
  const app = useApp()
  const s = app.settings
  const [repos, setRepos] = useState<Repository[]>([])
  const loadRepos = useCallback(async () => setRepos(await api.repos.list()), [])
  useEffect(() => void loadRepos(), [loadRepos])
  if (!s) return null
  const set = (patch: Partial<Settings>) => app.updateSettings(patch)
  return (
    <>
      <Row title="Default agent" hint="Use an installed agent in an isolated workspace.">
        <Select label="Default agent" value={s.defaultProvider} options={[{ value: 'claude', label: 'Claude Code' }]} onChange={(v) => set({ defaultProvider: v })} />
        <Select
          label="Default model"
          value={s.defaultModel}
          options={CLAUDE_MODELS.map((m) => ({ value: m.id, label: m.label }))}
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
            <p>Local clones agents work in. New worktrees branch from the selected base branch, fetched from origin first. The setup command runs inside each new worktree; a non-zero exit fails the dispatch.</p>
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
              <div className="mono faint">{r.path}</div>
            </div>
            <BranchSelect repo={r} onChange={loadRepos} />
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
    </>
  )
}

export function WorkspaceCleanupRow() {
  const app = useApp()
  const s = app.settings
  if (!s) return null
  const set = (patch: Partial<Settings>) => app.updateSettings(patch)
  return (
    <>
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
    </>
  )
}
