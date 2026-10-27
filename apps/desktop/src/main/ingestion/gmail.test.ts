import { DEFAULT_SETTINGS } from '@gantry/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emailFilter, pollGmail, type GmailMessage } from './gmail'
import { connectedCtx, fakeDeps, grantFor, res, routeFetch } from './testing'

const msg = (labelIds: string[], from = 'Ana <ana@acme.com>'): GmailMessage => ({
  id: 'm1',
  threadId: 't1',
  labelIds,
  snippet: 'Can you review?',
  payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Review' }] },
})

afterEach(() => vi.unstubAllGlobals())

describe('emailFilter', () => {
  const f = DEFAULT_SETTINGS.email
  const none = new Map<string, string>()

  it('applies inbox, unread and category filters', () => {
    expect(emailFilter(msg(['INBOX', 'UNREAD']), f, none)).toBeUndefined()
    expect(emailFilter(msg(['UNREAD']), f, none)).toBe('Not in inbox')
    expect(emailFilter(msg(['INBOX']), f, none)).toBe('Already read')
    expect(emailFilter(msg(['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS']), f, none)).toBe('Category promotions is excluded')
    expect(emailFilter(msg(['SENT']), { ...f, inboxOnly: false, unreadOnly: false }, none)).toBe('Sent by you')
  })

  it('applies domain allow/deny including subdomains', () => {
    const base = msg(['INBOX', 'UNREAD'], 'x@mail.acme.com')
    expect(emailFilter(base, { ...f, domainDeny: ['@acme.com'] }, none)).toBe('Sender domain mail.acme.com is denied')
    expect(emailFilter(base, { ...f, domainAllow: ['other.io'] }, none)).toBe('Sender domain mail.acme.com is not allowed')
    expect(emailFilter(base, { ...f, domainAllow: ['acme.com'] }, none)).toBeUndefined()
  })

  it('requires a label by id or name', () => {
    const m = msg(['INBOX', 'UNREAD', 'Label_9'])
    expect(emailFilter(m, { ...f, labels: ['Clients'] }, new Map([['Label_9', 'clients']]))).toBeUndefined()
    expect(emailFilter(m, { ...f, labels: ['Billing'] }, new Map([['Label_9', 'clients']]))).toBe('Missing a required label')
  })
})

describe('pollGmail', () => {
  it('falls back to recent messages when the historyId expired, one signal per thread', async () => {
    const deps = fakeDeps()
    const ctx = connectedCtx(deps, grantFor('google', { id: 'g', login: 'me@acme.com' }))
    deps.kv.set('gmail.historyId', '100')
    routeFetch([
      ['/history?', () => res({ error: 'gone' }, 404)],
      ['/profile', () => res({ historyId: '555' })],
      ['/messages?q=', () => res({ messages: [{ id: 'm2' }, { id: 'm1' }] })],
      [/\/messages\/m\d/, () => res(msg(['INBOX', 'UNREAD']))],
    ])
    await pollGmail(ctx)
    expect(deps.sink.ingest).toHaveBeenCalledTimes(1)
    expect(deps.sink.ingest.mock.calls[0]![0]).toMatchObject({ trigger: 'email.new', externalKey: 't1', title: 'Review' })
    expect(deps.kv.get('gmail.historyId')).toBe('555')
  })
})
