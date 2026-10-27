import { afterEach, describe, expect, it, vi } from 'vitest'
import { classify, parseVerdict } from './llm'
import { res, routeFetch } from './testing'

afterEach(() => vi.unstubAllGlobals())

const bodyOf = (fetch: ReturnType<typeof routeFetch>) => JSON.parse(fetch.mock.calls[0]![1]!.body as string)
const headersOf = (fetch: ReturnType<typeof routeFetch>) => fetch.mock.calls[0]![1]!.headers as Record<string, string>

describe('classify', () => {
  it('calls the Anthropic Messages API', async () => {
    const fetch = routeFetch([['https://api.anthropic.com/v1/messages', () => res({ content: [{ type: 'text', text: '{"decision":true,"reason":"owes reply"}' }] })]])
    expect(await classify({ provider: 'anthropic', model: 'claude-haiku-5-5' }, 'k', 'Decide', 'thread')).toEqual({ decision: true, reason: 'owes reply' })
    expect(headersOf(fetch)['x-api-key']).toBe('k')
    expect(bodyOf(fetch)).toMatchObject({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'thread' }] })
  })

  it('calls OpenAI Chat Completions with JSON mode', async () => {
    const fetch = routeFetch([['https://api.openai.com/v1/chat/completions', () => res({ choices: [{ message: { content: '{"decision":false,"reason":"FYI"}' } }] })]])
    expect(await classify({ provider: 'openai', model: 'gpt-x' }, 'k', 'Decide', 'mail')).toEqual({ decision: false, reason: 'FYI' })
    expect(headersOf(fetch).authorization).toBe('Bearer k')
    expect(bodyOf(fetch).response_format).toEqual({ type: 'json_object' })
  })

  it('calls an OpenAI-compatible base URL', async () => {
    const fetch = routeFetch([['http://localhost:11434/v1/chat/completions', () => res({ choices: [{ message: { content: 'Sure: {"decision":true,"reason":"r"}' } }] })]])
    expect(await classify({ provider: 'openai_compatible', model: 'llama', baseUrl: 'http://localhost:11434/v1/' }, 'k', 'Decide', 'x')).toEqual({ decision: true, reason: 'r' })
    expect(bodyOf(fetch).response_format).toBeUndefined()
  })

  it('treats a missing key as not detected without calling out', async () => {
    const fetch = routeFetch([])
    expect((await classify({ provider: 'anthropic', model: 'm' }, undefined, 'Decide', 'x')).decision).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('treats unparseable output as not detected', () => {
    expect(parseVerdict('no idea').decision).toBe(false)
  })
})
