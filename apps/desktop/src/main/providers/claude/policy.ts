import type { HookCallbackMatcher, Options, PermissionResult, SandboxSettings } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionPreset } from '@gantry/shared'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Guard } from './guard'

export type Decision = PermissionResult | { behavior: 'ask' }

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'TodoWrite', 'ToolSearch']
const PATH_KEYS = ['file_path', 'notebook_path', 'path']
const WEB_TOOLS = ['WebFetch', 'WebSearch']
const READ_ONLY_COMMAND =
  /^(ls|cat|head|tail|wc|grep|rg|find|pwd|echo|which|file|stat|tree|du|diff|git (status|log|diff|show|blame|rev-parse|ls-files)|gh (pr|issue|run) (view|list|diff|checks))\b/
const UNSAFE_SHELL = /[`$>]|<\(|-delete\b|-exec\b|-ok\b|-fprint|--pre\b|--output\b|\btree\b.*\s-o\b/
const REMOTE_MUTATION =
  /\bgit\b[^;&|\n]*\spush\b|\bgh\s+(pr|issue|release|repo|gist|workflow|run|secret|variable|label)\s+(create|merge|close|reopen|edit|comment|review|delete|ready|upload|rerun|cancel|set|fork)\b|\bgh\s+api\b.*\s(-X|--method|-f|-F|--field|--raw-field|--input)|\b(npm|pnpm|yarn)\s+publish\b/
const HOOK_BYPASS = /--no-verify\b|\bcore\.hookspath\b/i
const FULL_ALLOWED = /\bgit\b[^;&|\n]*\spush\b|\bgh\s+pr\s+create\b/g
const PACKAGE_REGISTRIES = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'rubygems.org',
  'index.rubygems.org',
  'proxy.golang.org',
  'sum.golang.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
]
const SECRET_PATHS = ['~/.aws', '~/.ssh', '~/.gnupg', '~/.netrc', '~/.config/gh', '~/.docker', '~/.kube']

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

export function isOutside(worktreePath: string, input: Record<string, unknown>): boolean {
  return PATH_KEYS.some((key) => {
    if (typeof input[key] !== 'string') return false
    const path = resolve(worktreePath, (input[key] as string).replace(/^~(?=$|\/)/, homedir()))
    const inside = relative(worktreePath, path)
    return inside.startsWith('..') || isAbsolute(inside)
  })
}

export function decide(preset: PermissionPreset, worktreePath: string, toolName: string, input: Record<string, unknown>): Decision {
  if (toolName.startsWith('mcp__')) return ask
  if (preset === 'read_only' && !READ_ONLY_TOOLS.includes(toolName)) {
    return deny(`Read-only preset: ${toolName} is not allowed. Report findings instead.`)
  }
  if (isOutside(worktreePath, input)) return ask
  if (WEB_TOOLS.includes(toolName)) return preset === 'full' ? allow : ask
  if (toolName !== 'Bash') return allow
  const command = String(input.command ?? '')
  if (HOOK_BYPASS.test(command)) return deny('Bypassing git hooks is not allowed.')
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

export function sandboxFor(preset: PermissionPreset, worktreePath: string, guard: Guard): SandboxSettings {
  const guardPaths = [guard.hooksDir, guard.ghConfigDir, guard.worktreeConfig]
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      denyWrite: preset === 'read_only' ? [worktreePath, guard.commonDir, ...guardPaths] : guardPaths,
      denyRead: SECRET_PATHS,
    },
    network:
      preset === 'full'
        ? { allowedDomains: ['*'] }
        : { allowedDomains: preset === 'edit_test' ? PACKAGE_REGISTRIES : [], strictAllowlist: true },
    ...(preset === 'full' && { excludedCommands: ['git push *', 'git fetch *', 'git pull *'] }),
  }
}

export function presetOptions(
  preset: PermissionPreset,
  worktreePath: string,
  guard: Guard,
): Pick<Options, 'permissionMode' | 'disallowedTools' | 'hooks' | 'sandbox'> {
  const guardHook: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {}
        const decision = decide(preset, worktreePath, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>)
        if (decision.behavior === 'allow') return {}
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.behavior,
            permissionDecisionReason: decision.behavior === 'deny' ? decision.message : 'Needs the user’s approval.',
          },
        }
      },
    ],
  }
  return {
    permissionMode: preset === 'read_only' ? 'default' : 'acceptEdits',
    disallowedTools: preset === 'read_only' ? EDIT_TOOLS : preset === 'edit_test' ? ['Bash(git push:*)', 'Bash(gh pr create:*)'] : [],
    hooks: { PreToolUse: [guardHook] },
    sandbox: sandboxFor(preset, worktreePath, guard),
  }
}
