import {
  actionsFor,
  isAgentActive,
  type Account,
  type Actionable,
  type BoardFilter,
  type BoardSnapshot,
  type CardAction,
  type ConnectionInfo,
  type DispatchPreview,
  type Settings,
  type SystemChecks,
} from '@gantry/shared'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, bridge } from './bridge'
import { shortcutFor } from './lib/shortcuts'
import { Modal } from './ui'

const VIEWS = ['triage', 'activity', 'connections', 'preferences'] as const
export type View = (typeof VIEWS)[number]

interface DialogAction {
  label: string
  value: string
  tone?: 'primary' | 'danger'
}
interface DialogRequest {
  title: string
  body?: ReactNode
  actions: DialogAction[]
  input?: { label: string; value?: string }
}

export interface AppState {
  view: View
  go(view: View, opts?: { activityCard?: string }): void
  activityCard?: string
  setActivityCard(id?: string): void
  snapshot?: BoardSnapshot
  filter: BoardFilter
  setFilter(f: BoardFilter): void
  sort: Sort
  setSort(s: Sort): void
  settings?: Settings
  updateSettings(patch: Partial<Settings>): Promise<void>
  account?: Account
  reloadAccount(): Promise<void>
  connections: ConnectionInfo[]
  checks?: SystemChecks
  reloadChecks(): Promise<void>
  selectedId?: string
  panelOpen: boolean
  open(id: string): void
  select(id?: string): void
  closePanel(): void
  act(action: CardAction, a: Actionable, anchor?: HTMLElement): Promise<void>
  reopenFor?: string
  setReopenFor(id?: string): void
  dispatchFor?: { card: Actionable; preview: DispatchPreview }
  setDispatchFor(v?: { card: Actionable; preview: DispatchPreview }): void
  snoozeFor?: { card: Actionable; anchor?: DOMRect }
  setSnoozeFor(v?: { card: Actionable; anchor?: DOMRect }): void
  newOpen: boolean
  setNewOpen(v: boolean): void
  searchOpen: boolean
  setSearchOpen(v: boolean): void
  showWelcome: boolean
  setShowWelcome(v: boolean): void
  ask(req: DialogRequest): Promise<string | undefined>
  confirm(title: string, body: ReactNode, label: string, danger?: boolean): Promise<boolean>
  promptText(title: string, label: string, value?: string): Promise<string | undefined>
  toast(message: string): void
  run<T>(p: Promise<T>): Promise<T | undefined>
}

const Ctx = createContext<AppState | null>(null)
export const useApp = () => useContext(Ctx)!

