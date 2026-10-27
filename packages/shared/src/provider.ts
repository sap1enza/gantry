import type { AgentResult, AgentState, PermissionPreset } from './actionable'

export interface DispatchRequest {
  actionableId: string
  dispatchId: string
  instructions: string
  repository: string
  worktreePath: string
  branch: string
  permissionPreset: PermissionPreset
  model?: string
  resumeSessionId?: string
}

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'state'; state: AgentState }
  | { type: 'message'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'question'; id: string; prompt: string; options?: string[] }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'result'; result: AgentResult }
  | { type: 'error'; message: string }
  | { type: 'raw'; payload: unknown }

export type AgentEventSink = (event: AgentEvent) => void

export interface ProviderDetection {
  available: boolean
  version?: string
  reason?: string
}

export interface AgentProvider {
  readonly id: string
  readonly displayName: string
  readonly models: { id: string; label: string }[]
  detect(): Promise<ProviderDetection>
  start(request: DispatchRequest, sink: AgentEventSink): Promise<void>
  pause(actionableId: string): Promise<void>
  resume(actionableId: string, feedback?: string): Promise<void>
  stop(actionableId: string): Promise<void>
  answer(actionableId: string, questionId: string, text: string): Promise<void>
  openInTerminal(actionableId: string, worktreePath: string, sessionId: string): Promise<void>
}
