import type { IngestSignal } from '@gantry/shared'
import type { Ctx } from './context'

const SOURCE = { kind: 'slack', name: 'Slack' } as const
const DM_TYPES = new Set(['im', 'mpim'])
const FOLLOW_UP_WINDOW_MS = 7 * 24 * 3600_000
const MISSING_SCOPE_LOG_MS = 3600_000
const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/
const UNREPLIED_INSTRUCTION =
  'You review a Slack conversation for the user marked "ME". Decide whether ME still owes a reply to the message marked "MENTION". decision=true only if a response from ME is still expected.'
const FOLLOW_UP_INSTRUCTION =
  'You review a Slack conversation for the user marked "ME". Decide whether ME made a commitment (promised to do, check, send or follow up on something) whose next step is still open. decision=true only if such a commitment remains.'

interface SlackMessage {
  type?: string
  subtype?: string
  user?: string
  text?: string
  ts: string
  thread_ts?: string
  channel?: string
  channel_type?: string
}

export interface PendingMention {
  channel: string
  ts: string
  threadTs?: string
  dueAt: number
  signal: IngestSignal
}

const channelNames = new Map<string, string>()

class SlackError extends Error {
  constructor(
    method: string,
    readonly code?: string,
  ) {
    super(`Slack ${method}: ${code}`)
  }
}

async function slackApi<T>(ctx: Ctx, method: string, params: Record<string, string | number>) {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  const body = await ctx.json<{ ok: boolean; error?: string } & T>('slack', `https://slack.com/api/${method}?${query}`)
  if (!body.ok) throw new SlackError(method, body.error)
  return body
}

