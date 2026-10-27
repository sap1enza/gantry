import type { Actionable, Repository } from '@gantry/shared'

export function parseRemote(url: string): string | undefined {
  const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : undefined
}

export function findRepository(repos: Repository[], name?: string) {
  const wanted = name?.toLowerCase()
  return wanted ? repos.find((r) => r.remote.toLowerCase() === wanted) : undefined
}

export function inferRepository(a: Pick<Actionable, 'repository' | 'links'>, repos: Repository[]) {
  const names = [a.repository, ...a.links.map((l) => /github\.com\/([\w.-]+\/[\w.-]+)/.exec(l.url)?.[1])]
  for (const name of names) {
    const repo = findRepository(repos, name)
    if (repo) return repo
  }
  return undefined
}
