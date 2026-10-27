import { COMPLETION_INSTRUCTIONS, TAGS } from '@gantry/shared'
import { describe, expect, it } from 'vitest'
import { flush, setup, signal } from '../domain/testing'
import { expandHome, slugify } from './runner'

const card = (s: ReturnType<typeof setup>, n = 1) =>
  s.board.ingest(signal({ externalKey: `https://github.com/acme/api/pull/${n}`, title: `Fix CI ${n}` })).actionableId!

async function started(s: ReturnType<typeof setup>, n = 1) {
  const id = card(s, n)
  await s.runner.start(id)
  await flush()
  return id
}

describe('dispatch preview', () => {
  it('infers the repository from GitHub links and builds instructions with context and contract', async () => {
    const s = setup()
    const preview = await s.runner.preview(card(s))
    expect(preview).toMatchObject({ repository: 'acme/api', mustConfirm: false, fullPresetAvailable: true, provider: 'claude', model: 'sonnet' })
    expect(preview.instructions).toContain('# Fix CI 1')
    expect(preview.instructions).toContain('PR diff summary')
    expect(preview.instructions.endsWith(COMPLETION_INSTRUCTIONS)).toBe(true)
  })

  it('must confirm when the repository is unknown and disables Full without gh auth', async () => {
    const s = setup()
    s.execResults['gh auth status'] = { code: 1, output: 'not logged in' }
    const id = s.board.create({ title: 'Manual task' }).id
    expect(await s.runner.preview(id)).toMatchObject({ repository: undefined, mustConfirm: true, fullPresetAvailable: false })
    await expect(s.runner.start(id)).rejects.toThrow(/repository/)
    await expect(s.runner.start(card(s), { permissionPreset: 'full' })).rejects.toThrow(/gh auth/)
  })
})

describe('worktrees', () => {
  it('creates the worktree from the default branch and runs the setup command', async () => {
    const s = setup()
    s.repos.setSetupCommand(s.repo.id, 'pnpm i')
    const id = await started(s)
    const path = '/Users/me/Developer/Gantry/GT-001-fix-ci-1'
    expect(s.execCalls).toContainEqual(['git', '-C', '/code/api', 'worktree', 'add', path, '-b', 'gantry/GT-001-fix-ci-1', 'main'])
    expect(s.execCalls.at(-1)).toEqual([process.env.SHELL ?? '/bin/zsh', '-lc', 'pnpm i', `cwd=${path}`])
    expect(s.provider.requests[0]).toMatchObject({ worktreePath: path, branch: 'gantry/GT-001-fix-ci-1', resumeSessionId: undefined })
    expect(s.board.transcript(id).map((e) => e.event.type)).toEqual(['tool'])
  })

  it('fails the dispatch before the agent starts when setup exits non-zero', async () => {
    const s = setup()
    s.repos.setSetupCommand(s.repo.id, 'false')
    s.execResults['-lc false'] = { code: 2, output: 'boom' }
    const id = await started(s)
    expect(s.provider.requests).toHaveLength(0)
    expect(s.board.must(id)).toMatchObject({ column: 'review', agentState: 'failed', error: 'Setup command exited with code 2' })
    expect(s.board.must(id).tags).toContain(TAGS.failed)
  })

  it('reuses the recorded worktree after Stop', async () => {
    const s = setup()
    const id = await started(s)
    await s.runner.stop(id)
    expect(s.board.must(id)).toMatchObject({ column: 'todo', agentState: 'stopped' })
    expect(s.board.must(id).tags).toContain(TAGS.stopped)
    await s.runner.start(id)
    await flush()
    expect(s.execCalls.filter((c) => c.includes('add'))).toHaveLength(1)
    expect(s.provider.requests[1]!.worktreePath).toBe(s.provider.requests[0]!.worktreePath)
    expect(s.provider.requests[1]!.dispatchId).not.toBe(s.provider.requests[0]!.dispatchId)
    expect(s.board.must(id).tags).not.toContain(TAGS.stopped)
  })

  it('cleanup on Done removes only the recorded worktree path', async () => {
    const s = setup()
    const id = await started(s)
    s.provider.emit(id, { type: 'result', result: { summary: 'ok', filesChanged: [], openQuestions: [] } })
    const before = s.execCalls.length
    await s.runner.done(id, 'delete')
    const path = s.board.must(id).dispatch!.worktreePath
    expect(s.execCalls.slice(before)).toEqual([['git', '-C', '/code/api', 'worktree', 'remove', path]])
    expect(s.board.must(id).column).toBe('done')
  })

  it('keeps the worktree when cleanup is keep', async () => {
    const s = setup()
    const id = await started(s)
    s.provider.emit(id, { type: 'state', state: 'completed' })
    const before = s.execCalls.length
    await s.runner.done(id, 'keep')
    expect(s.execCalls.slice(before)).toEqual([])
  })
})