export const permalink = (channel: string, ts: string, threadTs?: string) =>
  `https://slack.com/archives/${channel}/p${ts.replace('.', '')}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channel}` : ''}`

export function isMention(m: Pick<SlackMessage, 'text' | 'channel_type'>, me: string) {
  const text = m.text ?? ''
  return m.channel_type === 'im' || text.includes(`<@${me}>`) || (DM_TYPES.has(m.channel_type ?? '') && /<!(here|channel)>/.test(text))
}

async function channelName(ctx: Ctx, channel: string) {
  if (channelNames.has(channel)) return channelNames.get(channel)
  try {
    const info = await slackApi<{ channel: { name: string } }>(ctx, 'conversations.info', { channel })
    channelNames.set(channel, info.channel.name)
    return info.channel.name
  } catch (e) {
    if (!(e instanceof SlackError && e.code === 'missing_scope')) throw e
    logMissingScope(ctx, 'slack.channelScopeLoggedAt', 'Channel allow/deny by name skipped: reconnect Slack to grant channels:read and groups:read')
    return undefined
  }
}

async function channelFilter(ctx: Ctx, channel: string, channelType?: string) {
  const { channelAllow, channelDeny } = ctx.settings().slack
  if (DM_TYPES.has(channelType ?? '') || channel.startsWith('D') || (!channelAllow.length && !channelDeny.length)) return undefined
  const entries = (list: string[]) => list.map((entry) => entry.replace(/^#/, ''))
  const allow = entries(channelAllow)
  const deny = entries(channelDeny)
  const isName = (entry: string) => !CHANNEL_ID.test(entry)
  if (deny.includes(channel)) return 'Channel is on the deny list'
  const needsName = deny.some(isName) || (!allow.includes(channel) && allow.some(isName))
  const name = needsName ? await channelName(ctx, channel) : undefined
  if (name && deny.includes(name)) return 'Channel is on the deny list'
  if (!allow.length || allow.includes(channel) || (name ? allow.includes(name) : allow.some(isName))) return undefined
  return 'Channel is not on the allow list'
}

function messageSignal(ctx: Ctx, m: SlackMessage & { channel: string }, trigger: IngestSignal['trigger']): IngestSignal {
  const text = m.text ?? ''
  const url = permalink(m.channel, m.ts, m.thread_ts)
  return {
    trigger,
    source: SOURCE,
    externalKey: `${m.channel}:${m.ts}`,
    title: text.replace(/\s+/g, ' ').slice(0, 120) || 'Slack message',
    body: `${text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n[Open in Slack](${url})`,
    links: [{ label: 'Open in Slack', url }],
    metadata: { channel: m.channel, ts: m.ts, threadTs: m.thread_ts },
    actor: m.user,
    occurredAt: ctx.iso(),
  }
}

export async function slackEvent(ctx: Ctx, payload: { event?: SlackMessage } & SlackMessage) {
  const m = payload.event ?? payload
  const me = ctx.account('slack')?.id
  if (!me || m.type !== 'message' || !m.channel || (m.subtype && m.subtype !== 'thread_broadcast')) return
  if (m.user === me || !isMention(m, me)) return
  const filtered = await channelFilter(ctx, m.channel, m.channel_type)
  const s = messageSignal(ctx, { ...m, channel: m.channel }, 'slack.mention')
  await ctx.emit(s, { filtered })
  if (!filtered && ctx.triggerOn('slack.unreplied')) {
    const dueAt = ctx.now() + ctx.settings().slack.unrepliedAfterMinutes * 60_000
    const pending = ctx.deps.kv.get<PendingMention[]>('slack.pending') ?? []
    ctx.deps.kv.set('slack.pending', [...pending, { channel: m.channel, ts: m.ts, threadTs: m.thread_ts, dueAt, signal: { ...s, trigger: 'slack.unreplied' } }])
  }
}

async function conversation(ctx: Ctx, channel: string, ts: string, threadTs?: string) {
  const { messages } = await slackApi<{ messages: SlackMessage[] }>(ctx, 'conversations.replies', { channel, ts: threadTs ?? ts, limit: 100 })
  if (threadTs) return messages
  const later = await slackApi<{ messages: SlackMessage[] }>(ctx, 'conversations.history', { channel, oldest: ts, limit: 50 })
  return [...messages, ...later.messages.filter((x) => x.ts !== ts).reverse()]
}

const transcript = (messages: SlackMessage[], me: string, mentionTs?: string) =>
  messages.map((x) => `${x.user === me ? 'ME' : (x.user ?? 'someone')}${x.ts === mentionTs ? ' (MENTION)' : ''}: ${x.text ?? ''}`).join('\n')

export async function checkUnreplied(ctx: Ctx) {
  const me = ctx.account('slack')?.id
  if (!me) return
  const pending = () => ctx.deps.kv.get<PendingMention[]>('slack.pending') ?? []
  const done = new Set<string>()
  try {
    for (const p of pending().filter((x) => x.dueAt <= ctx.now())) {
      const settled = await ctx.retryable(`slack.unreplied:${p.signal.externalKey}`, p.signal, async () => {
        if (!ctx.triggerOn('slack.unreplied')) return ctx.emit(p.signal)
        const messages = await conversation(ctx, p.channel, p.ts, p.threadTs)
        const replied = messages.some((x) => x.user === me && Number(x.ts) > Number(p.ts))
        return ctx.emit(p.signal, replied ? { filtered: 'Already replied' } : { llm: { instruction: UNREPLIED_INSTRUCTION, content: transcript(messages, me, p.ts) } })
      })
      if (settled) done.add(p.signal.externalKey)
    }
  } finally {
    if (done.size) ctx.deps.kv.set('slack.pending', pending().filter((x) => !done.has(x.signal.externalKey)))
  }
}

function logMissingScope(ctx: Ctx, key: string, detail: string) {
  if (ctx.now() - (ctx.deps.kv.get<number>(key) ?? 0) < MISSING_SCOPE_LOG_MS) return
  ctx.deps.kv.set(key, ctx.now())
  ctx.deps.sink.logConnection('slack', 'missing_scope', detail)
}

export async function scanFollowUps(ctx: Ctx) {
  const me = ctx.account('slack')?.id
  if (!me || !ctx.triggerOn('slack.follow_up')) return
  const since = ctx.now() - FOLLOW_UP_WINDOW_MS
  const after = new Date(since - 24 * 3600_000).toISOString().slice(0, 10)
  const search = await slackApi<{ messages: { matches: { ts: string; channel: { id: string }; permalink: string }[] } }>(ctx, 'search.messages', {
    query: `from:<@${me}> after:${after}`,
    sort: 'timestamp',
    count: 100,
  }).catch((e) => {
    if (!(e instanceof SlackError && e.code === 'missing_scope')) throw e
  })
  if (!search) return logMissingScope(ctx, 'slack.missingScopeLoggedAt', 'Follow-up scan skipped: reconnect Slack to grant search:read')
  const { messages } = search
  const threads = new Map<string, { channel: string; threadTs: string }>()
  for (const match of messages.matches) {
    if (Number(match.ts) * 1000 < since) continue
    const threadTs = new URL(match.permalink).searchParams.get('thread_ts') ?? match.ts
    threads.set(`${match.channel.id}:${threadTs}`, { channel: match.channel.id, threadTs })
  }
  const checked = Object.fromEntries(
    Object.entries(ctx.deps.kv.get<Record<string, string>>('slack.followUpChecked') ?? {}).filter(([, ts]) => Number(ts) * 1000 >= since),
  )
  try {
    for (const [key, { channel, threadTs }] of threads) {
      const describe = { ...messageSignal(ctx, { ts: threadTs, channel }, 'slack.follow_up'), externalKey: key }
      await ctx.retryable(`slack.followUp:${key}`, describe, async () => {
        const thread = await conversation(ctx, channel, threadTs, threadTs)
        const last = thread.at(-1)?.ts ?? threadTs
        if (checked[key] === last) return
        const root = thread[0] ?? { ts: threadTs }
        await ctx.emit({ ...messageSignal(ctx, { ...root, channel }, 'slack.follow_up'), externalKey: key }, { filtered: await channelFilter(ctx, channel), llm: { instruction: FOLLOW_UP_INSTRUCTION, content: transcript(thread, me) } })
        checked[key] = last
      })
    }
  } finally {
    ctx.deps.kv.set('slack.followUpChecked', checked)
  }
}

export async function slackContext(ctx: Ctx, metadata: Record<string, unknown>) {
  const { channel, ts, threadTs } = metadata as { channel?: string; ts?: string; threadTs?: string }
  const me = ctx.account('slack')?.id
  if (!channel || !ts || !me) return undefined
  return transcript(await conversation(ctx, channel, ts, threadTs), me, ts)
}
