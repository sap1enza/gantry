import type { IngestSignal, Settings } from '@gantry/shared'
import { HttpError, type Ctx } from './context'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const SOURCE = { kind: 'email', name: 'Gmail' } as const
const NEEDS_ACTION_INSTRUCTION =
  'You triage an email for its recipient. decision=true only if the email needs a personal action or reply from the recipient (not newsletters, notifications, receipts or FYIs).'

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  payload?: GmailPart & { headers?: { name: string; value: string }[] }
}

interface GmailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
}

const gmail = <T>(ctx: Ctx, path: string) => ctx.json<T>('google', `${API}${path}`)

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

const senderDomain = (from: string) => (/@([^>\s]+)/.exec(from)?.[1] ?? '').toLowerCase()

const domainMatches = (domain: string, entry: string) => {
  const d = entry.toLowerCase().replace(/^@/, '')
  return domain === d || domain.endsWith(`.${d}`)
}

export function emailFilter(m: GmailMessage, f: Settings['email'], labelNames: Map<string, string>) {
  const labels = m.labelIds ?? []
  if (labels.includes('SENT') || labels.includes('DRAFT')) return 'Sent by you'
  if (labels.includes('SPAM') || labels.includes('TRASH')) return 'Spam or trash'
  if (f.inboxOnly && !labels.includes('INBOX')) return 'Not in inbox'
  if (f.unreadOnly && !labels.includes('UNREAD')) return 'Already read'
  const category = f.excludeCategories.find((c) => labels.includes(`CATEGORY_${c.toUpperCase()}`))
  if (category) return `Category ${category} is excluded`
  const domain = senderDomain(header(m, 'From'))
  if (f.domainDeny.some((d) => domainMatches(domain, d))) return `Sender domain ${domain} is denied`
  if (f.domainAllow.length && !f.domainAllow.some((d) => domainMatches(domain, d))) return `Sender domain ${domain} is not allowed`
  const wanted = f.labels.map((l) => l.toLowerCase())
  if (wanted.length && !labels.some((id) => wanted.includes(id.toLowerCase()) || wanted.includes(labelNames.get(id)?.toLowerCase() ?? '')))
    return 'Missing a required label'
  return undefined
}

function emailSignal(ctx: Ctx, m: GmailMessage): IngestSignal {
  const url = `https://mail.google.com/mail/u/0/#all/${m.threadId}`
  const from = header(m, 'From')
  return {
    trigger: 'email.new',
    source: SOURCE,
    externalKey: m.threadId,
    title: header(m, 'Subject') || '(no subject)',
    body: `From: ${from}\n\n${m.snippet ?? ''}`,
    links: [{ label: 'Open in Gmail', url }],
    metadata: { threadId: m.threadId, messageId: m.id },
    actor: from,
    occurredAt: ctx.iso(),
  }
}

async function recentMessageIds(ctx: Ctx, query: string) {
  const q = encodeURIComponent(ctx.settings().email.inboxOnly ? `${query} in:inbox` : query)
  const ids: string[] = []
  let pageToken = ''
  do {
    const page = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(
      ctx,
      `/messages?q=${q}&maxResults=500${pageToken && `&pageToken=${pageToken}`}`,
    )
    ids.push(...(page.messages ?? []).map((m) => m.id))
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return ids.reverse()
}

async function newMessageIds(ctx: Ctx): Promise<{ ids: string[]; historyId: string }> {
  const historyId = ctx.deps.kv.get<string>('gmail.historyId')
  const polledAt = ctx.deps.kv.get<number>('gmail.polledAt')
  const inbox = ctx.settings().email.inboxOnly ? '&labelId=INBOX' : ''
  if (historyId) {
    try {
      const ids: string[] = []
      let pageToken = ''
      let latest = historyId
      do {
        const res = await gmail<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; historyId: string; nextPageToken?: string }>(
          ctx,
          `/history?startHistoryId=${historyId}&historyTypes=messageAdded${inbox}${pageToken && `&pageToken=${pageToken}`}`,
        )
        for (const h of res.history ?? []) ids.push(...(h.messagesAdded ?? []).map((a) => a.message.id))
        latest = res.historyId
        pageToken = res.nextPageToken ?? ''
      } while (pageToken)
      return { ids, historyId: latest }
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e
    }
  }
  const profile = await gmail<{ historyId: string }>(ctx, '/profile')
  const query = polledAt ? `after:${Math.floor(polledAt / 1000)}` : historyId ? undefined : 'newer_than:1d'
  return { ids: query ? await recentMessageIds(ctx, query) : [], historyId: profile.historyId }
}

export async function pollGmail(ctx: Ctx) {
  if (!ctx.account('google')) return
  const startedAt = ctx.now()
  const { ids, historyId } = await newMessageIds(ctx)
  const queue = ctx.queued('gmail:', ids)
  ctx.deps.kv.set('gmail.historyId', historyId)
  ctx.deps.kv.set('gmail.polledAt', startedAt)
  const f = ctx.settings().email
  const labelNames = new Map<string, string>()
  if (f.labels.length && queue.length) {
    const { labels } = await gmail<{ labels: { id: string; name: string }[] }>(ctx, '/labels')
    for (const l of labels) labelNames.set(l.id, l.name)
  }
  const seenThreads = new Set<string>()
  for (const id of queue) {
    const describe: IngestSignal = { trigger: 'email.new', source: SOURCE, externalKey: id, title: `Gmail message ${id}`, occurredAt: ctx.iso() }
    await ctx.retryable(`gmail:${id}`, describe, async () => {
      const m = await gmail<GmailMessage>(ctx, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`).catch((e) => {
        if (e instanceof HttpError && e.status === 404) return undefined
        throw e
      })
      if (!m || seenThreads.has(m.threadId)) return
      seenThreads.add(m.threadId)
      const filtered = emailFilter(m, f, labelNames)
      const llm = f.llmGate ? { instruction: NEEDS_ACTION_INSTRUCTION, content: `From: ${header(m, 'From')}\nSubject: ${header(m, 'Subject')}\n\n${m.snippet ?? ''}` } : undefined
      await ctx.emit(emailSignal(ctx, m), { filtered, llm })
    })
  }
}

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8')

function plainText(part: GmailPart | undefined): string {
  if (!part) return ''
  if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data)
  const nested = (part.parts ?? []).map(plainText).find(Boolean)
  if (nested) return nested
  return part.mimeType === 'text/html' && part.body?.data ? decode(part.body.data).replace(/<[^>]+>/g, ' ') : ''
}

export async function emailContext(ctx: Ctx, threadId: string) {
  const { messages } = await gmail<{ messages: GmailMessage[] }>(ctx, `/threads/${threadId}?format=full`)
  return messages.map((m) => `From: ${header(m, 'From')}\nSubject: ${header(m, 'Subject')}\n\n${plainText(m.payload).trim()}`).join('\n\n---\n\n')
}
