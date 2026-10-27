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
    ['read_only', ...bash('rg foo src'), 'allow'],
    ['read_only', ...bash('rm -rf src'), 'deny'],
    ['read_only', ...bash('pnpm test'), 'deny'],
    ['read_only', ...bash('echo hi > a.ts'), 'deny'],
    ['read_only', ...bash('cat $(rm a.ts)'), 'deny'],
    ['read_only', ...bash('find . -delete'), 'deny'],
    ['read_only', ...bash('ls; git commit -m x'), 'deny'],
    ['read_only', ...bash('rg --pre ./x.sh foo'), 'deny'],
    ['read_only', ...bash('find . -fprint out'), 'deny'],
    ['read_only', ...bash('git diff --output=p'), 'deny'],
    ['read_only', ...bash('tree -o out'), 'deny'],
    ['read_only', ...bash('grep -o foo a.ts'), 'allow'],
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
    ['edit_test', ...bash('gh api -XPOST repos/o/r/issues'), 'deny'],
    ['full', ...bash('git push --no-verify'), 'deny'],
    ['edit_test', ...bash('git -c core.hooksPath=/dev/null commit'), 'deny'],
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
    expect(decide(preset, WT, tool, input).behavior).toBe(behavior)
  })

  it('tells the agent why it was denied', () => {
    expect(decide('edit_test', WT, ...bash('git push'))).toEqual({ behavior: 'deny', message: expect.stringMatching(/not allowed/) })
  })
})

describe('presetOptions', () => {
  it.each<[PermissionPreset, string, string[]]>([
    ['read_only', 'default', ['Edit', 'Write', 'NotebookEdit']],
    ['edit_test', 'acceptEdits', ['Bash(git push:*)', 'Bash(gh pr create:*)']],
    ['full', 'acceptEdits', []],
  ])('%s → %s mode with deny rules', (preset, mode, disallowed) => {
    const options = presetOptions(preset, WT, guard)
    expect(options.permissionMode).toBe(mode)
    expect(options.disallowedTools).toEqual(disallowed)
  })

  it('denies through the PreToolUse hook so allow rules cannot bypass the preset', async () => {
    const hook = presetOptions('edit_test', WT, guard).hooks!.PreToolUse![0]!.hooks[0] as HookCallback
    const call = (tool_name: string, tool_input: Record<string, unknown>) =>
      hook({ hook_event_name: 'PreToolUse', tool_name, tool_input } as HookInput, undefined, {
        signal: new AbortController().signal,
      })
    expect(await call('Bash', { command: 'git push' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(await call('Read', { file_path: '/etc/passwd' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
    expect(await call('Bash', { command: 'pnpm test' })).toEqual({})
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
