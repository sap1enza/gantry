import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  IPC_EVENT,
  IPC_INVOKE,
  resolveApiMethod,
  type ActivityEvent,
  type AgentProvider,
  type GantryPush,
  type Settings,
} from '@gantry/shared'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, shell } from 'electron'
import { AgentRunner } from './agents/runner'
import { createApi } from './api'
import type { Ingestion } from './contracts'
import { openDb } from './db'
import { createRepositoryStore, createSecretStore, createSettingsStore, jsonTable } from './db/stores'
import { Board } from './domain/board'
import { createIngestion } from './ingestion'
import { createClaudeProvider } from './providers/claude'
import { AccountService } from './system/account'
import { parseDeepLink, PROTOCOL, type DeepLink } from './system/deeplink'
import { exec, shellCommand } from './system/exec'
import { loginItemSync } from './system/login-item'
import { notificationFor } from './system/notifications'

const MINUTE_MS = 60_000

app.setPath('userData', process.env.GANTRY_USER_DATA ?? join(app.getPath('appData'), 'Gantry'))

let window: BrowserWindow | undefined
const linkFromArgv = (argv: string[]) => parseDeepLink(argv.find((a) => a.startsWith(`${PROTOCOL}://`)) ?? '')
let pendingCard: string | undefined
let resolveCard = (target: string) => target
let readyForAuth = (_complete: (code: string) => void) => {}
const authReady = new Promise<(code: string) => void>((resolve) => (readyForAuth = resolve))

function openLink(link: DeepLink | undefined) {
  if (link?.kind === 'actionable') navigateTo(link.id)
  else if (link?.kind === 'authComplete') void authReady.then((complete) => complete(link.code))
}
openLink(linkFromArgv(process.argv))

function navigateTo(target: string | undefined) {
  if (!target) return
  if (!window || window.webContents.isLoading()) {
    pendingCard = target
    if (!window && app.isReady()) createWindow()
    return
  }
  window.show()
  window.focus()
  const push: GantryPush = { type: 'navigate', view: 'triage', actionableId: resolveCard(target) }
  window.webContents.send(IPC_EVENT, push)
}

function createWindow() {
  window = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 16 },
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), sandbox: false, contextIsolation: true },
  })
  window.on('closed', () => (window = undefined))
  window.webContents.on('did-finish-load', () => {
    const card = pendingCard
    pendingCard = undefined
    navigateTo(card)
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

function importLoginShellPath() {
  try {
    process.env.PATH = execFileSync(...shellCommand('printf %s "$PATH"'), { encoding: 'utf8', timeout: 5000 })
  } catch (err) {
    console.error('could not read login shell PATH', err)
  }
}

function main() {
  importLoginShellPath()
  const dbPath = join(app.getPath('userData'), 'gantry.db')
  const db = openDb(dbPath)
  const meta = jsonTable(db, 'meta')
  const secrets = createSecretStore(db, {
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data)),
  })
  const settings = createSettingsStore(db)
  const repos = createRepositoryStore(db)

  let badgeQueued = false
  const updateBadge = () => {
    if (badgeQueued) return
    badgeQueued = true
    setImmediate(() => {
      badgeQueued = false
      const n = settings.get().dockBadge ? board.awaitingInputCount() : 0
      app.dock?.setBadge(n ? String(n) : '')
    })
  }
  const notify = (event: ActivityEvent) => {
    const content = notificationFor(event, settings.get())
    if (!content || !Notification.isSupported()) return
    const note = new Notification(content)
    note.on('click', () => navigateTo(event.actionableId))
    note.show()
  }
  const push = (p: GantryPush) => {
    window?.webContents.send(IPC_EVENT, p)
    if (p.type === 'board.changed') updateBadge()
    if (p.type === 'activity.appended') notify(p.event)
  }
  const syncLoginItem = loginItemSync((openAtLogin) => app.setLoginItemSettings({ openAtLogin }))
  const applySettings = (s: Settings) => {
    syncLoginItem(s.launchAtLogin)
    nativeTheme.themeSource = s.appearance
    updateBadge()
  }

  const board = new Board({ db, meta, settings: () => settings.get(), repositories: () => repos.list(), push })
  resolveCard = (target) => board.resolveTarget(target)?.id ?? target
  const account = new AccountService({ meta, secrets, workerUrl: () => settings.get().workerUrl })

  const providers = new Map<string, AgentProvider>()
  try {
    const claude = createClaudeProvider()
    providers.set(claude.id, claude)
  } catch (err) {
    console.error('Claude provider unavailable; running without agents', err)
  }

  let ingestion: Ingestion | undefined
  try {
    ingestion = createIngestion({
      sink: board,
      kv: jsonTable(db, 'kv'),
      getSettings: () => settings.get(),
      worker: () => account.worker(),
      secrets,
      openExternal: (url) => shell.openExternal(url),
    })
    ingestion.onConnectionsChanged(() => push({ type: 'connections.changed' }))
  } catch (err) {
    console.error('Ingestion unavailable; running without integrations', err)
  }

  const runner = new AgentRunner({
    board,
    providers,
    exec,
    exists: existsSync,
    settings: () => settings.get(),
    repositories: () => repos.list(),
    fetchContext: async (a) => ingestion?.fetchContext(a),
  })
  board.agents = runner

  const api = createApi({
    board,
    runner,
    account,
    settings,
    repos,
    secrets,
    ingestion,
    providers,
    exec,
    push,
    onSettingsChanged: applySettings,
    platform: {
      openExternal: (url) => shell.openExternal(url),
      async chooseDirectory(title) {
        const options = { title, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
        return result.canceled ? undefined : result.filePaths[0]
      },
      async saveFile(name) {
        const options = { defaultPath: join(app.getPath('downloads'), name) }
        const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
        return result.canceled ? undefined : result.filePath
      },
      wipe() {
        db.close()
        for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
      },
      relaunch() {
        app.relaunch()
        app.exit(0)
      },
    },
  })

  ipcMain.handle(IPC_INVOKE, (event, path: string, args: unknown[]) => {
    if (!window || event.sender !== window.webContents) throw new Error('Unknown IPC sender')
    const method = resolveApiMethod(api, path)
    if (!method) throw new Error(`Unknown API method ${path}`)
    return method(...(Array.isArray(args) ? args : []))
  })

  readyForAuth((code) => {
    if (window) window.show()
    else createWindow()
    api.account
      .completeAuth(code)
      .then(() => ingestion?.syncNow())
      .catch((err: Error) => dialog.showErrorBox('Could not finish connecting', err.message))
  })

  const syncAccount = () => void account.ensureDevice().then((ok) => (ok ? account.refresh() : undefined))
  syncAccount()
  setInterval(syncAccount, MINUTE_MS)
  board.housekeeping()
  setInterval(() => board.housekeeping(), MINUTE_MS)
  applySettings(settings.get())
  runner.recover()
  try {
    ingestion?.start()
  } catch (err) {
    console.error('ingestion failed to start', err)
  }
  app.on('before-quit', () => ingestion?.stop())

  createWindow()
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.setAsDefaultProtocolClient(PROTOCOL)
  app.on('open-url', (event, url) => {
    event.preventDefault()
    openLink(parseDeepLink(url))
  })
  app.on('second-instance', (_, argv) => {
    const link = linkFromArgv(argv)
    if (link) openLink(link)
    else window?.show()
  })
  app.on('activate', () => {
    if (!window && app.isReady()) createWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  void app.whenReady().then(main)
}
