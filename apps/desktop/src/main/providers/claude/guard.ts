import type { DispatchRequest, PermissionPreset } from '@gantry/shared'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exec, git, type Exec } from '../../system/exec'

export interface Guard {
  commonDir: string
  hooksDir: string
  ghConfigDir: string
  worktreeConfig: string
  release: () => Promise<void>
}

const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

export function scrubEnv(env: NodeJS.ProcessEnv, preset: PermissionPreset, guard: Guard): NodeJS.ProcessEnv {
  if (preset === 'full') return env
  const scrubbed: NodeJS.ProcessEnv = { ...env, GH_CONFIG_DIR: guard.ghConfigDir }
  for (const name of TOKEN_VARS) delete scrubbed[name]
  return scrubbed
}

// shortcut: in full, `git push --no-verify` or `-c core.hooksPath=` skips this hook and only policy.ts's HOOK_BYPASS regex stops it; upgrade to a credential-holding push proxy if that matters.
export const prePushHook =(preset: PermissionPreset, branch: string, originalHooks: string) => `#!/bin/sh
preset=${shellQuote(preset)}
branch=${shellQuote(branch)}
if [ "$preset" != full ]; then
  echo "Gantry: pushing is not allowed in the $preset preset." >&2
  exit 1
fi
input=$(cat)
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "$local_ref" ] && continue
  if [ "$remote_ref" != "refs/heads/$branch" ]; then
    echo "Gantry: only refs/heads/$branch may be pushed, not $remote_ref." >&2
    exit 1
  fi
  case "$local_sha" in *[!0]*) ;; *)
    echo "Gantry: deleting remote branches is not allowed." >&2
    exit 1 ;;
  esac
  case "$remote_sha" in *[!0]*)
    if ! git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
      echo "Gantry: the remote branch has commits you don't have; fetch and rebase first." >&2
      exit 1
    fi
    if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
      echo "Gantry: force pushes are not allowed." >&2
      exit 1
    fi ;;
  esac
done <<EOF
$input
EOF
if [ -x ${shellQuote(join(originalHooks, 'pre-push'))} ]; then
  printf '%s\\n' "$input" | ${shellQuote(join(originalHooks, 'pre-push'))} "$@"
  exit $?
fi
`

export const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function installGuard(request: DispatchRequest, run: Exec = exec): Promise<Guard> {
  const cwd = request.worktreePath
  const out = async (...args: string[]) => {
    const { code, output } = await git(run, cwd, ...args)
    if (code) throw new Error(`git ${args.join(' ')} failed: ${output.trim()}`)
    return output.trim()
  }
  const [gitDir, commonDir] = (await out('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir')).split('\n')
  if ((await git(run, cwd, 'config', '--get', 'extensions.worktreeConfig')).output.trim() !== 'true') {
    await out('config', 'extensions.worktreeConfig', 'true')
  }
  const unsetHooksPath = async () => void (await git(run, cwd, 'config', '--worktree', '--unset', 'core.hooksPath'))
  await unsetHooksPath()
  const originalHooks = await out('rev-parse', '--path-format=absolute', '--git-path', 'hooks')
  const hooksDir = join(gitDir!, 'gantry-hooks')
  rmSync(hooksDir, { recursive: true, force: true })
  mkdirSync(hooksDir, { recursive: true })
  const existing = existsSync(originalHooks) ? readdirSync(originalHooks) : []
  for (const name of existing.filter((name) => name !== 'pre-push' && isExecutable(join(originalHooks, name)))) {
    writeFileSync(join(hooksDir, name), `#!/bin/sh\nexec ${shellQuote(join(originalHooks, name))} "$@"\n`)
    chmodSync(join(hooksDir, name), 0o755)
  }
  writeFileSync(join(hooksDir, 'pre-push'), prePushHook(request.permissionPreset, request.branch, originalHooks))
  chmodSync(join(hooksDir, 'pre-push'), 0o755)
  await out('config', '--worktree', 'core.hooksPath', hooksDir)
  const ghConfigDir = join(gitDir!, 'gantry-gh')
  mkdirSync(ghConfigDir, { recursive: true })
  return {
    commonDir: commonDir!,
    hooksDir,
    ghConfigDir,
    worktreeConfig: join(gitDir!, 'config.worktree'),
    release: unsetHooksPath,
  }
}
