import { DEEP_LINKS } from '@gantry/shared'

export type DeepLink = { kind: 'actionable'; id: string } | { kind: 'authComplete'; code: string }

const ID = /^[\w.:-]+$/
const CODE = /^[\w-]+$/

export function parseDeepLink(raw: string): DeepLink | undefined {
  const url = URL.parse(raw.trim())
  if (url?.protocol !== `${DEEP_LINKS.scheme}:`) return undefined
  const path = `${url.host}${url.pathname}`.replace(/\/$/, '')
  const [kind, ...rest] = path.split('/')
  const id = rest.join('/')
  if (kind === 'actionable' && ID.test(id)) return { kind: 'actionable', id }
  const code = url.searchParams.get('code') ?? ''
  if (path === 'auth/complete' && CODE.test(code)) return { kind: 'authComplete', code }
}
