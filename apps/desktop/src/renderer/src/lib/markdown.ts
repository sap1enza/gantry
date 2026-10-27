export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }

export type Block =
  | { t: 'p' | 'quote'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] }
  | { t: 'pre'; v: string }

const DANGEROUS_BLOCK = /<(script|style|iframe|object)\b[\s\S]*?(<\/\1\s*>|$)/gi

const stripHtml = (s: string) =>
  s
    .replace(DANGEROUS_BLOCK, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')

const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined)

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?![\w*])|(https?:\/\/[^\s<)]+)/

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let rest = src
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) {
      out.push({ t: 'text', v: rest })
      break
    }
    if (m.index) out.push({ t: 'text', v: rest.slice(0, m.index) })
    const [, code, strong, label, href, em, auto] = m
    if (code !== undefined) out.push({ t: 'code', v: code })
    else if (strong !== undefined) out.push({ t: 'strong', c: parseInline(strong) })
    else if (label !== undefined) {
      const safe = safeHref(href!)
      out.push(safe ? { t: 'link', href: safe, c: parseInline(label) } : { t: 'text', v: label })
    } else if (em !== undefined) out.push({ t: 'em', c: parseInline(em) })
    else out.push({ t: 'link', href: auto!, c: [{ t: 'text', v: auto! }] })
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.replace(/\r\n?/g, '\n').replace(DANGEROUS_BLOCK, '').split('\n')
  let para: string[] = []
  const flush = () => {
    const text = stripHtml(para.join(' ')).trim()
    if (text) blocks.push({ t: 'p', c: parseInline(text) })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('```')) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i]!)
      blocks.push({ t: 'pre', v: code.join('\n') })
      continue
    }
    const clean = stripHtml(line)
    const heading = /^(#{1,6})\s+(.*)$/.exec(clean)
    const list = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(clean)
    if (!clean.trim()) flush()
    else if (heading) {
      flush()
      blocks.push({ t: 'h', level: heading[1]!.length, c: parseInline(heading[2]!) })
    } else if (list) {
      flush()
      const kind = /\d/.test(list[1]!) ? 'ol' : 'ul'
      const prev = blocks.at(-1)
      const item = parseInline(list[2]!)
      if (prev?.t === kind) prev.items.push(item)
      else blocks.push({ t: kind, items: [item] })
    } else if (clean.startsWith('>')) {
      flush()
      blocks.push({ t: 'quote', c: parseInline(clean.replace(/^>\s?/, '')) })
    } else para.push(clean)
  }
  flush()
  return blocks
}
