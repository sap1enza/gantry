import type { DispatchRequest, PermissionPreset } from '@gantry/shared'
import { execFile } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

export interface Guard {
  commonDir: string
  hooksDir: string
  ghConfigDir: string
  worktreeConfig: string
}

const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

export function scrubEnv(env: NodeJS.ProcessEnv, preset: PermissionPreset, guard: Guard): NodeJS.ProcessEnv {
  if (preset === 'full') return env
  const scrubbed: NodeJS.ProcessEnv = { ...env, GH_CONFIG_DIR: guard.ghConfigDir }
  for (const name of TOKEN_VARS) delete scrubbed[name]
  return scrubbed
}

export const prePushHook = (preset: PermissionPreset, branch: string, originalHooks: string) => `#!/bin/sh
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

const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)('git', ['-C', cwd, ...args])).stdout.trim()

export async function installGuard(request: DispatchRequest): Promise<Guard> {
  const cwd = request.worktreePath
  const gitDir = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir')
  const commonDir = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if ((await git(cwd, 'config', '--get', 'extensions.worktreeConfig').catch(() => '')) !== 'true') {
    await git(cwd, 'config', 'extensions.worktreeConfig', 'true')
  }
  await git(cwd, 'config', '--worktree', '--unset', 'core.hooksPath').catch(() => '')
  const originalHooks = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks')
  const hooksDir = join(gitDir, 'gantry-hooks')
  rmSync(hooksDir, { recursive: true, force: true })
  mkdirSync(hooksDir, { recursive: true })
  const existing = existsSync(originalHooks) ? readdirSync(originalHooks) : []
  for (const name of existing.filter((name) => name !== 'pre-push' && isExecutable(join(originalHooks, name)))) {
    writeFileSync(join(hooksDir, name), `#!/bin/sh\nexec ${shellQuote(join(originalHooks, name))} "$@"\n`)
    chmodSync(join(hooksDir, name), 0o755)
  }
  writeFileSync(join(hooksDir, 'pre-push'), prePushHook(request.permissionPreset, request.branch, originalHooks))
  chmodSync(join(hooksDir, 'pre-push'), 0o755)
  await git(cwd, 'config', '--worktree', 'core.hooksPath', hooksDir)
  const ghConfigDir = join(gitDir, 'gantry-gh')
  mkdirSync(ghConfigDir, { recursive: true })
  return { commonDir, hooksDir, ghConfigDir, worktreeConfig: join(gitDir, 'config.worktree') }
}
