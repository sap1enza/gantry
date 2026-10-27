# Gantry

macOS triage board that turns GitHub/Slack/Gmail/API signals into actionables and dispatches Claude Code into per-card git worktrees. Spec: `docs/PRD.md`. Design screenshots: `docs/design/*.png`. Figma file key `DsAORjXJUM4arQDlbOB1kO` (frames: Triage `4:14895`, Connections `4:15282`, Activity `4:15536`, Preferences `4:15790`, Welcome `4:15973`).

## Stack
- pnpm 12 workspaces, TypeScript 7, vitest 5, zod 4.
- `apps/desktop`: Electron 45 (Node 24) + electron-vite 6 + React 19. Local DB is `node:sqlite` (`DatabaseSync`), no native modules. Secrets via Electron `safeStorage` (Keychain-backed) stored encrypted in SQLite.
- `cloudflare-workers/api`: Hono on Cloudflare Workers, D1, wrangler 4.
- `packages/shared`: types + zod schemas + IPC contract + worker HTTP client, consumed as TS source.

## Commands
- `pnpm install` (once per worktree)
- `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @gantry/desktop build`
- `pnpm dev` (desktop), `pnpm dev:worker` (wrangler dev on :8787)

## Contracts (coordinator-owned; do not edit without asking)
- `packages/shared/src/*` — domain types, `GantryApi` IPC contract, `IngestSink`, `AgentProvider`, worker API schemas, `WorkerClient`.
- `apps/desktop/src/main/contracts.ts` — `Ingestion`, `IngestionDeps`, `SecretStore`.
- `apps/desktop/src/preload/index.ts` — generic RPC bridge (`window.gantryTransport.invoke/onPush`, wrapped into a typed `GantryApi` by `createApiProxy` in the renderer (contextBridge cannot clone Proxies)).
If a contract is wrong or missing something, ask the coordinator; do not fork types locally.

## Ownership map
| Area | Paths |
|---|---|
| Core | `apps/desktop/src/main/{index.ts,api.ts,db/**,domain/**,agents/**,system/**}` |
| Claude provider | `apps/desktop/src/main/providers/**` |
| Ingestion | `apps/desktop/src/main/ingestion/**` |
| Renderer | `apps/desktop/src/renderer/**` |
| Worker | `cloudflare-workers/api/**`, `packages/shared/src/worker-client.ts` |

## Conventions
- No explanatory comments; names carry meaning. Only `shortcut:` comments for deliberate known limits.
- Smallest code that fully meets the PRD. Stdlib/platform first; no new dependency for a few lines.
- Every non-trivial branch, parser, state transition, or security check gets one focused vitest test next to it (`*.test.ts`).
- Timestamps are ISO strings across IPC. IDs are `crypto.randomUUID()`.
- Commit locally on your branch with clear messages. Never push. No Co-Authored-By trailers.
