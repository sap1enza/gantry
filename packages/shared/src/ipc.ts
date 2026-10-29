import type { Actionable, Column, ColumnId, Link, PermissionPreset, Priority } from './actionable'
import type { ApiTokenInfo, ConnectionStatus, CreatedApiToken, OAuthProvider } from './api'
import type { ActivityEvent, ActivityQuery } from './events'
import type { AgentEvent } from './provider'
import type { Report } from './report'
import type { Settings } from './settings'
import type { TriggerId } from './triggers'

export const IPC_INVOKE = 'gantry:invoke'
export const IPC_EVENT = 'gantry:event'

export interface BoardStats {
  total: number
  running: number
  paused: number
  awaitingInput: number
  completedToday: number
  costTodayUsd: number
}

export interface BoardSnapshot {
  columns: Column[]
  actionables: Actionable[]
  stats: BoardStats
}

export interface BoardFilter {
  sources?: string[]
  providers?: string[]
  tags?: string[]
  showSnoozed?: boolean
  showDismissed?: boolean
  showArchived?: boolean
  today?: boolean
}

export interface CardEdit {
  title?: string
  body?: string
  priority?: Priority | null
  tags?: string[]
}

export interface ManualActionableInput {
  title: string
  body?: string
  sourceName?: string
  links?: Link[]
  repository?: string
  priority?: Priority
}

export interface DispatchPreview {
  instructions: string
  repository?: string
  repositoryCandidates: string[]
  provider: string
  model?: string
  models: { id: string; label: string }[]
  permissionPreset: PermissionPreset
  fullPresetAvailable: boolean
  mustConfirm: boolean
}

export interface DispatchOverrides {
  instructions?: string
  repository?: string
  model?: string
  permissionPreset?: PermissionPreset
}

export interface Repository {
  id: string
  path: string
  remote: string
  defaultBranch: string
  setupCommand?: string
}


export interface ConnectionInfo {
  provider: OAuthProvider | 'api'
  status: ConnectionStatus
  account?: { login: string; name?: string; team?: string; avatarUrl?: string }
  lastSyncAt?: string
  detail?: string
}

export interface Account {
  name: string
  signedIn: boolean
  email?: string
  githubLogin?: string
  avatarUrl?: string
  deviceId?: string
  onboarded: boolean
}

export interface SystemChecks {
  claude: { available: boolean; version?: string; reason?: string }
  gh: { authenticated: boolean; detail?: string }
  repositories: number
  workerReachable: boolean
}

export interface TranscriptEntry {
  at: string
  event: AgentEvent
}

export interface GantryApi {
  board: {
    snapshot(filter?: BoardFilter): Promise<BoardSnapshot>
    get(id: string): Promise<Actionable | undefined>
    search(query: string): Promise<Actionable[]>
    create(input: ManualActionableInput): Promise<Actionable>
    edit(id: string, patch: CardEdit): Promise<void>
    move(id: string, column: ColumnId, position: number): Promise<void>
    dispatchPreview(id: string): Promise<DispatchPreview>
    start(id: string, overrides?: DispatchOverrides): Promise<void>
    pause(id: string): Promise<void>
    resume(id: string, feedback?: string): Promise<void>
    stop(id: string): Promise<void>
    answer(id: string, questionId: string, text: string): Promise<void>
    dismiss(id: string): Promise<void>
    snooze(id: string, until: string): Promise<void>
    done(id: string, cleanup?: 'delete' | 'keep'): Promise<void>
    reopen(id: string, feedback?: string): Promise<void>
    openInTerminal(id: string): Promise<void>
    openLink(url: string): Promise<void>
    transcript(id: string): Promise<TranscriptEntry[]>
  }
  columns: {
    create(name: string, position: number): Promise<Column>
    rename(id: ColumnId, name: string): Promise<void>
    remove(id: ColumnId): Promise<void>
    move(id: ColumnId, position: number): Promise<void>
  }
  activity: {
    list(query: ActivityQuery): Promise<{ events: ActivityEvent[]; nextCursor?: string; totalToday: number }>
    export(format: 'json' | 'csv', query: ActivityQuery): Promise<string | undefined>
  }
  connections: {
    list(): Promise<ConnectionInfo[]>
    connect(provider: OAuthProvider): Promise<void>
    disconnect(provider: OAuthProvider): Promise<void>
    manageAccess(provider: OAuthProvider): Promise<void>
    syncNow(): Promise<void>
    githubRepositories(): Promise<{ fullName: string; selected: boolean }[]>
    apiTokens(): Promise<ApiTokenInfo[]>
    createApiToken(name: string): Promise<CreatedApiToken>
    revokeApiToken(id: string): Promise<void>
    sendTestActionable(): Promise<void>
    endpoint(): Promise<string>
  }
  reports: {
    list(showArchived?: boolean): Promise<Report[]>
    markRead(id: string): Promise<void>
    archive(id: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
    setTrigger(trigger: TriggerId, enabled: boolean): Promise<void>
    chooseWorkspaceLocation(): Promise<string | undefined>
  }
  repos: {
    list(): Promise<Repository[]>
    add(): Promise<Repository | undefined>
    update(id: string, patch: { setupCommand?: string; defaultBranch?: string }): Promise<void>
    branches(id: string): Promise<string[]>
    remove(id: string): Promise<void>
  }
  account: {
    get(): Promise<Account>
    setName(name: string): Promise<void>
    signIn(method: 'github' | 'email', email?: string): Promise<void>
    completeAuth(code: string): Promise<void>
    signOut(): Promise<void>
    completeOnboarding(): Promise<void>
  }
  system: {
    checks(): Promise<SystemChecks>
    deleteAllData(): Promise<void>
    openExternal(url: string): Promise<void>
  }
}

export type GantryPush =
  | { type: 'board.changed' }
  | { type: 'activity.appended'; event: ActivityEvent }
  | { type: 'agent.event'; actionableId: string; event: AgentEvent }
  | { type: 'connections.changed' }
  | { type: 'settings.changed' }
  | { type: 'reports.changed' }
  | { type: 'navigate'; view: 'triage' | 'reports' | 'activity' | 'connections' | 'preferences'; actionableId?: string }

export interface GantryTransport {
  invoke(path: string, args: unknown[]): Promise<unknown>
  onPush(listener: (push: GantryPush) => void): () => void
}

export interface GantryBridge {
  api: GantryApi
  onPush(listener: (push: GantryPush) => void): () => void
}
