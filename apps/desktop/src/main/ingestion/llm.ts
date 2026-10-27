import type { Settings } from '@gantry/shared'

export interface Verdict {
  decision: boolean
  reason: string
}

const MAX_CONTENT = 12_000
const FORMAT = 'Respond with only a JSON object: {"decision": true or false, "reason": "<one short sentence>"}.'

export async function classify(
  llm: Settings['llm'],
  apiKey: string | undefined,
  instruction: string,
  content: string,
): Promise<Verdict> {
  if (!apiKey) return { decision: false, reason: 'No LLM API key configured (Preferences › AI)' }
  const system = `${instruction}\n${FORMAT}`
  const user = content.slice(0, MAX_CONTENT)
  const text = llm.provider === 'anthropic' ? await anthropic(llm.model, apiKey, system, user) : await openai(llm, apiKey, system, user)
  return parseVerdict(text)
}

export function parseVerdict(text: string): Verdict {
  try {
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? '') as { decision?: unknown; reason?: unknown }
    return { decision: parsed.decision === true, reason: String(parsed.reason ?? '') }
  } catch {
    return { decision: false, reason: `Unparseable LLM response: ${text.slice(0, 120)}` }
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`)
  return res.json()
}

async function anthropic(model: string, apiKey: string, system: string, user: string) {
  const res = (await post(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: 300, system, messages: [{ role: 'user', content: user }] },
  )) as { content: { type: string; text?: string }[] }
  return res.content.find((c) => c.type === 'text')?.text ?? ''
}

async function openai(llm: Settings['llm'], apiKey: string, system: string, user: string) {
  const base = llm.provider === 'openai' ? 'https://api.openai.com/v1' : (llm.baseUrl ?? '').replace(/\/$/, '')
  const res = (await post(
    `${base}/chat/completions`,
    { authorization: `Bearer ${apiKey}` },
    {
      model: llm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(llm.provider === 'openai' && { response_format: { type: 'json_object' } }),
    },
  )) as { choices: { message: { content: string } }[] }
  return res.choices[0]?.message.content ?? ''
}
