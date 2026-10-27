import { describe, expect, it } from 'vitest'
import { shortcutFor } from './shortcuts'

const key = (key: string, opts: { meta?: boolean; target?: unknown } = {}) => ({
  key,
  metaKey: !!opts.meta,
  ctrlKey: false,
  altKey: false,
  target: (opts.target ?? { tagName: 'DIV', isContentEditable: false }) as EventTarget,
})

describe('shortcutFor', () => {
  it('maps plain and modifier keys', () => {
    expect(shortcutFor(key('s'))).toBe('start')
    expect(shortcutFor(key('S'))).toBe('start')
    expect(shortcutFor(key('Enter'))).toBe('open')
    expect(shortcutFor(key('Enter', { meta: true }))).toBe('done')
    expect(shortcutFor(key('2', { meta: true }))).toBe('activity')
    expect(shortcutFor(key('x'))).toBeUndefined()
  })

  it('ignores shortcuts while typing except ⌘K', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const target = { tagName, isContentEditable: false }
      expect(shortcutFor(key('d', { target }))).toBeUndefined()
      expect(shortcutFor(key('Enter', { meta: true, target }))).toBeUndefined()
      expect(shortcutFor(key('k', { meta: true, target }))).toBe('search')
    }
    expect(shortcutFor(key('z', { target: { tagName: 'DIV', isContentEditable: true } }))).toBeUndefined()
  })
})
