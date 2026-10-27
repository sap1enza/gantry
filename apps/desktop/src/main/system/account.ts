import { WorkerClient, WorkerError, type Account, type WorkerCredentials } from '@gantry/shared'
import type { KeyValueStore, SecretStore } from '../contracts'

type AccountRecord = Omit<Account, 'deviceId'>

const DEVICE_SECRET = 'device'

export class AccountService {
  private client?: WorkerClient

  constructor(
    private deps: { meta: KeyValueStore; secrets: SecretStore; workerUrl(): string; fetch?: typeof fetch },
  ) {}

  private record(): AccountRecord {
    return this.deps.meta.get<AccountRecord>('account') ?? { name: '', signedIn: false, onboarded: false }
  }

  private save(patch: Partial<AccountRecord>) {
    this.deps.meta.set('account', { ...this.record(), ...patch })
  }

  private credentials(): WorkerCredentials | undefined {
    const raw = this.deps.secrets.get(DEVICE_SECRET)
    return raw ? (JSON.parse(raw) as WorkerCredentials) : undefined
  }

  get(): Account {
    return { ...this.record(), deviceId: this.credentials()?.deviceId }
  }

  worker(): WorkerClient | undefined {
    const credentials = this.credentials()
    if (!credentials) return undefined
    if (this.client?.baseUrl !== this.deps.workerUrl()) this.client = new WorkerClient(this.deps.workerUrl(), credentials, this.deps.fetch)
    this.client.setCredentials(credentials)
    return this.client
  }

  async ensureDevice() {
    if (this.credentials()) return true
    const { name } = this.record()
    if (!name) return false
    try {
      const { deviceId, deviceSecret } = await new WorkerClient(this.deps.workerUrl(), undefined, this.deps.fetch).registerDevice(name)
      this.deps.secrets.set(DEVICE_SECRET, JSON.stringify({ deviceId, deviceSecret }))
      return true
    } catch {
      return false
    }
  }

  async setName(name: string) {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Name is required')
    this.save({ name: trimmed })
    if (await this.ensureDevice()) await this.worker()?.updateMe({ name: trimmed }).catch(() => undefined)
  }

  async refresh() {
    const me = await this.worker()
      ?.me()
      .catch(async (err: unknown) => {
        if (!(err instanceof WorkerError && err.status === 401)) return undefined
        this.deps.secrets.delete(DEVICE_SECRET)
        return (await this.ensureDevice()) ? this.worker()?.me().catch(() => undefined) : undefined
      })
    if (me) this.save({ signedIn: me.signedIn, email: me.email, githubLogin: me.githubLogin })
  }

  async signIn(method: 'github' | 'email', openExternal: (url: string) => Promise<void>, email?: string) {
    if (!this.record().name) throw new Error('Set your name first')
    if (!(await this.ensureDevice())) throw new Error('Gantry Worker is unreachable')
    const worker = this.worker()!
    if (method === 'github') return openExternal(await worker.oauthStartUrl('github_signin'))
    if (!email?.trim()) throw new Error('Email is required')
    await worker.startEmailSignIn(email.trim())
  }

  async completeAuth(code: string) {
    const worker = this.worker()
    if (!worker) throw new Error('Gantry Worker is unreachable')
    const result = await worker.completeAuth(code.trim()).catch((err: unknown) => {
      throw err instanceof WorkerError && err.status === 400 ? new Error('That code is invalid or expired') : err
    })
    if (result.kind === 'signin') await this.refresh()
    return result
  }

  // shortcut: sign-out is local only; the Worker has no sign-out route yet.
  signOut() {
    this.save({ signedIn: false, email: undefined, githubLogin: undefined, avatarUrl: undefined })
  }

  completeOnboarding() {
    this.save({ onboarded: true })
  }
}