describe('concurrency', () => {
  it('queues beyond the limit and auto-starts when a slot frees', async () => {
    const s = setup()
    s.settings.update({ maxConcurrentAgents: 1 })
    const a = await started(s, 1)
    const b = await started(s, 2)
    expect(s.board.must(a).agentState).toBe('running')
    expect(s.board.must(b)).toMatchObject({ agentState: 'queued', column: 'in_progress' })
    expect(s.board.must(b).tags).toContain(TAGS.queued)
    expect(s.provider.requests).toHaveLength(1)
    s.provider.emit(a, { type: 'error', message: 'crashed' })
    await flush()
    expect(s.board.must(b).agentState).toBe('running')
    expect(s.board.must(b).tags).not.toContain(TAGS.queued)
    expect(s.provider.requests.map((r) => r.actionableId)).toEqual([a, b])
  })

  it('queues a resume when no slot is free and resumes the session when one frees', async () => {
    const s = setup()
    s.settings.update({ maxConcurrentAgents: 1 })
    const a = await started(s, 1)
    s.provider.emit(a, { type: 'session', sessionId: 's-1' })
    await s.runner.pause(a)
    const b = await started(s, 2)
    await s.runner.resume(a, 'go on')
    expect(s.board.must(a)).toMatchObject({ agentState: 'queued', tags: expect.arrayContaining([TAGS.queued]) })
    expect(s.provider.calls).toEqual([`pause:${a}`])
    s.provider.emit(b, { type: 'state', state: 'completed' })
    await flush()
    expect(s.board.must(a).agentState).toBe('running')
    expect(s.provider.requests.at(-1)).toMatchObject({ actionableId: a, resumeSessionId: 's-1', instructions: 'go on' })
  })

  it('queues a reopen when no slot is free', async () => {
    const s = setup()
    s.settings.update({ maxConcurrentAgents: 1 })
    const a = await started(s, 1)
    s.provider.emit(a, { type: 'state', state: 'completed' })
    const b = await started(s, 2)
    await s.runner.reopen(a, 'more')
    await flush()
    expect(s.board.must(a).agentState).toBe('queued')
    s.provider.emit(b, { type: 'state', state: 'completed' })
    await flush()
    expect(s.board.must(a).agentState).toBe('running')
  })

  it('starting with a chosen repository clears Needs repository', async () => {
    const s = setup()
    const id = s.board.ingest(signal({ trigger: 'api.custom', source: { kind: 'api', name: 'HB' }, externalKey: 'HB:1', links: [], repository: 'acme/nope' })).actionableId!
    expect(s.board.must(id).tags).toContain(TAGS.needsRepository)
    await s.runner.start(id, { repository: 'acme/api' })
    expect(s.board.must(id).tags).not.toContain(TAGS.needsRepository)
  })

  it('stopping a queued card does not call the provider', async () => {
    const s = setup()
    s.settings.update({ maxConcurrentAgents: 1 })
    await started(s, 1)
    const b = await started(s, 2)
    await s.runner.stop(b)
    expect(s.provider.calls).toEqual([])
    expect(s.board.must(b).tags).not.toContain(TAGS.queued)
  })
})

