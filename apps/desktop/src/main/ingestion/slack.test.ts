import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkUnreplied, isMention, permalink, scanFollowUps, slackEvent, type PendingMention } from './slack'
import { connectedCtx, fakeDeps, grantFor, NOW, res, routeFetch } from './testing'

const ME = { id: 'U1', login: 'lucas' }

function setup() {
  const deps = fakeDeps()
  const ctx = connectedCtx(deps, grantFor('slack', ME))
  return { deps, ctx }
}

const message = (over: object = {}) => ({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U2', text: 'hey <@U1> can you check?', ts: '1700000000.000100', ...over })

afterEach(() => vi.unstubAllGlobals())

describe('isMention', () => {
  it('detects my id, any direct message, and @here/@channel only in DMs', () => {
    expect(isMention({ text: 'can you review?', channel_type: 'im' }, 'U1')).toBe(true)
    expect(isMention({ text: 'ping <@U1>' }, 'U1')).toBe(true)
    expect(isMention({ text: 'ping <@U9>' }, 'U1')).toBe(false)
    expect(isMention({ text: '<!here> deploy', channel_type: 'im' }, 'U1')).toBe(true)
    expect(isMention({ text: '<!channel> deploy', channel_type: 'channel' }, 'U1')).toBe(false)
  })

  it('builds thread-aware permalinks', () => {
    expect(permalink('C1', '1700.0002', '1700.0001')).toBe('https://slack.com/archives/C1/p17000002?thread_ts=1700.0001&cid=C1')
  })
})

describe('slackEvent', () => {
  it('ingests a mention with the original text and schedules an unreplied check', async () => {
    const { ctx, deps } = setup()
    await slackEvent(ctx, { event: message() } as never)
    const signal = deps.sink.ingest.mock.calls[0]![0]
    expect(signal).toMatchObject({ trigger: 'slack.mention', externalKey: 'C1:1700000000.000100' })
    expect(signal.body).toContain('> hey <@U1> can you check?')
    const pending = deps.kv.get<PendingMention[]>('slack.pending')!
    expect(pending[0]!.dueAt).toBe(NOW.getTime() + 30 * 60_000)
  })

  it('ignores my own messages', async () => {
    const { ctx, deps } = setup()
    await slackEvent(ctx, { event: message({ user: 'U1' }) } as never)
    expect(deps.sink.ingest).not.toHaveBeenCalled()
  })

  it('honours deny and allow lists by channel id or name', async () => {
    const { ctx, deps } = setup()
    routeFetch([['conversations.info', () => res({ ok: true, channel: { name: 'random' } })]])
    deps.settings.slack.channelDeny = ['#random']
    await slackEvent(ctx, { event: message() } as never)
    deps.settings.slack.channelDeny = []
    deps.settings.slack.channelAllow = ['C9']
    await slackEvent(ctx, { event: message() } as never)
    expect(deps.sink.logIgnored.mock.calls.map((c) => c[2])).toEqual(['Channel is on the deny list', 'Channel is not on the allow list'])
    expect(deps.kv.get('slack.pending')).toBeUndefined()
  })

  it('matches channel ids without a lookup and skips name filters when channels:read is missing', async () => {
    const { ctx, deps } = setup()
    const fetch = routeFetch([['conversations.info', () => res({ ok: false, error: 'missing_scope' })]])
    deps.settings.slack.channelDeny = ['C0DENIED1']
    await slackEvent(ctx, { event: message({ channel: 'C0DENIED1' }) } as never)
    expect(fetch).not.toHaveBeenCalled()
    deps.settings.slack.channelDeny = []
    deps.settings.slack.channelAllow = ['#eng']
    await slackEvent(ctx, { event: message({ channel: 'C0UNKNOWN', ts: '1' }) } as never)
    await slackEvent(ctx, { event: message({ channel: 'C0UNKNOWN', ts: '2' }) } as never)
    expect(deps.sink.logIgnored.mock.calls.map((c) => c[2])).toEqual(['Channel is on the deny list'])
    expect(deps.sink.ingest.mock.calls.map(([x]) => x.externalKey)).toEqual(['C0UNKNOWN:1', 'C0UNKNOWN:2'])
    expect(deps.sink.logConnection.mock.calls.filter(([, st]) => st === 'missing_scope')).toHaveLength(1)
  })

  it('handles a retried Slack event only once', async () => {
    const { ctx, deps } = setup()
    await slackEvent(ctx, { event_id: 'Ev1', event: message() } as never)
    await slackEvent(ctx, { event_id: 'Ev1', event: message() } as never)
    expect(deps.sink.ingest).toHaveBeenCalledTimes(1)
  })
})

describe('checkUnreplied', () => {
  const pending = (signalTs = '1700000000.000100'): PendingMention => ({
    channel: 'D1',
    ts: signalTs,
    threadTs: signalTs,
    dueAt: NOW.getTime() - 1,
    signal: { trigger: 'slack.unreplied', source: { kind: 'slack', name: 'Slack' }, externalKey: `D1:${signalTs}`, title: 'x', occurredAt: '' },
  })

  it('asks the LLM and ingests an AI-detected unreplied mention', async () => {
    const { ctx, deps } = setup()
    deps.secrets.set('llm.apiKey', 'k')
    deps.kv.set('slack.pending', [pending()])
    routeFetch([
      ['conversations.replies', () => res({ ok: true, messages: [message({ channel: 'D1' })] })],
      ['api.anthropic.com', () => res({ content: [{ type: 'text', text: '{"decision": true, "reason": "Question unanswered"}' }] })],
    ])
    await checkUnreplied(ctx)
    expect(deps.sink.ingest.mock.calls[0]![0]).toMatchObject({ trigger: 'slack.unreplied', aiDetected: true, receivedDetail: 'Question unanswered' })
    expect(deps.kv.get('slack.pending')).toEqual([])
  })

  it('skips the LLM when I already replied', async () => {
    const { ctx, deps } = setup()
    deps.kv.set('slack.pending', [pending()])
    const fetch = routeFetch([['conversations.replies', () => res({ ok: true, messages: [message(), message({ user: 'U1', ts: '1700000001.000000' })] })]])
    await checkUnreplied(ctx)
    expect(deps.sink.logIgnored.mock.calls[0]![1]).toBe('ignored:filtered')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('scanFollowUps', () => {
  it('logs a missing search:read scope as skipped once per hour instead of failing', async () => {
    const { ctx, deps } = setup()
    routeFetch([['search.messages', () => res({ ok: false, error: 'missing_scope' })]])
    await scanFollowUps(ctx)
    await scanFollowUps(ctx)
    expect(deps.sink.logConnection.mock.calls.filter(([, s]) => s === 'missing_scope')).toHaveLength(1)
    deps.kv.set('slack.missingScopeLoggedAt', NOW.getTime() - 3600_000)
    await scanFollowUps(ctx)
    expect(deps.sink.logConnection.mock.calls.filter(([, s]) => s === 'missing_scope')).toHaveLength(2)
  })
})
