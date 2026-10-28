import type { PermissionPreset } from './actionable'
import { DEFAULT_ENABLED_TRIGGERS, type TriggerId } from './triggers'

export type LlmProvider = 'anthropic' | 'openai' | 'openai_compatible'
export const LLM_DEFAULT_MODELS: Record<LlmProvider, string> = { anthropic: 'claude-haiku-5-5', openai: 'gpt-5-mini', openai_compatible: '' }
export const GMAIL_CATEGORIES = ['promotions', 'social', 'updates', 'forums'] as const
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
  github: { repositories: string[]; dependabotMinSeverity: 'low' | 'medium' | 'high' | 'critical'; issuesScope: 'assigned' | 'all' }
  slack: { channelAllow: string[]; channelDeny: string[]; unrepliedAfterMinutes: number }
  email: {
    inboxOnly: boolean
    unreadOnly: boolean
    excludeCategories: string[]
    domainAllow: string[]
    domainDeny: string[]
    labels: string[]
    llmGate: boolean
  }
  llm: { provider: LlmProvider; model: string; baseUrl?: string }
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
  github: { repositories: [], dependabotMinSeverity: 'high', issuesScope: 'assigned' },
  slack: { channelAllow: [], channelDeny: [], unrepliedAfterMinutes: 30 },
  email: {
    inboxOnly: true,
    unreadOnly: true,
    excludeCategories: [...GMAIL_CATEGORIES],
    domainAllow: [],
    domainDeny: [],
    labels: [],
    llmGate: false,
  },
  llm: { provider: 'anthropic', model: LLM_DEFAULT_MODELS.anthropic },
  notifications: { needsInput: true, completed: true, failed: true, newActionable: false },
  launchAtLogin: false,
  appearance: 'system',
  dockBadge: true,
  cardFields: { source: true, status: true, agent: true, receivedTime: false, repository: false, branch: true, links: true, priority: false },
}
