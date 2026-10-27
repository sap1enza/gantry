import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

describe('parseMarkdown', () => {
  it('strips raw HTML and script contents', () => {
    const blocks = parseMarkdown('Hello <b>world</b><script>alert(1)</script> <img src=x onerror=alert(1)>done')
    expect(blocks).toEqual([{ t: 'p', c: [{ t: 'text', v: 'Hello world done' }] }])
    expect(JSON.stringify(parseMarkdown('<script>\nalert(1)\n</script>\nok'))).not.toContain('alert')
  })

  it('drops unsafe link protocols but keeps the label', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'text', v: 'x' }, { t: 'text', v: ')' }])
    expect(parseInline('[docs](https://a.dev)')).toEqual([{ t: 'link', href: 'https://a.dev', c: [{ t: 'text', v: 'docs' }] }])
  })

  it('parses headings, lists, code and emphasis', () => {
    const blocks = parseMarkdown('# Title\n- one\n- **two**\n\n```\n<b>raw</b>\n```\nUse `pnpm` _now_')
    expect(blocks.map((b) => b.t)).toEqual(['h', 'ul', 'pre', 'p'])
    expect(blocks[2]).toEqual({ t: 'pre', v: '<b>raw</b>' })
    expect(blocks[3]).toEqual({
      t: 'p',
      c: [{ t: 'text', v: 'Use ' }, { t: 'code', v: 'pnpm' }, { t: 'text', v: ' ' }, { t: 'em', c: [{ t: 'text', v: 'now' }] }],
    })
  })
})
