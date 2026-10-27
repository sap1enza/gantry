import type { ActionableSource, Link, Priority, SourceKind } from './actionable'
import type { ReceivedOutcome } from './events'
import type { TriggerId } from './triggers'

export interface IngestSignal {
  id?: string
  trigger: TriggerId
  source: ActionableSource
  externalKey: string
  title: string
  body?: string
  links?: Link[]
  repository?: string
  instructions?: string
  priority?: Priority
  tags?: string[]
  metadata?: Record<string, unknown>
  autoStart?: boolean
  aiDetected?: boolean
  receivedDetail?: string
  actor?: string
  occurredAt: string
}

export interface ResolveSignal {
  trigger: TriggerId
  externalKey: string
  reason: string
}

export interface IngestResult {
  outcome: ReceivedOutcome
  actionableId?: string
}

export interface ActionablePatch {
  title?: string
  body?: string
  links?: { label: string; url: string }[]
  tags?: string[]
}

export interface IngestSink {
  ingest(signal: IngestSignal): IngestResult
  logIgnored(signal: IngestSignal, outcome: Extract<ReceivedOutcome, `ignored:${string}`>, reason: string): void
  resolve(signal: ResolveSignal): void
  applyPatch(idOrExternal: string, patch: ActionablePatch): void
  dismiss(idOrExternal: string): Promise<void>
  logConnection(provider: string, status: string, detail?: string): void
  markSourceDisconnected(kind: SourceKind): void
  markSourceConnected(kind: SourceKind): void
}
