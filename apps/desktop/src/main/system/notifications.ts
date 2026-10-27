import type { ActivityEvent, Settings } from '@gantry/shared'

export function notificationFor(event: ActivityEvent, settings: Settings): { title: string; body: string } | undefined {
  const n = settings.notifications
  const card = event.actionableDisplayId ? `${event.actionableDisplayId} · ${event.title}` : event.title
  if (event.type === 'awaiting_input' && n.needsInput) return { title: 'Agent needs input', body: card }
  if (event.type === 'completed' && n.completed) return { title: 'Agent completed', body: card }
  if (event.type === 'failed' && n.failed) return { title: 'Agent failed', body: `${card}${event.detail ? `\n${event.detail}` : ''}` }
  if (event.type === 'received' && event.outcome === 'created' && n.newActionable) return { title: `New actionable from ${event.source}`, body: card }
  return undefined
}
