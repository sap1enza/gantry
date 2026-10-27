import { describe, expect, it } from 'vitest'
import { parseResult } from './result'

const block = (json: string) => `Done.\n\`\`\`gantry-result\n${json}\n\`\`\``

describe('parseResult', () => {
  it('parses a valid block and drops nulls', () => {
    const text = block(
      '{"summary":"Fixed","filesChanged":["a.ts"],"branch":"gantry/x","prUrl":"https://github.com/o/r/pull/1","testsRun":null,"openQuestions":["Ship?"]}',
    )
    expect(parseResult(text)).toEqual({
      summary: 'Fixed',
      filesChanged: ['a.ts'],
      branch: 'gantry/x',
      prUrl: 'https://github.com/o/r/pull/1',
      openQuestions: ['Ship?'],
    })
  })

  it('uses the last block when several exist', () => {
    expect(parseResult(`${block('{"summary":"first"}')}\n${block('{"summary":"second"}')}`).summary).toBe('second')
  })

  it('falls back to the final text when the block is missing', () => {
    expect(parseResult('  All done, nothing to change.  ')).toEqual({ summary: 'All done, nothing to change.', filesChanged: [], openQuestions: [] })
  })

  it.each([['{not json'], ['{"filesChanged":["a.ts"]}'], ['[]'], ['null']])('falls back on malformed block %s', (json) => {
    const text = block(json)
    expect(parseResult(text)).toEqual({ summary: text, filesChanged: [], openQuestions: [] })
  })
})
