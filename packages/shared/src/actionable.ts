export const SOURCE_KINDS = ['github', 'slack', 'email', 'api', 'manual'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export const FIXED_COLUMNS = ['todo', 'in_progress', 'review', 'done'] as const
export type FixedColumnId = (typeof FIXED_COLUMNS)[number]
export type ColumnId = FixedColumnId | (string & {})

export const AGENT_STATES = ['queued', 'running', 'paused', 'awaiting_input', 'completed', 'failed', 'stopped'] as const
export type AgentState = (typeof AGENT_STATES)[number]

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type Priority = (typeof PRIORITIES)[number]

export const PERMISSION_PRESETS = ['read_only', 'edit_test', 'full'] as const
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

export const TAGS = {
  resolvedExternally: 'Resolved externally',
  stopped: 'Stopped',
  failed: 'Failed',
  queued: 'Queued',
  snoozed: 'Snoozed',
  needsRepository: 'Needs repository',
  sourceDisconnected: 'Source disconnected',
  aiDetected: 'AI detected',
} as const

export interface Link {
  label: string
  url: string
}

export interface ActionableSource {
  kind: SourceKind
  name: string
  icon?: string
}

export interface Dispatch {
  id: string
  provider: string
  model?: string
  repository: string
  repositoryPath: string
  worktreePath: string
  branch: string
  permissionPreset: PermissionPreset
  instructions: string
  sessionId?: string
  startedAt: string
  startedBy: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface AgentResult {
  summary: string
  filesChanged: string[]
  branch?: string
  prUrl?: string
  testsRun?: string
  openQuestions: string[]
}

export interface PendingQuestion {
  id: string
  prompt: string
  options?: string[]
}

export interface Actionable {
  id: string
  displayId: string
  title: string
  body?: string
  source: ActionableSource
  externalKey?: string
  triggers: string[]
  links: Link[]
  repository?: string
  instructions?: string
  priority?: Priority
  tags: string[]
  metadata: Record<string, unknown>
  column: ColumnId
  position: number
  agentState?: AgentState
  pendingQuestion?: PendingQuestion
  snoozedUntil?: string
  dismissedAt?: string
  archivedAt?: string
  doneAt?: string
  dispatch?: Dispatch
  result?: AgentResult
  error?: string
  createdAt: string
  updatedAt: string
}

export interface Column {
  id: ColumnId
  name: string
  kind: 'fixed' | 'custom'
  position: number
}
