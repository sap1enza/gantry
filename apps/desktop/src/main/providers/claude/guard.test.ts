import type { DispatchRequest, PermissionPreset } from '@gantry/shared'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installGuard, scrubEnv, type Guard } from './guard'

const BRANCH = 'gantry/GT-1-fix'

async function repo(preset: PermissionPreset) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gantry-guard-')))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: 'pipe' })
  const main = join(root, 'repo')
  const worktreePath = join(root, 'wt')
  git(root, 'init', '-q', '--bare', 'remote.git')
  git(root, 'init', '-q', '-b', 'main', 'repo')
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(main, 'remote', 'add', 'origin', '../remote.git')
  git(main, 'push', '-q', 'origin', 'main')
  git(main, 'worktree', 'add', '-q', '-b', BRANCH, worktreePath)
  const request = { worktreePath, branch: BRANCH, permissionPreset: preset } as DispatchRequest
  const guard = await installGuard(request)
  const push = (...args: string[]) => {
    try {
      git(worktreePath, 'push', '-q', 'origin', ...args)
      return 'ok'
    } catch (error) {
      return String((error as { stderr: string }).stderr)
    }
  }
  return { git, main, worktreePath, guard, request, push }
}

describe('pre-push hook', () => {
  it('allows only fast-forward pushes to the card branch in full', async () => {
    const { git, worktreePath, push } = await repo('full')
    git(worktreePath, 'commit', '-q', '--allow-empty', '-m', 'a')
    expect(push(`HEAD:refs/heads/${BRANCH}`)).toBe('ok')
    expect(push('HEAD:refs/heads/other')).toMatch(/only refs\/heads\/gantry\/GT-1-fix may be pushed/)
    expect(push(':refs/heads/main')).toMatch(/only refs\/heads\/gantry\/GT-1-fix may be pushed/)
    expect(push(`:refs/heads/${BRANCH}`)).toMatch(/deleting remote branches is not allowed/)
    git(worktreePath, 'reset', '-q', '--hard', 'HEAD~1')
    git(worktreePath, 'commit', '-q', '--allow-empty', '-m', 'b')
    expect(push('-f', `HEAD:refs/heads/${BRANCH}`)).toMatch(/force pushes are not allowed/)
  })

  it.each<PermissionPreset>(['read_only', 'edit_test'])('rejects every push in %s', async (preset) => {
    const { push } = await repo(preset)
    expect(push(`HEAD:refs/heads/${BRANCH}`)).toMatch(/pushing is not allowed/)
  })

  it('keeps the repo hooks and is idempotent across dispatches', async () => {
    const { git, main, worktreePath, request, push } = await repo('full')
    const marker = join(worktreePath, 'pre-commit-ran')
    writeFileSync(join(main, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`)
    chmodSync(join(main, '.git/hooks/pre-commit'), 0o755)
    writeFileSync(join(main, '.git/hooks/pre-push'), '#!/bin/sh\necho repo hook says no >&2\nexit 1\n')
    chmodSync(join(main, '.git/hooks/pre-push'), 0o755)
    await installGuard(request)
    git(worktreePath, 'commit', '-q', '--allow-empty', '-m', 'a')
    expect(existsSync(marker)).toBe(true)
    expect(push(`HEAD:refs/heads/${BRANCH}`)).toMatch(/repo hook says no/)
    expect(git(main, 'rev-parse', '--git-path', 'hooks').trim()).toBe('.git/hooks')
  })
})

describe('scrubEnv', () => {
  const guard = { ghConfigDir: '/wt/.git/gantry-gh' } as Guard
  const env = { PATH: '/bin', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_ENTERPRISE_TOKEN: 'c' }

  it.each<PermissionPreset>(['read_only', 'edit_test'])('drops GitHub credentials in %s', (preset) => {
    expect(scrubEnv(env, preset, guard)).toEqual({ PATH: '/bin', GH_CONFIG_DIR: '/wt/.git/gantry-gh' })
  })

  it('keeps credentials in full', () => {
    expect(scrubEnv(env, 'full', guard)).toEqual(env)
  })
})
