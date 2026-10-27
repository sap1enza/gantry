import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { toEvents } from './events'
import fixtures from './fixtures/session.json'

const [init, assistant, toolResult, edit, subagent, success, maxTurns] = fixtures as unknown as SDKMessage[]
const withoutRaw = (message: SDKMessage | undefined) => toEvents(message!).filter((event) => event.type !== 'raw')

describe('toEvents', () => {
  it('always forwards the raw message for the transcript', () => {
    for (const message of fixtures as unknown as SDKMessage[]) {
      expect(toEvents(message)[0]).toEqual({ type: 'raw', payload: message })
    }
  })

  it('emits the session id on init', () => {
    expect(withoutRaw(init)).toEqual([{ type: 'session', sessionId: 'b7e4c1d2-5a3f-4e8b-9c0d-1e2f3a4b5c6d' }])
  })

  it('condenses assistant text and summarizes tool calls', () => {
    expect(withoutRaw(assistant)).toEqual([
      { type: 'message', text: 'Looking at the failing test.' },
      { type: 'tool', name: 'Bash', summary: 'pnpm test' },
    ])
    expect(withoutRaw(edit)).toEqual([{ type: 'tool', name: 'Edit', summary: 'src/sum.ts' }])
  })

  it('skips tool results and subagent messages', () => {
    expect(withoutRaw(toolResult)).toEqual([])
    expect(withoutRaw(subagent)).toEqual([])
  })

  it('maps a successful result to usage and a parsed result', () => {
    expect(withoutRaw(success)).toEqual([
      { type: 'usage', inputTokens: 1150, outputTokens: 200, costUsd: 0.0421 },
      {
        type: 'result',
        result: {
          summary: 'Fixed sum',
          filesChanged: ['src/sum.ts'],
          branch: 'gantry/GT-12-fix-ci',
          testsRun: 'pnpm test: pass',
          openQuestions: [],
        },
      },
    ])
  })

  it('maps an error result to usage and an error', () => {
    expect(withoutRaw(maxTurns)).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 1.5 },
      { type: 'error', message: 'error_max_turns' },
    ])
  })
})
