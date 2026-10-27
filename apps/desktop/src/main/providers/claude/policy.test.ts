import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionPreset } from '@gantry/shared'
import { describe, expect, it } from 'vitest'
import { decide, presetOptions } from './policy'

const bash = (command: string) => ['Bash', { command }] as const

describe('decide', () => {
  it.each<[PermissionPreset, string, Record<string, unknown>, 'allow' | 'deny' | 'ask']>([
    ['read_only', 'Read', { file_path: 'a.ts' }, 'allow'],
    ['read_only', 'Edit', { file_path: 'a.ts' }, 'deny'],
    ['read_only', 'Write', { file_path: 'a.ts' }, 'deny'],
    ['read_only', 'NotebookEdit', {}, 'deny'],
    ['read_only', ...bash('git status && git log -5 | head'), 'allow'],
    ['read_only', ...bash('rg foo src'), 'allow'],
    ['read_only', ...bash('rm -rf src'), 'deny'],
    ['read_only', ...bash('pnpm test'), 'deny'],
    ['read_only', ...bash('echo hi > a.ts'), 'deny'],
    ['read_only', ...bash('cat $(rm a.ts)'), 'deny'],
    ['read_only', ...bash('find . -delete'), 'deny'],
    ['read_only', ...bash('ls; git commit -m x'), 'deny'],
    ['edit_test', 'Edit', { file_path: 'a.ts' }, 'allow'],
    ['edit_test', ...bash('pnpm test && git commit -am fix'), 'allow'],
    ['edit_test', ...bash('git push origin HEAD'), 'deny'],
    ['edit_test', ...bash('git -C repo push'), 'deny'],
    ['edit_test', ...bash('pnpm test && git push'), 'deny'],
    ['edit_test', ...bash('gh pr create --fill'), 'deny'],
    ['edit_test', ...bash('gh pr merge 3'), 'deny'],
    ['edit_test', ...bash('gh api repos/o/r/issues -f title=x'), 'deny'],
    ['edit_test', ...bash('gh pr view 3'), 'allow'],
    ['edit_test', 'mcp__linear__create_issue', {}, 'ask'],
    ['full', ...bash('git push -u origin HEAD && gh pr create --fill'), 'allow'],
    ['full', ...bash('gh pr merge 3'), 'ask'],
    ['full', ...bash('git push && gh release create v1'), 'ask'],
    ['full', 'Write', { file_path: 'a.ts' }, 'allow'],
  ])('%s %s %j → %s', (preset, tool, input, behavior) => {
    expect(decide(preset, tool, input).behavior).toBe(behavior)
  })

  it('tells the agent why it was denied', () => {
    expect(decide('edit_test', ...bash('git push'))).toEqual({ behavior: 'deny', message: expect.stringMatching(/not allowed/) })
  })
})

describe('presetOptions', () => {
  it.each<[PermissionPreset, string, string[]]>([
    ['read_only', 'default', ['Edit', 'Write', 'NotebookEdit']],
    ['edit_test', 'acceptEdits', ['Bash(git push:*)', 'Bash(gh pr create:*)']],
    ['full', 'acceptEdits', []],
  ])('%s → %s mode with deny rules', (preset, mode, disallowed) => {
    const options = presetOptions(preset)
    expect(options.permissionMode).toBe(mode)
    expect(options.disallowedTools).toEqual(disallowed)
  })

  it('denies through the PreToolUse hook so allow rules cannot bypass the preset', async () => {
    const hook = presetOptions('edit_test').hooks!.PreToolUse![0]!.hooks[0] as HookCallback
    const call = (command: string) =>
      hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as HookInput, undefined, {
        signal: new AbortController().signal,
      })
    expect(await call('git push')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(await call('pnpm test')).toEqual({})
  })
})
