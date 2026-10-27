export const PROTOCOL = 'gantry'

export type DeepLink = { kind: 'actionable'; id: string } | { kind: 'authComplete'; code: string }

export function parseDeepLink(url: string): DeepLink | undefined {
  const actionable = /^gantry:\/\/actionable\/([\w.:-]+)\/?$/.exec(url.trim())
  if (actionable) return { kind: 'actionable', id: decodeURIComponent(actionable[1]!) }
  const auth = /^gantry:\/\/auth\/complete\/?\?code=([\w-]+)$/.exec(url.trim())
  return auth ? { kind: 'authComplete', code: auth[1]! } : undefined
}
