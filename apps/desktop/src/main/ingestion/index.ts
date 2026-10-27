import { SECRET_KEYS, type Actionable, type ConnectionInfo, type InboxItem, type OAuthProvider, type SourceKind } from '@gantry/shared'
import type { Ingestion, IngestionDeps } from '../contracts'
import { createCtx, NotConnectedError, ThrottledError, withTimeout, type Ctx } from './context'
import { githubContext, githubRepositories, githubWebhook, reconcileGithub } from './github'
import { emailContext, pollGmail } from './gmail'
import { checkUnreplied, scanFollowUps, slackContext, slackEvent } from './slack'

const INBOX_INTERVAL_MS = 15_000
const MAX_ITEM_ATTEMPTS = 5
const MAX_CONTEXT = 8_000
const PROVIDERS: OAuthProvider[] = ['github', 'slack', 'google']
const PROVIDER_KV: Record<OAuthProvider, string[]> = {
  github: ['github.active', 'github.issuesSince', 'github.mentionsSince'],
  slack: ['slack.pending', 'slack.followUpChecked', 'slack.missingScopeLoggedAt', 'slack.channelScopeLoggedAt', 'slack.seenEvents'],
  google: ['gmail.historyId', 'gmail.retry'],
}
const SOURCE_KIND: Record<OAuthProvider, SourceKind> = { github: 'github', slack: 'slack', google: 'email' }
const MANAGE_ACCESS: Record<OAuthProvider, string> = {
  github: 'https://github.com/settings/installations',
  slack: 'https://slack.com/apps/manage',
  google: 'https://myaccount.google.com/permissions',
}

interface Job {
  name: string
  provider: OAuthProvider
  interval: () => number
  run: (ctx: Ctx) => Promise<void>
}

const JOBS: Job[] = [
  { name: 'github.reconcile', provider: 'github', interval: () => 300_000 + Math.random() * 300_000, run: reconcileGithub },
  { name: 'gmail.poll', provider: 'google', interval: () => 60_000, run: pollGmail },
  { name: 'slack.unreplied', provider: 'slack', interval: () => 60_000, run: checkUnreplied },
  { name: 'slack.followUp', provider: 'slack', interval: () => 3_600_000, run: scanFollowUps },
]

function report(e: unknown) {
  if (e instanceof ThrottledError || e instanceof NotConnectedError) return
  console.error('[ingestion]', e)
}

type Exclusive = (run: () => Promise<void>) => Promise<void>

async function handleInboxItem(ctx: Ctx, item: InboxItem, exclusive: Exclusive) {
  const p = item.payload
  switch (p.kind) {
    case 'actionable.create': {
      const r = p.request
      const name = r.source?.name ?? 'API'
      await ctx.emit({
        id: p.id,
        trigger: 'api.custom',
        source: { kind: 'api', name, icon: r.source?.icon },
        externalKey: `${name}:${r.external_id ?? p.id}`,
        title: r.title,
        body: r.body,
        links: r.links,
        repository: r.repository,
        instructions: r.instructions,
        priority: r.priority,
        tags: r.tags,
        metadata: r.metadata,
        autoStart: r.auto_start,
        actor: p.tokenName,
        occurredAt: item.receivedAt,
      })
      return
    }
    case 'actionable.update':
      return ctx.deps.sink.applyPatch(p.target, p.patch)
    case 'actionable.dismiss':
      return ctx.deps.sink.dismiss(p.target)
    case 'connection':
      if (p.status === 'connected') {
        await ctx.refresh(p.provider)
        return
      }
      if (p.status === 'disconnected') return exclusive(async () => forget(ctx, p.provider))
      return ctx.setConnection(p.provider, { status: p.status })
    case 'github.webhook':
      return githubWebhook(ctx, p.event, p.payload as Parameters<typeof githubWebhook>[2])
    case 'slack.event':
      return slackEvent(ctx, p.payload as Parameters<typeof slackEvent>[1])
  }
}

