import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '@gantry/shared'
import { parseResult } from './result'

export function summarizeTool(input: Record<string, unknown>): string {
  const target = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.description
  return (typeof target === 'string' ? target : JSON.stringify(input)).slice(0, 200)
}

export function toEvents(message: SDKMessage): AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'raw', payload: message }]
  if (message.type === 'system' && message.subtype === 'init') {
    events.push({ type: 'session', sessionId: message.session_id })
  }
  if (message.type === 'assistant' && !message.parent_tool_use_id) {
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text.trim()) events.push({ type: 'message', text: block.text.trim() })
      if (block.type === 'tool_use') {
        events.push({ type: 'tool', name: block.name, summary: summarizeTool(block.input as Record<string, unknown>) })
      }
    }
  }
  if (message.type === 'result') {
    const usage = message.usage
    events.push({
      type: 'usage',
      inputTokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
      outputTokens: usage.output_tokens,
      costUsd: message.total_cost_usd,
    })
    events.push(
      message.subtype === 'success'
        ? { type: 'result', result: parseResult(message.result) }
        : { type: 'error', message: message.errors.join('; ') || message.subtype },
    )
  }
  return events
}
