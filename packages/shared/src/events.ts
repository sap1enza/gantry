export const EVENT_TYPES = [
  'received',
  'dispatched',
  'agent_update',
  'paused',
  'resumed',
  'awaiting_input',
  'answered',
  'stopped',
  'completed',
  'failed',
  'done',
  'reopened',
  'dismissed',
  'snoozed',
  'unsnoozed',
  'moved',
  'resolved_externally',
  'connection',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const RECEIVED_OUTCOMES = [
  'created',
  'updated',
  'ignored:trigger-off',
  'ignored:filtered',
  'ignored:duplicate',
  'ignored:llm',
] as const
export type ReceivedOutcome = (typeof RECEIVED_OUTCOMES)[number]

export type ActorKind = 'user' | 'agent' | 'source' | 'gantry'

export interface ActivityEvent {
  id: string
  type: EventType
  actionableId?: string
  actionableDisplayId?: string
  source: string
  actor: { kind: ActorKind; name: string }
  title: string
  detail?: string
  outcome?: ReceivedOutcome
  data?: Record<string, unknown>
  createdAt: string
}

export interface ActivityQuery {
  types?: EventType[]
  sources?: string[]
  actionableId?: string
  text?: string
  since?: string
  until?: string
  cursor?: string
  limit?: number
}
