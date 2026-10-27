import { TAGS } from '@gantry/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApi, toCsv, type Platform } from './api'
import type { Ingestion } from './contracts'
import { createSecretStore, jsonTable } from './db/stores'
import { flush, setup, signal } from './domain/testing'
import { AccountService } from './system/account'

function api(s = setup(), workerFetch?: typeof fetch, ingestion?: Partial<Ingestion>) {
  const secrets = createSecretStore(s.db, { encrypt: (v) => Buffer.from(v), decrypt: (b) => Buffer.from(b).toString() })
  const account = new AccountService({ meta: jsonTable(s.db, 'meta'), secrets, workerUrl: () => 'http://worker.test', fetch: workerFetch })
  const order: string[] = []
  const platform: Platform = {
    openExternal: vi.fn(async () => undefined),
    chooseDirectory: vi.fn(async () => '/code/web/src'),
    saveFile: vi.fn(async () => undefined),
    wipe: () => order.push('wipe'),
    alert: vi.fn(async () => undefined),
    relaunch: () => order.push('relaunch'),
  }
  const gantry = createApi({
    board: s.board,
    runner: s.runner,
    account,
    settings: s.settings,
    repos: s.repos,
    secrets,
    ingestion: { stop: () => undefined, ...ingestion } as Ingestion,
    providers: new Map([[s.provider.id, s.provider]]),
    exec: async (_, args) => {
      if (args.includes('--show-toplevel')) return { code: 0, output: '/code/web\n' }
      if (args.includes('get-url')) return { code: 0, output: 'git@github.com:acme/web.git\n' }
      if (args.includes('symbolic-ref')) return { code: 0, output: 'origin/develop\n' }
      if (args.includes('worktree')) order.push(`git ${args.slice(2).join(' ')}`)
      return { code: 0, output: '' }
    },
    platform,
    push: () => undefined,
    onSettingsChanged: () => undefined,
    fetch: workerFetch,
  })
  return { s, gantry, account, secrets, platform, order }
}

describe('api', () => {
  it('registers a repository from its origin remote and default branch', async () => {
    const { gantry } = api()
    expect(await gantry.repos.add()).toMatchObject({ path: '/code/web', remote: 'acme/web', defaultBranch: 'develop' })
  })

  it('only opens http(s) and mailto links', async () => {
    const { gantry, platform } = api()
    await expect(gantry.system.openExternal('file:///etc/passwd')).rejects.toThrow()
    await gantry.board.openLink('https://github.com/acme/api/pull/1')
    expect(platform.openExternal).toHaveBeenCalledTimes(1)
  })

  it('reopens Done cards to To-do', async () => {
    const { gantry, s } = api()
    const id = s.board.ingest(signal()).actionableId!
    await gantry.board.move(id, 'done', 0)
    await gantry.board.reopen(id)
    expect(s.board.must(id).column).toBe('todo')
  })

  it('stores the LLM key encrypted under the shared secret name', async () => {
    const { gantry, secrets } = api()
    await gantry.settings.setLlmKey(' sk-1 ')
    expect(secrets.get('llm.apiKey')).toBe('sk-1')
    expect(await gantry.settings.hasLlmKey()).toBe(true)
  })

  it('deleteAllData stops agents, removes recorded worktrees, deletes at the worker, then wipes and relaunches', async () => {
    const workerFetch = vi.fn(async (url: URL) =>
      url.pathname === '/v1/devices' ? Response.json({ deviceId: 'd1', deviceSecret: 'x', userId: 'u1' }) : new Response(null, { status: 204 }),
    )
    const { gantry, s, order, secrets, account } = api(setup(), workerFetch as unknown as typeof fetch)
    await account.setName('Lucas')
    const id = s.board.ingest(signal()).actionableId!
    await s.runner.start(id)
    await flush()
    const path = s.board.must(id).dispatch!.worktreePath
    vi.spyOn(s.provider, 'stop').mockImplementation(async () => void order.push('stop'))
    const removeAll = s.runner.removeAllWorktrees.bind(s.runner)
    vi.spyOn(s.runner, 'removeAllWorktrees').mockImplementation(async () => {
      await removeAll()
      order.push(`removed ${s.execCalls.at(-1)!.join(' ')}`)
    })
    workerFetch.mockImplementation(async (url: URL) => {
      order.push(`worker ${url.pathname}`)
      return new Response(null, { status: 204 })
    })
    await gantry.system.deleteAllData()
    expect(order).toEqual(['stop', `removed git -C /code/api worktree remove --force ${path}`, 'worker /v1/me', 'wipe', 'relaunch'])
    expect(secrets.get('device')).toBeUndefined()
  })

  it('deleteAllData still wipes locally and tells the user when the worker delete fails', async () => {
    const workerFetch = vi.fn(async (url: URL) =>
      url.pathname === '/v1/devices' ? Response.json({ deviceId: 'd1', deviceSecret: 'x', userId: 'u1' }) : new Response(null, { status: 204 }),
    )
    const { gantry, order, account, platform } = api(setup(), workerFetch as unknown as typeof fetch)
    await account.setName('Lucas')
    workerFetch.mockImplementation(async () => new Response('down', { status: 503 }))
    await gantry.system.deleteAllData()
    expect(order).toEqual(['wipe', 'relaunch'])
    expect(platform.alert).toHaveBeenCalledWith('Remote data could not be deleted', expect.stringContaining('Local data was deleted'))
  })
})

