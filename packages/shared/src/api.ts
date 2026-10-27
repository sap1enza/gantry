import { z } from 'zod'
import { PRIORITIES } from './actionable'

const link = z.object({ label: z.string().min(1).max(200), url: z.url() })

export const createActionableSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(20_000).optional(),
  source: z.object({ name: z.string().min(1).max(80), icon: z.string().max(40).optional() }).optional(),
  external_id: z.string().min(1).max(200).optional(),
  links: z.array(link).max(20).optional(),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  instructions: z.string().max(20_000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  auto_start: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type CreateActionableRequest = z.infer<typeof createActionableSchema>

export const patchActionableSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    body: z.string().max(20_000).optional(),
    links: z.array(link).max(20).optional(),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, 'empty patch')
export type PatchActionableRequest = z.infer<typeof patchActionableSchema>

export interface CreateActionableResponse {
  id: string
  url: string
}

export type OAuthProvider = 'github' | 'slack' | 'google'

export type InboxPayload =
  | { kind: 'actionable.create'; id: string; tokenName: string; request: CreateActionableRequest }
  | { kind: 'actionable.update'; target: string; patch: PatchActionableRequest }
  | { kind: 'actionable.dismiss'; target: string }
  | { kind: 'github.webhook'; event: string; deliveryId: string; payload: unknown }
  | { kind: 'slack.event'; payload: unknown }
  | { kind: 'connection'; provider: OAuthProvider; status: 'connected' | 'reconnect_required' | 'disconnected'; account?: GrantAccount }

export interface InboxItem {
  id: string
  receivedAt: string
  payload: InboxPayload
}

export interface InboxResponse {
  items: InboxItem[]
}

export interface GrantAccount {
  id: string
  login: string
  name?: string
  avatarUrl?: string
  team?: string
}

export interface GrantTokenResponse {
  provider: OAuthProvider
  accessToken: string
  expiresAt?: string
  account: GrantAccount
  scopes: string[]
}

export interface DeviceRegistration {
  deviceId: string
  deviceSecret: string
  userId: string
}

export interface ApiTokenInfo {
  id: string
  name: string
  prefix: string
  lastFour: string
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

export interface CreatedApiToken extends ApiTokenInfo {
  token: string
}

export interface MeResponse {
  userId: string
  name: string
  email?: string
  githubLogin?: string
  signedIn: boolean
  grants: { provider: OAuthProvider; account: GrantAccount; status: 'connected' | 'reconnect_required' }[]
}
