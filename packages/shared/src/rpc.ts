import type { GantryApi } from './ipc'

type Invoke = (path: string, args: unknown[]) => Promise<unknown>

export function createApiProxy(invoke: Invoke): GantryApi {
  return new Proxy({} as GantryApi, {
    get: (_, ns: string) =>
      new Proxy({}, { get: (_, method: string) => (...args: unknown[]) => invoke(`${ns}.${method}`, args) }),
  })
}

export function resolveApiMethod(api: GantryApi, path: string): ((...args: unknown[]) => unknown) | undefined {
  const [ns, method] = path.split('.')
  if (!ns || !method || !Object.hasOwn(api, ns)) return undefined
  const target = (api as unknown as Record<string, Record<string, unknown>>)[ns]!
  if (!Object.hasOwn(target, method)) return undefined
  const fn = target[method]
  return typeof fn === 'function' ? (fn.bind(target) as (...args: unknown[]) => unknown) : undefined
}
