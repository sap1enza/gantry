import { describe, expect, it } from 'vitest'
import { createActionableSchema } from './api'
import type { GantryApi } from './ipc'
import { createApiProxy, resolveApiMethod } from './rpc'

describe('rpc', () => {
  it('round-trips a call through proxy and resolver', async () => {
    const impl = { board: { get: async (id: string) => ({ id }) } } as unknown as GantryApi
    const api = createApiProxy((path, args) => resolveApiMethod(impl, path)!(...args) as Promise<unknown>)
    expect(await api.board.get('x')).toEqual({ id: 'x' })
  })
  it('rejects unknown and prototype paths', () => {
    const impl = { board: {} } as unknown as GantryApi
    expect(resolveApiMethod(impl, 'board.nope')).toBeUndefined()
    expect(resolveApiMethod(impl, 'constructor.call')).toBeUndefined()
    expect(resolveApiMethod(impl, 'board')).toBeUndefined()
    expect(resolveApiMethod(impl, 'board.constructor')).toBeUndefined()
  })
})

describe('createActionableSchema', () => {
  it('requires a title and validates repository shape', () => {
    expect(createActionableSchema.safeParse({}).success).toBe(false)
    expect(createActionableSchema.safeParse({ title: 'x', repository: 'bad' }).success).toBe(false)
    expect(createActionableSchema.safeParse({ title: 'x', repository: 'acme/api' }).success).toBe(true)
  })
})
