export const PROTOCOL = 'gantry'

export function parseDeepLink(url: string): string | undefined {
  const m = /^gantry:\/\/actionable\/([\w.:-]+)\/?$/.exec(url.trim())
  return m ? decodeURIComponent(m[1]!) : undefined
}
