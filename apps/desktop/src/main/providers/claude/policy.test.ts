import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionPreset } from '@gantry/shared'
import { describe, expect, it } from 'vitest'
import type { Guard } from './guard'
import { decide, presetOptions, sandboxFor } from './policy'

const WT = '/code/wt'
const guard: Guard = {
  commonDir: '/code/repo/.git',
  hooksDir: '/g/hooks',
  ghConfigDir: '/g/gh',
  worktreeConfig: '/g/config.worktree',
  release: async () => {},
}

const bash = (command: string) => ['Bash', { command }] as const

describe('decide', () => {
  it.each<[PermissionPreset, string, Record<string, unknown>, 'allow' | 'deny' | 'ask']>([
    ['read_only', 'Read', { file_path: 'a.ts' }, 'allow'],
    ['read_only', 'Edit', { file_path: 'a.ts' }, 'deny'],
    ['read_only', 'Write', { file_path: 'a.ts' }, 'deny'],
    ['read_only', 'NotebookEdit', {}, 'deny'],
    ['read_only', ...bash('git status && git log -5 | head'), 'allow'],
    ['read_only', ...bash('rm -rf src'), 'deny'],
    ['read_only', ...bash('cat $(rm a.ts)'), 'deny'],
    ['read_only', ...bash('osascript -e x'), 'deny'],
    ['edit_test', ...bash('git commit --no-verify -m x'), 'deny'],
    ['edit_test', ...bash('pnpm publish'), 'deny'],
    ['full', ...bash('npm publish --access public'), 'ask'],
    ['read_only', 'Skill', {}, 'deny'],
    ['read_only', 'Agent', { prompt: 'explore' }, 'allow'],
    ['read_only', 'Glob', { pattern: '~/.ssh/*' }, 'ask'],
    ['read_only', 'Glob', { pattern: 'src/**/*.ts' }, 'allow'],
    ['full', ...bash('git config extensions.worktreeConfig false && git push'), 'deny'],
    ['read_only', 'Read', { file_path: '/Users/me/.aws/credentials' }, 'ask'],
    ['read_only', 'Read', { file_path: '~/.aws/credentials' }, 'ask'],
    ['read_only', 'Grep', { pattern: 'x', path: '../other' }, 'ask'],
    ['read_only', 'Glob', { pattern: '*', path: `${WT}/src` }, 'allow'],
    ['read_only', 'WebFetch', { url: 'https://x.dev' }, 'ask'],
    ['edit_test', 'WebSearch', { query: 'x' }, 'ask'],
    ['full', 'WebFetch', { url: 'https://x.dev' }, 'allow'],
    ['full', 'Edit', { file_path: '/etc/hosts' }, 'ask'],
    ['full', ...bash('git push --no-verify'), 'deny'],
    ['full', ...bash('git -c core.hooksPath=/dev/null push'), 'deny'],
    ['edit_test', 'Edit', { file_path: 'a.ts' }, 'allow'],
    ['edit_test', ...bash('git commit -m "fix push"'), 'allow'],
    ['edit_test', ...bash('gh pr merge 3'), 'allow'],
    ['full', ...bash('git commit -m "fix push"'), 'allow'],
    ['full', ...bash('gh api -XPOST repos/o/r/issues'), 'ask'],
    ['full', ...bash('gh api repos/o/r/issues -f title=x'), 'ask'],
    ['full', ...bash('gh pr view 3'), 'allow'],
    ['edit_test', 'mcp__linear__create_issue', {}, 'ask'],
    ['full', ...bash('git push -u origin HEAD && gh pr create --fill'), 'allow'],
    ['full', ...bash('gh pr merge 3'), 'ask'],
    ['full', ...bash('git push && gh release create v1'), 'ask'],
    ['full', 'Write', { file_path: 'a.ts' }, 'allow'],
  ])('%s %s %j → %s', (preset, tool, input, behavior) => {
    expect(decide(preset, WT, tool, input).behavior).toBe(behavior)
  })

  it('tells the agent why it was denied', () => {
    expect(decide('full', WT, ...bash('git push --no-verify'))).toEqual({ behavior: 'deny', message: expect.stringMatching(/not allowed/) })
  })
})

describe('presetOptions', () => {
  it.each<[PermissionPreset, string, string[]]>([
    ['read_only', 'default', ['Edit', 'Write', 'NotebookEdit']],
    ['edit_test', 'acceptEdits', ['Bash(git push:*)', 'Bash(gh pr create:*)']],
    ['full', 'acceptEdits', []],
  ])('%s → %s mode with deny rules', (preset, mode, disallowed) => {
    const options = presetOptions(preset, WT, guard, new Set())
    expect(options.permissionMode).toBe(mode)
    expect(options.disallowedTools).toEqual(disallowed)
  })

  it('decides in the PreToolUse hook so allow rules cannot bypass the preset, recording calls that need approval', async () => {
    const approvals = new Set<string>()
    const hook = presetOptions('read_only', WT, guard, approvals).hooks!.PreToolUse![0]!.hooks[0] as HookCallback
    const call = (tool_use_id: string, tool_name: string, tool_input: Record<string, unknown>) =>
      hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id } as HookInput, tool_use_id, {
        signal: new AbortController().signal,
      })
    expect(await call('1', 'Skill', {})).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(await call('2', 'Read', { file_path: '/etc/passwd' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
    expect(await call('3', 'Bash', { command: 'ls' })).toEqual({})
    expect([...approvals]).toEqual(['2'])
  })
})

describe('sandboxFor', () => {
  const guarded = [guard.hooksDir, guard.ghConfigDir, guard.worktreeConfig, '/code/repo/.git/config']

  it('enforces the sandbox with no escape hatch in every preset', () => {
    for (const preset of ['read_only', 'edit_test', 'full'] as const) {
      expect(sandboxFor(preset, WT, guard)).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
      expect(sandboxFor(preset, WT, guard).filesystem!.denyRead).toContain('~/.aws')
    }
  })

  it('read_only: no writes to the worktree or repo and no network', () => {
    expect(sandboxFor('read_only', WT, guard)).toMatchObject({
      filesystem: { denyWrite: [WT, guard.commonDir, ...guarded] },
      network: { allowedDomains: [], strictAllowlist: true },
    })
  })

  it('edit_test: worktree writes and package registries only', () => {
    const sandbox = sandboxFor('edit_test', WT, guard)
    expect(sandbox.filesystem!.denyWrite).toEqual(guarded)
    expect(sandbox.network).toMatchObject({ strictAllowlist: true, allowedDomains: expect.arrayContaining(['registry.npmjs.org']) })
    expect(sandbox.network!.allowedDomains).not.toContain('github.com')
  })

  it('full: any host, with git network commands outside the sandbox', () => {
    expect(sandboxFor('full', WT, guard)).toMatchObject({
      filesystem: { denyWrite: guarded },
      network: { allowedDomains: ['*'] },
      excludedCommands: ['git push', 'git push *', 'git fetch *', 'git pull *', 'gh *'],
    })
  })
})