describe('agent events', () => {
  it('maps session, question, answer, usage, and result with prUrl', async () => {
    const s = setup()
    const id = await started(s)
    s.provider.emit(id, { type: 'session', sessionId: 's-1' })
    s.provider.emit(id, { type: 'question', id: 'q1', prompt: 'Which DB?', options: ['pg', 'sqlite'] })
    expect(s.board.must(id)).toMatchObject({ agentState: 'awaiting_input', pendingQuestion: { id: 'q1', prompt: 'Which DB?' } })
    expect(s.board.awaitingInputCount()).toBe(1)
    await expect(s.runner.answer(id, 'q0', 'pg')).rejects.toThrow()
    await s.runner.answer(id, 'q1', 'pg')
    expect(s.board.must(id).pendingQuestion).toBeUndefined()
    expect(s.board.awaitingInputCount()).toBe(0)
    expect(s.provider.calls).toEqual([`answer:${id}:q1:pg`])
    s.provider.emit(id, { type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.25 })
    s.provider.emit(id, { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0.25 })
    const prUrl = 'https://github.com/acme/api/pull/9'
    s.provider.emit(id, { type: 'result', result: { summary: 'Fixed', filesChanged: ['a.ts'], prUrl, openQuestions: [] } })
    const done = s.board.must(id)
    expect(done).toMatchObject({ column: 'review', agentState: 'completed', result: { summary: 'Fixed' } })
    expect(done.dispatch).toMatchObject({ sessionId: 's-1', inputTokens: 11, outputTokens: 6, costUsd: 0.5 })
    expect(done.links.at(-1)).toEqual({ label: 'Pull request', url: prUrl })
    expect(s.board.snapshot().stats).toMatchObject({ completedToday: 1, costTodayUsd: 0.5 })
    expect(s.eventTypes(id)).toEqual(['received', 'dispatched', 'awaiting_input', 'answered', 'completed'])
    expect(s.board.transcript(id)).toHaveLength(5)
  })

  it('maps errors to Review tagged Failed', async () => {
    const s = setup()
    const id = await started(s)
    s.provider.emit(id, { type: 'error', message: 'rate limited' })
    expect(s.board.must(id)).toMatchObject({ column: 'review', agentState: 'failed', error: 'rate limited' })
    expect(s.board.must(id).tags).toContain(TAGS.failed)
  })

  it('ignores events from a superseded dispatch', async () => {
    const s = setup()
    const id = await started(s)
    const stale = s.provider.requests[0]!.dispatchId
    await s.runner.stop(id)
    await s.runner.start(id)
    await flush()
    s.provider.emit(stale, { type: 'error', message: 'old run died' })
    expect(s.board.must(id)).toMatchObject({ column: 'in_progress', agentState: 'running' })
  })

  it('ignores a late result after Stop', async () => {
    const s = setup()
    const id = await started(s)
    await s.runner.stop(id)
    s.provider.emit(id, { type: 'result', result: { summary: 'late', filesChanged: [], openQuestions: [] } })
    expect(s.board.must(id).column).toBe('todo')
  })
})

describe('lifecycle', () => {
  it('pauses and resumes through the provider', async () => {
    const s = setup()
    const id = await started(s)
    await s.runner.pause(id)
    expect(s.board.must(id).agentState).toBe('paused')
    await expect(s.runner.pause(id)).rejects.toThrow()
    await s.runner.resume(id, 'go on')
    expect(s.board.must(id).agentState).toBe('running')
    expect(s.provider.calls).toEqual([`pause:${id}`, `resume:${id}:go on`])
  })

  it('reopen resumes the same session with feedback', async () => {
    const s = setup()
    const id = await started(s)
    s.provider.emit(id, { type: 'session', sessionId: 's-1' })
    s.provider.emit(id, { type: 'state', state: 'completed' })
    await s.runner.openInTerminal(id)
    await s.runner.reopen(id, 'Also add a test')
    await flush()
    expect(s.provider.requests[1]).toMatchObject({ resumeSessionId: 's-1', instructions: 'Also add a test' })
    expect(s.board.must(id)).toMatchObject({ column: 'in_progress', agentState: 'running' })
    expect(s.provider.calls[0]).toMatch(/^terminal:.*:s-1$/)
  })

  it('dismissing an active card stops the agent first', async () => {
    const s = setup()
    const id = await started(s)
    await s.board.dismissCard(id, { kind: 'user', name: 'You' })
    expect(s.provider.calls).toEqual([`stop:${id}`])
    expect(s.eventTypes(id).slice(-2)).toEqual(['stopped', 'dismissed'])
  })

  it('recovers orphaned agents as Stopped on launch', async () => {
    const s = setup()
    const id = await started(s)
    s.runner.recover()
    expect(s.board.must(id)).toMatchObject({ column: 'todo', agentState: 'stopped' })
  })
})

describe('helpers', () => {
  it('slugifies titles and expands ~', () => {
    expect(slugify('Fix: checkout timeout after payment retry!!')).toBe('fix-checkout-timeout-after-payment-retry')
    expect(slugify('***')).toBe('task')
    expect(expandHome('~/Developer/Gantry', '/Users/me')).toBe('/Users/me/Developer/Gantry')
    expect(expandHome('/abs', '/Users/me')).toBe('/abs')
  })
})
