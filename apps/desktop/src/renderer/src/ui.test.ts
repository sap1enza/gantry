import { expect, it, vi } from 'vitest'
import { when } from './ui'

it('shows relative time within the same day and a full date otherwise', () => {
  vi.useFakeTimers({ now: new Date(2026, 9, 29, 18, 0) })
  expect(when(new Date(2026, 9, 29, 17, 0).toISOString())).toBe('1 hour ago')
  expect(when(new Date(2026, 9, 29, 17, 30).toISOString())).toBe('30 minutes ago')
  expect(when(new Date(2026, 7, 28, 17, 30).toISOString())).toBe('28/08/2026 17:30')
  vi.useRealTimers()
})