export function usePush<T extends Parameters<Parameters<typeof bridge.onPush>[0]>[0]['type']>(
  type: T,
  handler: (push: Extract<Parameters<Parameters<typeof bridge.onPush>[0]>[0], { type: T }>) => void,
) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => bridge.onPush((p) => p.type === type && ref.current(p as never)), [type])
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>(() => (VIEWS.find((v) => `#${v}` === location.hash) ?? 'triage'))
  const [activityCard, setActivityCard] = useState<string>()
  const [snapshot, setSnapshot] = useState<BoardSnapshot>()
  const [filter, setFilter] = useState<BoardFilter>({})
  const [sort, setSort] = useState<Sort>('manual')
  const [settings, setSettings] = useState<Settings>()
  const [account, setAccount] = useState<Account>()
  const [connections, setConnections] = useState<ConnectionInfo[]>([])
  const [checks, setChecks] = useState<SystemChecks>()
  const [selectedId, setSelectedId] = useState<string>()
  const [panelOpen, setPanelOpen] = useState(false)
  const [reopenFor, setReopenFor] = useState<string>()
  const [dispatchFor, setDispatchFor] = useState<AppState['dispatchFor']>()
  const [snoozeFor, setSnoozeFor] = useState<AppState['snoozeFor']>()
  const [newOpen, setNewOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
  const [dialog, setDialog] = useState<DialogRequest & { resolve: (v?: string) => void }>()
  const [toastMsg, setToastMsg] = useState<string>()
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const toast = useCallback((message: string) => {
    setToastMsg(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(undefined), 3200)
  }, [])
  const run = useCallback(
    async <T,>(p: Promise<T>) => {
      try {
        return await p
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e))
        return undefined
      }
    },
    [toast],
  )

  const filterRef = useRef(filter)
  filterRef.current = filter
  const snapshotLoad = useRef<{ running: boolean; again: boolean }>({ running: false, again: false })
  const reloadSnapshot = useCallback(async () => {
    const load = snapshotLoad.current
    if (load.running) return void (load.again = true)
    load.running = true
    do {
      load.again = false
      setSnapshot(await api.board.snapshot(filterRef.current))
    } while (load.again)
    load.running = false
  }, [])
  const reloadSettings = useCallback(() => api.settings.get().then(setSettings), [])
  const reloadAccount = useCallback(() => api.account.get().then(setAccount), [])
  const reloadConnections = useCallback(() => api.connections.list().then(setConnections), [])
  const reloadChecks = useCallback(() => api.system.checks().then(setChecks), [])

  useEffect(() => {
    void Promise.all([reloadSettings(), reloadAccount(), reloadConnections(), reloadChecks()])
  }, [reloadSettings, reloadAccount, reloadConnections, reloadChecks])
  useEffect(() => void reloadSnapshot(), [filter, reloadSnapshot])

  const go = useCallback((v: View, opts?: { activityCard?: string }) => {
    setView(v)
    if (v === 'activity') setActivityCard(opts?.activityCard)
  }, [])
  const open = useCallback((id: string) => {
    setView('triage')
    setSelectedId(id)
    setPanelOpen(true)
  }, [])

  useEffect(
    () =>
      bridge.onPush((p) => {
        if (p.type === 'board.changed') void reloadSnapshot()
        else if (p.type === 'connections.changed') void Promise.all([reloadConnections(), reloadChecks()])
        else if (p.type === 'settings.changed') void Promise.all([reloadSettings(), reloadAccount(), reloadChecks()])
        else if (p.type === 'navigate') {
          if (p.actionableId) open(p.actionableId)
          else go(p.view)
        }
      }),
    [reloadSnapshot, reloadConnections, reloadSettings, reloadAccount, reloadChecks, open, go],
  )

  useEffect(() => {
    const appearance = settings?.appearance ?? 'system'
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => (document.documentElement.dataset.theme = appearance === 'system' ? (media.matches ? 'dark' : 'light') : appearance)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings?.appearance])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await run(api.settings.update(patch))
    if (next) setSettings(next)
  }, [run])

  const ask = useCallback((req: DialogRequest) => new Promise<string | undefined>((resolve) => setDialog({ ...req, resolve })), [])
  const confirm = useCallback(
    async (title: string, body: ReactNode, label: string, danger = true) =>
      (await ask({ title, body, actions: [{ label: 'Cancel', value: '' }, { label, value: 'ok', tone: danger ? 'danger' : 'primary' }] })) === 'ok',
    [ask],
  )
  const inputRef = useRef('')
  const promptText = useCallback(
    async (title: string, label: string, value = '') => {
      inputRef.current = value
      const ok = await ask({ title, input: { label, value }, actions: [{ label: 'Cancel', value: '' }, { label: 'Save', value: 'ok', tone: 'primary' }] })
      return ok ? inputRef.current.trim() || undefined : undefined
    },
    [ask],
  )

  const actState = useRef({ settings, selectedId })
  actState.current = { settings, selectedId }
  const act = useCallback(
    async (action: CardAction, a: Actionable, anchor?: HTMLElement) => {
      const id = a.id
      const { settings, selectedId } = actState.current
      const confirmStop = settings?.confirmBeforeStop ?? true
      switch (action) {
        case 'start': {
          const preview = await run(api.board.dispatchPreview(id))
          if (!preview) return
          if (preview.mustConfirm) setDispatchFor({ card: a, preview })
          else await run(api.board.start(id))
          return
        }
        case 'pause':
          return void (await run(api.board.pause(id)))
        case 'resume':
          return void (await run(api.board.resume(id)))
        case 'stop':
          if (confirmStop && !(await confirm(`Stop ${a.displayId}?`, 'Stopping ends execution and returns the card to To-do. The workspace is kept; pausing preserves the session instead.', 'Stop agent'))) return
          return void (await run(api.board.stop(id)))
        case 'dismiss':
          if (isAgentActive(a) && confirmStop && !(await confirm(`Dismiss ${a.displayId}?`, 'The running agent will be stopped and the card archived.', 'Stop and dismiss'))) return
          await run(api.board.dismiss(id))
          if (selectedId === id) setPanelOpen(false)
          return
        case 'snooze':
          if (isAgentActive(a)) return toast('Pause or stop the agent before snoozing.')
          return setSnoozeFor({ card: a, anchor: anchor?.getBoundingClientRect() })
        case 'done': {
          let cleanup: 'delete' | 'keep' | undefined
          if (settings?.workspaceCleanup === 'ask' && a.dispatch) {
            const choice = await ask({
              title: `Mark ${a.displayId} done`,
              body: (
                <>
                  Delete the agent workspace at <code>{a.dispatch.worktreePath}</code>? Remote branches and pull requests are kept.
                </>
              ),
              actions: [
                { label: 'Cancel', value: '' },
                { label: 'Keep workspace', value: 'keep' },
                { label: 'Delete workspace', value: 'delete', tone: 'primary' },
              ],
            })
            if (!choice) return
            cleanup = choice as 'delete' | 'keep'
          }
          return void (await run(api.board.done(id, cleanup)))
        }
        case 'reopen':
          setReopenFor(id)
          return open(id)
        case 'open_terminal':
          return void (await run(api.board.openInTerminal(id)))
        case 'reopen_todo':
          return void (await run(api.board.move(id, 'todo', 0)))
      }
    },
    [run, confirm, ask, toast, open],
  )

  const overlayOpen = !!(dialog || dispatchFor || snoozeFor || newOpen || searchOpen)
  const keyState = useRef({ view, snapshot, sort, selectedId, panelOpen, overlayOpen, act })
  keyState.current = { view, snapshot, sort, selectedId, panelOpen, overlayOpen, act }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = shortcutFor(e)
      const k = keyState.current
      if (!s || (k.overlayOpen && s !== 'search')) return
      const cards = k.snapshot ? orderedCards(k.snapshot, k.sort) : []
      const card = cards.find((c) => c.id === k.selectedId)
      const can = (action: CardAction) => card && actionsFor(card).includes(action) && (e.preventDefault(), void k.act(action, card), true)
      switch (s) {
        case 'search':
          e.preventDefault()
          return setSearchOpen(true)
        case 'new':
          e.preventDefault()
          return setNewOpen(true)
        case 'triage':
        case 'activity':
        case 'connections':
          e.preventDefault()
          return go(s)
      }
      if (k.view !== 'triage') return
      switch (s) {
        case 'prev':
        case 'next': {
          if (!cards.length) return
          e.preventDefault()
          const i = cards.findIndex((c) => c.id === k.selectedId)
          const next = i < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, i + (s === 'next' ? 1 : -1)))
          return setSelectedId(cards[next]!.id)
        }
        case 'open':
          if (card) setPanelOpen(true)
          return
        case 'close':
          return setPanelOpen(false)
        case 'start':
          return void (can('start') || can('resume'))
        case 'pause':
          return void can('pause')
        case 'snooze':
          return void can('snooze')
        case 'dismiss':
          return void can('dismiss')
        case 'done':
          return void can('done')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  const value = useMemo<AppState>(
    () => ({
      view,
      go,
      activityCard,
      setActivityCard,
      snapshot,
      filter,
      setFilter,
      sort,
      setSort,
      settings,
      updateSettings,
      account,
      reloadAccount,
      connections,
      checks,
      reloadChecks,
      selectedId,
      panelOpen,
      open,
      select: setSelectedId,
      closePanel: () => setPanelOpen(false),
      act,
      reopenFor,
      setReopenFor,
      dispatchFor,
      setDispatchFor,
      snoozeFor,
      setSnoozeFor,
      newOpen,
      setNewOpen,
      searchOpen,
      setSearchOpen,
      showWelcome,
      setShowWelcome,
      ask,
      confirm,
      promptText,
      toast,
      run,
    }),
    [view, go, activityCard, snapshot, filter, sort, settings, updateSettings, account, reloadAccount, connections, checks, reloadChecks, selectedId, panelOpen, open, act, reopenFor, dispatchFor, snoozeFor, newOpen, searchOpen, showWelcome, ask, confirm, promptText, toast, run],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      {dialog && (
        <Modal
          title={dialog.title}
          onClose={() => (dialog.resolve(undefined), setDialog(undefined))}
          footer={dialog.actions.map((a) => (
            <button
              key={a.label}
              className={`btn ${a.tone === 'primary' ? 'primary' : a.tone === 'danger' ? 'danger solid' : ''}`}
              autoFocus={!dialog.input && a.tone !== undefined}
              onClick={() => (dialog.resolve(a.value || undefined), setDialog(undefined))}
            >
              {a.label}
            </button>
          ))}
        >
          {dialog.body && <div className="muted" style={{ fontSize: 12 }}>{dialog.body}</div>}
          {dialog.input && (
            <label className="form-label">
              {dialog.input.label}
              <input
                className="field"
                autoFocus
                defaultValue={dialog.input.value}
                onChange={(e) => (inputRef.current = e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (dialog.resolve('ok'), setDialog(undefined))}
              />
            </label>
          )}
        </Modal>
      )}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </Ctx.Provider>
  )
}

export type Sort = 'manual' | 'newest' | 'oldest' | 'priority' | 'source'
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const
const SORTERS: Record<Exclude<Sort, 'manual'>, (x: Actionable, y: Actionable) => number> = {
  newest: (x, y) => y.createdAt.localeCompare(x.createdAt),
  oldest: (x, y) => x.createdAt.localeCompare(y.createdAt),
  priority: (x, y) => (x.priority ? PRIORITY_RANK[x.priority] : 4) - (y.priority ? PRIORITY_RANK[y.priority] : 4),
  source: (x, y) => x.source.name.localeCompare(y.source.name),
}

export function columnCards(s: BoardSnapshot, column: string, sort: Sort) {
  const cards = s.actionables.filter((a) => a.column === column)
  if (column === 'in_progress') return cards
  return cards.sort(sort === 'manual' ? (x, y) => x.position - y.position : SORTERS[sort])
}

const orderedCards = (s: BoardSnapshot, sort: Sort) => s.columns.flatMap((c) => columnCards(s, c.id, sort))
