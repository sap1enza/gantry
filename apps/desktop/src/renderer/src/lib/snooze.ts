export const SNOOZE_PRESETS = [
  { id: '1h', label: '1 hour' },
  { id: '3h', label: '3 hours' },
  { id: 'tomorrow', label: 'Tomorrow 9 AM' },
  { id: 'monday', label: 'Next Monday 9 AM' },
] as const
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number]['id']

export function snoozeUntil(preset: SnoozePreset, now = new Date()): Date {
  const d = new Date(now)
  switch (preset) {
    case '1h':
      return new Date(now.getTime() + 3_600_000)
    case '3h':
      return new Date(now.getTime() + 3 * 3_600_000)
    case 'tomorrow':
      d.setDate(d.getDate() + 1)
      break
    case 'monday':
      d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7))
      break
  }
  d.setHours(9, 0, 0, 0)
  return d
}
