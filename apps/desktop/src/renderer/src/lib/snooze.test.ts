import { describe, expect, it } from 'vitest'
import { snoozeUntil } from './snooze'

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min)

describe('snoozeUntil', () => {
  it('adds hours', () => {
    expect(snoozeUntil('1h', local(2026, 10, 27, 23, 30))).toEqual(local(2026, 10, 28, 0, 30))
    expect(snoozeUntil('3h', local(2026, 10, 27, 10))).toEqual(local(2026, 10, 27, 13))
  })

  it('tomorrow 9am crosses month and week boundaries', () => {
    expect(snoozeUntil('tomorrow', local(2026, 10, 31, 22))).toEqual(local(2026, 11, 1, 9))
    expect(snoozeUntil('tomorrow', local(2026, 11, 1, 0, 5))).toEqual(local(2026, 11, 2, 9))
  })

  it('next Monday is always in the future, a week ahead when today is Monday', () => {
    expect(snoozeUntil('monday', local(2026, 10, 27, 10))).toEqual(local(2026, 11, 2, 9))
    expect(snoozeUntil('monday', local(2026, 11, 1, 20))).toEqual(local(2026, 11, 2, 9))
    expect(snoozeUntil('monday', local(2026, 11, 2, 8))).toEqual(local(2026, 11, 9, 9))
    expect(snoozeUntil('monday', local(2026, 12, 31, 12))).toEqual(local(2027, 1, 4, 9))
  })
})
