import type { PermissionPreset } from './actionable'
import { DEFAULT_ENABLED_TRIGGERS, type TriggerId } from './triggers'

export type WorkspaceCleanup = 'delete' | 'keep' | 'ask'
export type Appearance = 'system' | 'light' | 'dark'

export interface CardFieldVisibility {
  source: boolean
  status: boolean
  agent: boolean
  receivedTime: boolean
  repository: boolean
  branch: boolean
  links: boolean
  priority: boolean
}

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
]

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type Severity = (typeof SEVERITIES)[number]

export interface Settings {
  workerUrl: string
  defaultProvider: string
  defaultModel: string
  workspaceLocation: string
  defaultPermissionPreset: PermissionPreset
  confirmBeforeDispatch: boolean
  confirmBeforeStop: boolean
  maxConcurrentAgents: number
  workspaceCleanup: WorkspaceCleanup
  keepCompleted: boolean
  archiveDoneAfterDays: number
  activityRetentionDays: number
  triggers: Record<TriggerId, boolean>
  github: { repositories: string[]; dependabotMinSeverity: Severity; codeScanningMinSeverity: Severity; issuesScope: 'assigned' | 'all' }
  notifications: { needsInput: boolean; completed: boolean; failed: boolean; newActionable: boolean }
  launchAtLogin: boolean
  appearance: Appearance
  dockBadge: boolean
  cardFields: CardFieldVisibility
}

export const DEFAULT_SETTINGS: Settings = {
  workerUrl: 'https://gantry-api.sapienzalucas.workers.dev',
  defaultProvider: 'claude',
  defaultModel: 'claude-sonnet-5-5',
  workspaceLocation: '~/Developer/Gantry',
  defaultPermissionPreset: 'edit_test',
  confirmBeforeDispatch: true,
  confirmBeforeStop: true,
  maxConcurrentAgents: 3,
  workspaceCleanup: 'delete',
  keepCompleted: true,
  archiveDoneAfterDays: 7,
  activityRetentionDays: 90,
  triggers: DEFAULT_ENABLED_TRIGGERS,
  github: { repositories: [], dependabotMinSeverity: 'high', codeScanningMinSeverity: 'high', issuesScope: 'assigned' },
  notifications: { needsInput: true, completed: true, failed: true, newActionable: false },
  launchAtLogin: false,
  appearance: 'system',
  dockBadge: true,
  cardFields: { source: true, status: true, agent: true, receivedTime: false, repository: false, branch: true, links: true, priority: false },
}
