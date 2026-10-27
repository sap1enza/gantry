import type { Actionable, ConnectionInfo, IngestSink, OAuthProvider, Settings, WorkerClient } from '@gantry/shared'

export interface SecretStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
  clear(): void
}

export interface KeyValueStore {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}

export interface IngestionDeps {
  sink: IngestSink
  kv: KeyValueStore
  getSettings(): Settings
  worker(): WorkerClient | undefined
  secrets: SecretStore
  openExternal(url: string): Promise<void>
  now?: () => Date
}

export interface Ingestion {
  start(): void
  stop(): void
  syncNow(): Promise<void>
  connections(): ConnectionInfo[]
  connect(provider: OAuthProvider): Promise<void>
  disconnect(provider: OAuthProvider): Promise<void>
  manageAccessUrl(provider: OAuthProvider): string
  githubRepositories(): Promise<{ fullName: string; selected: boolean }[]>
  fetchContext(actionable: Actionable): Promise<string | undefined>
  onConnectionsChanged(listener: () => void): () => void
}
