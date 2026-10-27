import type {
  ApiTokenInfo,
  AuthCompletion,
  CreateActionableResponse,
  CreatedApiToken,
  DeviceRegistration,
  GrantTokenResponse,
  InboxResponse,
  MeResponse,
  OAuthProvider,
} from './api'

export class WorkerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

export interface WorkerCredentials {
  deviceId: string
  deviceSecret: string
}

export class WorkerClient {
  constructor(
    readonly baseUrl: string,
    private credentials?: WorkerCredentials,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  setCredentials(credentials: WorkerCredentials | undefined) {
    this.credentials = credentials
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.credentials) headers.authorization = `Device ${this.credentials.deviceId}:${this.credentials.deviceSecret}`
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const retry = res.headers.get('retry-after')
      throw new WorkerError(res.status, await res.text(), retry ? Number(retry) : undefined)
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  registerDevice(name: string) {
    return this.request<DeviceRegistration>('POST', '/v1/devices', { name })
  }
  me() {
    return this.request<MeResponse>('GET', '/v1/me')
  }
  updateMe(patch: { name?: string }) {
    return this.request<MeResponse>('PATCH', '/v1/me', patch)
  }
  deleteMe() {
    return this.request<void>('DELETE', '/v1/me')
  }
  inbox(limit = 100) {
    return this.request<InboxResponse>('GET', `/v1/inbox?limit=${limit}`)
  }
  ack(ids: string[]) {
    return this.request<void>('POST', '/v1/inbox/ack', { ids })
  }
  refreshGrant(provider: OAuthProvider, options: { force?: boolean } = {}) {
    return this.request<GrantTokenResponse>('POST', `/v1/grants/${provider}/refresh${options.force ? '?force=1' : ''}`)
  }
  completeAuth(code: string) {
    return this.request<AuthCompletion>('POST', '/auth/complete', { code })
  }
  revokeGrant(provider: OAuthProvider) {
    return this.request<void>('DELETE', `/v1/grants/${provider}`)
  }
  listApiTokens() {
    return this.request<ApiTokenInfo[]>('GET', '/v1/tokens')
  }
  createApiToken(name: string) {
    return this.request<CreatedApiToken>('POST', '/v1/tokens', { name })
  }
  revokeApiToken(id: string) {
    return this.request<void>('DELETE', `/v1/tokens/${id}`)
  }
  sendTestActionable() {
    return this.request<CreateActionableResponse>('POST', '/v1/test-actionable')
  }
  startEmailSignIn(email: string) {
    return this.request<void>('POST', '/auth/email', { email })
  }
  async oauthStartUrl(provider: OAuthProvider | 'github_signin') {
    const { url } = await this.request<{ url: string }>('POST', `/oauth/${provider}/start`)
    return url
  }
}
