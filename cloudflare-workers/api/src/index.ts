import { createApp } from './app'
import type { Env } from './env'
import { deleteExpired } from './store'

export type { Env } from './env'

export default {
  fetch: createApp().fetch,
  scheduled: async (_controller, env, ctx) => ctx.waitUntil(deleteExpired(env.DB)),
} satisfies ExportedHandler<Env>