function forget(ctx: Ctx, provider: OAuthProvider) {
  ctx.deps.secrets.delete(SECRET_KEYS.grant(provider))
  for (const key of PROVIDER_KV[provider]) ctx.deps.kv.delete(key)
  ctx.setConnection(provider, { status: 'disconnected', account: undefined, detail: undefined })
  ctx.deps.sink.markSourceDisconnected(SOURCE_KIND[provider])
}

function contextFor(ctx: Ctx, a: Actionable) {
  if (a.source.kind === 'slack') return slackContext(ctx, a.metadata)
  if (!a.externalKey) return undefined
  if (a.source.kind === 'github') return githubContext(ctx, a.externalKey)
  if (a.source.kind === 'email') return emailContext(ctx, a.externalKey)
  return undefined
}

export async function pollInbox(ctx: Ctx, failures: Map<string, number>, exclusive: Exclusive = (run) => run()) {
  const worker = ctx.deps.worker()
  if (!worker) return
  const { items } = await withTimeout(worker.inbox())
  const handled: string[] = []
  for (const item of items) {
    try {
      await handleInboxItem(ctx, item, exclusive)
      failures.delete(item.id)
    } catch (e) {
      if (e instanceof ThrottledError) continue
      const attempts = (failures.get(item.id) ?? 0) + 1
      if (attempts < MAX_ITEM_ATTEMPTS) {
        failures.set(item.id, attempts)
        report(e)
        break
      }
      console.error(`[ingestion] dropping inbox item ${item.id} after ${attempts} attempts`, e)
      failures.delete(item.id)
    }
    handled.push(item.id)
  }
  if (handled.length) await withTimeout(worker.ack(handled))
}

export function serial() {
  let tail: Promise<void> = Promise.resolve()
  let waiting = false
  return (run: () => Promise<void>, force = false) => {
    if (waiting && !force) return tail
    waiting = true
    tail = tail.catch(() => {}).then(() => {
      waiting = false
      return run()
    })
    return tail
  }
}

export function createIngestion(deps: IngestionDeps): Ingestion {
  const ctx = createCtx(deps)
  const nextRun = new Map<string, number>()
  const failures = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | undefined
  const inbox = serial()
  const jobs = serial()

  async function runJobs(force: boolean) {
    for (const job of JOBS) {
      if (!ctx.account(job.provider) || (!force && (nextRun.get(job.name) ?? 0) > ctx.now())) continue
      nextRun.set(job.name, ctx.now() + job.interval())
      try {
        await job.run(ctx)
        ctx.setConnection(job.provider, { lastSyncAt: ctx.iso() })
      } catch (e) {
        report(e)
      }
    }
  }

  async function schedule(force: boolean) {
    await Promise.all([inbox(() => pollInbox(ctx, failures, (run) => jobs(run, true)).catch(report)), jobs(() => runJobs(force), force)])
  }

  return {
    start() {
      if (timer) return
      void schedule(false)
      timer = setInterval(() => void schedule(false), INBOX_INTERVAL_MS)
    },
    stop() {
      clearInterval(timer)
      timer = undefined
    },
    syncNow: () => schedule(true),
    connections(): ConnectionInfo[] {
      const state = ctx.connectionState()
      return [
        ...PROVIDERS.map((provider) => state[provider] ?? { provider, status: 'disconnected' as const }),
        { provider: 'api', status: deps.worker() ? 'connected' : 'disconnected' },
      ]
    },
    async connect(provider) {
      const worker = deps.worker()
      if (!worker) throw new Error('Device is not registered with the Gantry worker yet')
      await deps.openExternal(await worker.oauthStartUrl(provider))
    },
    async disconnect(provider) {
      await deps.worker()?.revokeGrant(provider).catch(report)
      await jobs(async () => forget(ctx, provider), true)
    },
    manageAccessUrl: (provider) => MANAGE_ACCESS[provider],
    githubRepositories: () => githubRepositories(ctx),
    async fetchContext(a: Actionable) {
      try {
        const text = await contextFor(ctx, a)
        return text && (text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}\n…(truncated)` : text)
      } catch (e) {
        report(e)
        return undefined
      }
    },
    onConnectionsChanged: (listener) => ctx.onChange(listener),
  }
}
