import type { HookCallbackMatcher, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionPreset } from '@gantry/shared'

export type Decision = PermissionResult | { behavior: 'ask' }

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const READ_ONLY_COMMAND =
  /^(ls|cat|head|tail|wc|grep|rg|find|pwd|echo|which|file|stat|tree|du|diff|git (status|log|diff|show|blame|rev-parse|ls-files)|gh (pr|issue|run) (view|list|diff|checks))\b/
const UNSAFE_SHELL = /[`$>]|<\(|-delete\b|-exec\b|-ok\b/
const REMOTE_MUTATION =
  /\bgit\b[^;&|\n]*\spush\b|\bgh\s+(pr|issue|release|repo|gist|workflow|run|secret|variable|label)\s+(create|merge|close|reopen|edit|comment|review|delete|ready|upload|rerun|cancel|set|fork)\b|\bgh\s+api\b.*\s(-X|--method|-f|-F|--field|--raw-field|--input)\b|\b(npm|pnpm|yarn)\s+publish\b/
const FULL_ALLOWED = /\bgit\b[^;&|\n]*\spush\b|\bgh\s+pr\s+create\b/g

const allow: Decision = { behavior: 'allow' }
const ask: Decision = { behavior: 'ask' }
const deny = (message: string): Decision => ({ behavior: 'deny', message })

export function isReadOnlyCommand(command: string): boolean {
  if (UNSAFE_SHELL.test(command)) return false
  return command
    .split(/&&|\|\||[;|&\n]/)
    .map((segment) => segment.trim())
    .every((segment) => !segment || READ_ONLY_COMMAND.test(segment))
}

export function decide(preset: PermissionPreset, toolName: string, input: Record<string, unknown>): Decision {
  if (EDIT_TOOLS.includes(toolName)) {
    return preset === 'read_only' ? deny('Read-only preset: editing files is not allowed. Report findings instead.') : allow
  }
  if (toolName === 'Bash') {
    const command = String(input.command ?? '')
    if (preset === 'read_only') {
      return isReadOnlyCommand(command) ? allow : deny('Read-only preset: only read-only shell commands are allowed.')
    }
    if (preset === 'edit_test') {
      return REMOTE_MUTATION.test(command)
        ? deny('Edit + test preset: pushing, opening PRs and other remote changes are not allowed. Leave changes local.')
        : allow
    }
    return REMOTE_MUTATION.test(command.replace(FULL_ALLOWED, '')) ? ask : allow
  }
  if (toolName.startsWith('mcp__')) return ask
  return allow
}

export function presetOptions(preset: PermissionPreset): Pick<Options, 'permissionMode' | 'disallowedTools' | 'hooks'> {
  const denyGuard: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {}
        const decision = decide(preset, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>)
        if (decision.behavior !== 'deny') return {}
        return {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.message },
        }
      },
    ],
  }
  return {
    permissionMode: preset === 'read_only' ? 'default' : 'acceptEdits',
    disallowedTools: preset === 'read_only' ? EDIT_TOOLS : preset === 'edit_test' ? ['Bash(git push:*)', 'Bash(gh pr create:*)'] : [],
    hooks: { PreToolUse: [denyGuard] },
  }
}
