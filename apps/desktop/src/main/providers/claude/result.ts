import { RESULT_BLOCK_TAG, type AgentResult } from '@gantry/shared'

const RESULT_BLOCK = new RegExp(`\`\`\`${RESULT_BLOCK_TAG}[^\\n]*\\n([\\s\\S]*?)\`\`\``, 'g')

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
const texts = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

export function parseResult(finalText: string): AgentResult {
  const fallback: AgentResult = { summary: finalText.trim(), filesChanged: [], openQuestions: [] }
  const block = [...finalText.matchAll(RESULT_BLOCK)].at(-1)
  if (!block) return fallback
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(block[1] ?? '')
  } catch {
    return fallback
  }
  const summary = text(parsed?.summary)
  if (!summary) return fallback
  return {
    summary,
    filesChanged: texts(parsed.filesChanged),
    branch: text(parsed.branch),
    prUrl: text(parsed.prUrl),
    testsRun: text(parsed.testsRun),
    openQuestions: texts(parsed.openQuestions),
  }
}