describe('api follow-ups', () => {
  const deviceFetch = () =>
    vi.fn(async (url: URL) =>
      url.pathname === '/v1/devices' ? Response.json({ deviceId: 'd1', deviceSecret: 'x', userId: 'u1' }) : Response.json({ id: 'a1', url: 'gantry://actionable/a1' }),
    )

  it('sends the test actionable through the device route without minting a token', async () => {
    const workerFetch = deviceFetch()
    const syncNow = vi.fn(async () => undefined)
    const { gantry, account } = api(setup(), workerFetch as unknown as typeof fetch, { syncNow })
    await account.setName('Lucas')
    await gantry.connections.sendTestActionable()
    const paths = workerFetch.mock.calls.map(([url]) => url.pathname)
    expect(paths).toContain('/v1/test-actionable')
    expect(paths).not.toContain('/v1/tokens')
    expect(syncNow).toHaveBeenCalled()
  })

  it('disconnect leaves logging and tagging to ingestion', async () => {
    const s = setup()
    const disconnect = vi.fn(async () => undefined)
    const markSourceDisconnected = vi.spyOn(s.board, 'markSourceDisconnected')
    const { gantry } = api(s, undefined, { disconnect })
    await gantry.connections.disconnect('google')
    expect(disconnect).toHaveBeenCalledWith('google')
    expect(markSourceDisconnected).not.toHaveBeenCalled()
  })

  it('registering a repository clears Needs repository and auto-starts waiting cards', async () => {
    const s = setup()
    const { gantry } = api(s)
    const apiCard = (id: string, autoStart: boolean) =>
      s.board.ingest(signal({ id, trigger: 'api.custom', source: { kind: 'api', name: 'HB' }, externalKey: `HB:${id}`, links: [], repository: 'acme/web', autoStart }))
    apiCard('auto', true)
    apiCard('manual', false)
    await gantry.repos.add()
    await flush()
    expect(s.board.must('auto')).toMatchObject({ column: 'in_progress', agentState: 'running' })
    expect(s.board.must('manual').column).toBe('todo')
    expect(s.board.must('manual').tags).not.toContain(TAGS.needsRepository)
    expect(s.board.must('auto').metadata).not.toHaveProperty('autoStartOnRepository')
  })
})

describe('toCsv', () => {
  it('quotes fields and escapes quotes', () => {
    const csv = toCsv([
      { id: '1', type: 'received', source: 'API', actor: { kind: 'source', name: 'API' }, title: 'Say "hi", ok', createdAt: '2026-10-27T12:00:00.000Z' },
    ])
    expect(csv.split('\n')[1]).toBe('"2026-10-27T12:00:00.000Z","received","","","API","API","Say ""hi"", ok",""')
  })
})
