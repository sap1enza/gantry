import { writeFile } from 'node:fs/promises'
import {
  SECRET_KEYS,
  type ActivityEvent,
  type AgentProvider,
  type GantryApi,
  type GantryPush,
  type Settings,
} from '@gantry/shared'
import type { AgentRunner } from './agents/runner'
import type { Ingestion, SecretStore } from './contracts'
import type { RepositoryStore, SettingsStore } from './db/stores'
import { type Board, USER } from './domain/board'
import { parseRemote } from './domain/repositories'
import type { AccountService } from './system/account'
import type { Exec } from './system/exec'

export interface Platform {
  openExternal(url: string): Promise<void>
  chooseDirectory(title: string): Promise<string | undefined>
  saveFile(defaultName: string): Promise<string | undefined>
  wipe(): void
  alert(message: string, detail: string): Promise<void>
  relaunch(): void
}

export interface ApiDeps {
  board: Board
  runner: AgentRunner
  account: AccountService
  settings: SettingsStore
  repos: RepositoryStore
  secrets: SecretStore
  ingestion?: Ingestion
  providers: Map<string, AgentProvider>
  exec: Exec
  platform: Platform
  push(push: GantryPush): void
  onSettingsChanged(settings: Settings): void
  fetch?: typeof fetch
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const CSV_FIELDS = ['createdAt', 'type', 'outcome', 'actionableDisplayId', 'source', 'actor', 'title', 'detail'] as const

export function toCsv(events: ActivityEvent[]) {
  const cell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`
  const rows = events.map((e) => CSV_FIELDS.map((f) => cell(f === 'actor' ? e.actor.name : e[f])).join(','))
  return [CSV_FIELDS.join(','), ...rows].join('\n')
}

export function createApi(deps: ApiDeps): GantryApi {
  const { board, runner, account, settings, repos, platform } = deps
  const fetchImpl = deps.fetch ?? fetch

  const openExternal = async (url: string) => {
    if (!EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) throw new Error(`Refusing to open ${url}`)
    await platform.openExternal(url)
  }
  const ingestion = () => {
    if (!deps.ingestion) throw new Error('Integrations are unavailable')
    return deps.ingestion
  }
  const worker = () => {
    const client = account.worker()
    if (!client) throw new Error('This device is not registered with the Gantry Worker yet')
    return client
  }
  const git = (path: string, ...args: string[]) => deps.exec('git', ['-C', path, ...args])
  const updateSettings = (patch: Partial<Settings>) => {
    const next = settings.update(patch)
    deps.onSettingsChanged(next)
    deps.push({ type: 'settings.changed' })
    return next
  }

  return {
    board: {
      snapshot: async (filter) => board.snapshot(filter),
      get: async (id) => board.resolveTarget(id),
      search: async (query) => board.search(query),
      create: async (input) => board.create(input),
      move: (id, column, position) => runner.move(id, column, position),
      dispatchPreview: (id) => runner.preview(id),
      start: (id, overrides) => runner.start(id, overrides),
      pause: (id) => runner.pause(id),
      resume: (id, feedback) => runner.resume(id, feedback),
      stop: (id) => runner.stop(id),
      answer: (id, questionId, text) => runner.answer(id, questionId, text),
      dismiss: (id) => board.dismissCard(id, USER),
      snooze: async (id, until) => board.snooze(id, until),
      done: (id, cleanup) => runner.done(id, cleanup),
      reopen: (id, feedback) => runner.reopen(id, feedback),
      openInTerminal: (id) => runner.openInTerminal(id),
      openLink: openExternal,
      transcript: async (id) => board.transcript(id),
    },
    columns: {
      create: async (name, position) => board.createColumn(name, position),
      rename: async (id, name) => board.renameColumn(id, name),
      remove: async (id) => board.removeColumn(id),
      move: async (id, position) => board.moveColumn(id, position),
    },
    activity: {
      list: async (query) => board.events(query),
      async export(format, query) {
        const path = await platform.saveFile(`gantry-activity.${format}`)
        if (!path) return undefined
        const { events } = board.events({ ...query, cursor: undefined, limit: Number.MAX_SAFE_INTEGER })
        await writeFile(path, format === 'json' ? JSON.stringify(events, null, 2) : toCsv(events))
        return path
      },
    },
    connections: {
      list: async () => deps.ingestion?.connections() ?? [],
      connect: (provider) => ingestion().connect(provider),
      async disconnect(provider) {
        await ingestion().disconnect(provider)
        board.markSourceDisconnected(provider === 'google' ? 'email' : provider)
      },
      async manageAccess(provider) {
        const url = ingestion().manageAccessUrl(provider)
        if (url) await openExternal(url)
      },
      syncNow: () => ingestion().syncNow(),
      githubRepositories: () => ingestion().githubRepositories(),
      apiTokens: () => worker().listApiTokens(),
      createApiToken: (name) => worker().createApiToken(name),
      revokeApiToken: (id) => worker().revokeApiToken(id),
      async sendTestActionable() {
        await worker().sendTestActionable()
        await deps.ingestion?.syncNow().catch(() => undefined)
      },
      endpoint: async () => new URL('/v1/actionables', settings.get().workerUrl).toString(),
    },
    settings: {
      get: async () => settings.get(),
      update: async (patch) => updateSettings(patch),
      async setTrigger(trigger, enabled) {
        updateSettings({ triggers: { [trigger]: enabled } as Settings['triggers'] })
      },
      setLlmKey: async (key) => (key.trim() ? deps.secrets.set(SECRET_KEYS.llmApiKey, key.trim()) : deps.secrets.delete(SECRET_KEYS.llmApiKey)),
      hasLlmKey: async () => !!deps.secrets.get(SECRET_KEYS.llmApiKey),
      async chooseWorkspaceLocation() {
        const path = await platform.chooseDirectory('Choose workspace location')
        if (path) updateSettings({ workspaceLocation: path })
        return path
      },
    },
    repos: {
      list: async () => repos.list(),
      async add() {
        const picked = await platform.chooseDirectory('Choose a git repository')
        if (!picked) return undefined
        const top = await git(picked, 'rev-parse', '--show-toplevel')
        if (top.code !== 0) throw new Error('Not a git repository')
        const path = top.output.trim()
        const origin = await git(path, 'remote', 'get-url', 'origin')
        const remote = origin.code === 0 ? parseRemote(origin.output) : undefined
        if (!remote) throw new Error('Repository has no origin remote')
        const head = await git(path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
        const defaultBranch =
          head.code === 0 ? head.output.trim().replace(/^origin\//, '') : (await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).output.trim()
        const repo = repos.add({ path, remote, defaultBranch })
        board.repositoryRegistered()
        return repo
      },
      update: async (id, patch) => repos.setSetupCommand(id, patch.setupCommand),
      remove: async (id) => repos.remove(id),
    },
    account: {
      get: async () => account.get(),
      setName: (name) => account.setName(name),
      signIn: (method, email) => account.signIn(method, openExternal, email),
      async completeAuth(code) {
        await account.completeAuth(code)
        deps.push({ type: 'connections.changed' })
      },
      signOut: async () => account.signOut(),
      completeOnboarding: async () => account.completeOnboarding(),
    },
    system: {
      async checks() {
        const provider = deps.providers.get('claude')
        const [claude, gh, workerReachable] = await Promise.all([
          provider
            ? provider.detect().catch((err: Error) => ({ available: false, reason: err.message }))
            : Promise.resolve({ available: false, reason: 'Claude provider failed to load' }),
          deps.exec('gh', ['auth', 'status']),
          fetchImpl(new URL('/health', settings.get().workerUrl), { signal: AbortSignal.timeout(3000) }).then(
            (r) => r.ok,
            () => false,
          ),
        ])
        return {
          claude,
          gh: { authenticated: gh.code === 0, detail: gh.output.trim().split('\n')[0] },
          repositories: repos.list().length,
          workerReachable,
        }
      },
      async deleteAllData() {
        deps.ingestion?.stop()
        await runner.stopAll()
        await runner.removeAllWorktrees()
        const remoteError = await account
          .worker()
          ?.deleteMe()
          .then(
            () => undefined,
            (err: Error) => err,
          )
        deps.secrets.clear()
        platform.wipe()
        if (remoteError)
          await platform.alert(
            'Remote data could not be deleted',
            `Local data was deleted, but the Gantry Worker did not confirm deleting your account (${remoteError.message}). Revoke Gantry's GitHub, Slack and Google access from those services to cut it off.`,
          )
        platform.relaunch()
      },
      openExternal,
    },
  }
}
