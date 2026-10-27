# Gantry — Product Requirements Document

Gantry is a macOS app that turns incoming work (GitHub, Slack, email, custom API) into **actionables** on a triage board and dispatches coding agents to work on them in isolated workspaces.

Design reference: [Figma mockup](https://www.figma.com/design/DsAORjXJUM4arQDlbOB1kO/Untitled?node-id=0-1) — five screens: Triage, Connections, Activity, Preferences, Welcome.

---

## 1. Glossary

| Term | Meaning |
|---|---|
| Actionable | A card on the board. Can be dispatched to an agent. Has a source, links, context, and lifecycle state. |
| Source | Where an actionable came from: `github`, `slack`, `email`, `api` (custom name, e.g. Honeybadger), `manual`. |
| Trigger | A per-source rule that decides whether an incoming event creates an actionable (e.g. "PR with failing CI"). |
| Input / Connection | An OAuth-connected integration (GitHub, Slack, Email) or the API source. |
| Agent provider | A pluggable runtime that executes an actionable. v1: Claude Code. Later: Codex, Orca. |
| Workspace | Per-actionable git worktree under the configured workspace location. |
| Worker | Cloudflare Worker that hosts the public API, OAuth callbacks, webhook receivers, and per-user inbox queue. |
| Event | An Activity log entry. Every event is linked to zero or one actionable. |

---

## 2. Goals / Non-goals

**Goals**
- One board for everything that needs attention, regardless of origin.
- One click from "this needs attention" to "an agent is working on it in an isolated worktree".
- Every incoming signal and every state change is logged and traceable to its card.
- Flexible ingestion: anything can create an actionable via the API.

**Non-goals (v1)**
- Teams / shared boards / multi-user workspaces.
- Multi-device sync (identity model allows it later).
- Outlook / IMAP email (Gmail only).
- Signed/notarized distribution and auto-update.
- Agent providers other than Claude Code (interface exists; only one implementation).

---

## 3. Architecture

```
┌──────────────────────── Mac ────────────────────────┐      ┌──── Cloudflare ────┐
│ apps/desktop (Electron + React + TS)                │      │ cloudflare-workers/│
│  ├ renderer: board, panels, settings                │      │  api (Hono + D1)   │
│  ├ main: SQLite (better-sqlite3), Keychain,         │◄────►│  ├ /v1/actionables │
│  │        poller, agent providers, local notifs     │ poll │  ├ /oauth/*        │
│  └ providers/claude: Agent SDK, worktrees, node-pty │      │  ├ /webhooks/*     │
│                                                     │      │  └ /inbox (queue)  │
│ packages/shared: types, API client, zod schemas     │      └───────┬────────────┘
└─────────────────────────────────────────────────────┘              │ webhooks / OAuth
                                                        GitHub · Slack · Google · Honeybadger · automations
```

**Monorepo (pnpm workspaces)**
- `apps/desktop` — Electron app.
- `cloudflare-workers/api` — Worker (wrangler).
- `packages/shared` — actionable/event types, zod schemas, worker API client.
- `docs/` — this PRD.

**Data flow**
1. External systems hit the Worker (webhooks, API POSTs) → stored in the user's inbox (D1).
2. Desktop app polls `GET /v1/inbox` every 15 s, acks delivered items.
3. Inbox items pass through **trigger evaluation** (per-source toggles, filters, optional LLM gate) → create/update actionable or log as ignored.
4. Reconciliation poller (5–10 min, rate-limit-aware) backfills missed events and resolves external state.
5. User dispatches → agent provider creates worktree, runs agent, streams events → timeline + Activity.

All user data lives in local SQLite. Worker stores only: user record, OAuth grants, API tokens, undelivered inbox items.

---

## 4. Identity

- First launch modal: **Your name** (required) + optional **Sign in with GitHub** / **Sign in with email** (magic link via Worker).
- Name-only → local account with a generated device token registered at the Worker (needed for inbox + API).
- Signed-in → Worker user id; device token linked to it. Enables multi-device later.
- Upgrading from name-only to signed-in keeps all local data; Worker re-keys the device token.
- Avatar/name auto-filled from GitHub when connected.
- Single "Personal workspace" per install.

---

## 5. Actionable model

```ts
Actionable {
  id: string            // GT-### display id + uuid
  title: string
  body?: string         // markdown
  source: { kind: 'github'|'slack'|'email'|'api'|'manual', name: string, icon?: string }
  externalKey?: string  // dedupe key: source + entity id (PR URL, Slack msg ts, Gmail thread id, api external_id)
  links: { label: string, url: string }[]
  repository?: string   // owner/name
  instructions?: string // agent prompt override
  priority?: 'low'|'normal'|'high'|'urgent'
  tags: string[]        // e.g. 'CI failed', 'Needs reply · AI detected', 'Resolved externally', 'Stopped', 'Failed'
  metadata: Record<string, unknown>
  column: string        // 'todo'|'in_progress'|'review'|'done'|<custom column id>
  position: number      // manual order within column
  agentState?: 'queued'|'running'|'paused'|'awaiting_input'|'completed'|'failed'|'stopped'
  snoozedUntil?: Date
  dismissedAt?: Date
  archivedAt?: Date
  dispatch?: { provider, model, repository, worktreePath, permissionPreset, sessionId, startedAt, startedBy }
  result?: { summary, filesChanged[], branch, prUrl, testsRun, openQuestions[] }
  createdAt, updatedAt
}
```

**Dedupe**: one card per external entity. A new trigger on an existing entity:
- Adds the tag, updates body/links, bumps `updatedAt`.
- If card is Done (resolved externally) or Snoozed → returns to To-do.
- If dismissed by user → stays dismissed unless the trigger *type* is new for that card.

---

## 6. Board (Triage view)

**Fixed columns, fixed relative order**: To-do → In Progress → Review → Done. Custom columns can be inserted at any position between/around them; fixed columns never reorder relative to each other.

**Column transitions**
- To-do → In Progress: Start (dispatch).
- In Progress → Review: agent completes or fails.
- In Progress → To-do: Stop.
- Review → Done: user clicks Done (triggers cleanup).
- Review → In Progress: Reopen with feedback (resumes same session).
- Any → Dismissed (archived; kills agent if running).
- Any → Snoozed (hidden; not allowed while agent running).
- Manual move to custom columns: allowed from To-do, Review, Done, custom; from In Progress only when paused/stopped. Agents never run in a custom column.
- Auto-resolve (GitHub only, per table in 8.1): To-do cards move to Done tagged `Resolved externally`; In Progress/Review cards get the tag only. Slack, Email, API, and manual cards never auto-resolve; they move only by user action.

**Card buttons (icon + label)**

| Column | Buttons |
|---|---|
| To-do | ▶ Start · ⏱ Snooze · ✕ Dismiss |
| In Progress (running / awaiting input) | ⏸ Pause · ■ Stop · ✕ Dismiss |
| In Progress (paused / queued) | ▶ Resume · ■ Stop · ⏱ Snooze · ✕ Dismiss |
| Review | ✓ Done · ↺ Reopen · ⌘ Open in terminal · ✕ Dismiss |
| Done | none (… menu: Reopen to To-do, Dismiss) |
| Custom | ▶ Start · ⏱ Snooze · ✕ Dismiss |

**Card fields** (toggle via "Card fields"): Title (always), Source, Status/tags, Agent, Received time, Repository, Links, Priority. Persisted per user.

**Ordering**: manual drag within To-do, Review, Done, custom. In Progress auto-sorted: awaiting_input > running > queued > paused, then start time. New cards insert at top. Sort dropdown: newest, oldest, priority, source.

**Filters**: All sources / per source; All agents / per provider; Show snoozed; Show dismissed.

**Header**: "N actionables · M agents running", Card fields, Add column, New actionable (manual: title, body, source name, links, repository, priority).

**Details panel** (right, on card click): id, state tag, created time, title, source, body, links, dispatch block (agent, repository, workspace path, permissions, instructions), latest activity (events linked to this card, "View log" opens Activity filtered by card), action buttons, awaiting-input prompt + answer box when relevant.

**Global search** (⌘K): title, body, source, id across all cards including Done/Dismissed/Snoozed. Enter opens the detail panel.

---

## 7. Agent dispatch

**Provider interface** (`packages/shared`): `dispatch(actionable, opts)`, `pause(id)`, `resume(id, feedback?)`, `stop(id)`, `answer(id, text)`, `events(id): AsyncIterable<AgentEvent>`, `openInTerminal(id)`.

**Claude provider (v1)**
- Detects `claude` on PATH; Welcome step 3 blocks until found.
- Runs headless via Claude Agent SDK with streaming JSON. Session id stored for resume.
- Worktree: `git worktree add <workspaceLocation>/<id>-<slug> -b gantry/<id>-<slug>` from the registered repo's default branch.
- Pause = interrupt, keep session + worktree. Resume = continue session. Stop = kill, keep worktree, card → To-do tagged `Stopped`.
- Awaiting input = agent asked a question (AskUserQuestion / permission prompt); user answers in the details panel.
- Open in terminal: `claude --resume <sessionId>` in the worktree via Terminal.app (or Orca if detected).
- Completion: prompt instructs a final structured block (summary, files changed, branch, PR URL, tests run, open questions). Parsed into `result`; links auto-added. Failure → Review tagged `Failed` with error.

**Dispatch sheet** (shown when "Confirm before dispatching" is on; otherwise defaults apply):
- Instructions: auto-built from title, body, links, and fetched context (PR diff summary / Slack thread / email body). Editable.
- Repository: inferred from source (GitHub remote match, API `repository`), else dropdown of registered repos.
- Agent: provider + model.
- Permission preset: **Read-only** (investigate, no edits) · **Edit + test** (edit files, run commands, no push/PR) · **Full** (may push branch and open PR). Mapped to Agent SDK permission mode + allowed tools.

**Concurrency**: `Max concurrent agents` setting (default 3). Beyond limit → card in In Progress tagged `Queued`, auto-starts when a slot frees.

**Registered repositories** (Preferences): local path → remote owner/name read from `git remote`. Used for repo inference and worktree creation.

---

## 8. Integrations

All OAuth apps are Gantry-owned; secrets live in the Worker. Worker runs the OAuth callback and stores grants keyed by user. Connections view: status (Connected / Reconnect required / Disconnected), Manage access, Disconnect, per-trigger toggles. "Turning a trigger off stops new actionables; existing work is untouched."

**Delivery**: webhooks → Worker → inbox (primary). Reconciliation polling every 5–10 min backfills and resolves state. Each poller tracks rate-limit headers and backs off before the limit (GitHub `x-ratelimit-remaining`, Slack `Retry-After`, Gmail quota units).

### 8.1 GitHub (GitHub App)
Scope: selected repositories.

| Trigger | Matches | Resolves when |
|---|---|---|
| PRs with failing CI | PRs authored by me, check-suite failed | checks green or PR closed |
| PRs with merge conflicts | PRs authored by me, mergeable=false | mergeable or closed |
| PRs with changes requested | PRs authored by me, review state CHANGES_REQUESTED | approved/dismissed or closed |
| Review requests | review requested of me specifically (team requests ignored) | review submitted or PR closed |
| Mentions | @me in issue/PR comments | user replied in thread |
| Dependabot alerts | alerts in selected repos ≥ severity threshold (default high) | alert fixed/dismissed |
| New issues | assigned to me, or any new issue in selected repos (toggle) | closed |

### 8.2 Slack
Settings: channel allow/deny list, "check unreplied after N minutes" (default 30), LLM provider.

| Trigger | Matches |
|---|---|
| New mentions | @me in channels I'm in + DMs (+ @here/@channel in DMs) |
| Unreplied mentions (LLM) | mentions re-checked after N min; LLM decides a reply is still owed |
| Conversations needing follow-up (LLM) | threads/DMs where I posted in last 7 days; LLM finds commitments with a remaining next step |

Cards include the original message text so the user can verify before dispatching. No automatic resolution: cards move only by manual action (Done, Dismiss, drag).

### 8.3 Email (Gmail)
Trigger: New emails. Filters: Inbox only, Unread only, exclude Gmail categories (Promotions/Social/Updates/Forums), from-domain allow/deny, label filter. Optional **LLM "needs action" gate**. Polling only (no Pub/Sub). No automatic resolution: cards move only by manual action (Done, Dismiss, drag). Expired OAuth → "Reconnect required" state; existing cards kept; connection event logged.

### 8.4 API & custom sources
`POST https://<worker>/v1/actionables` with `Authorization: Bearer <token>`. Tokens created in Connections (`Create API token`), stored in Worker, shown once.

```json
{
  "title": "Fix checkout timeout after payment retry",        // required
  "body": "markdown",
  "source": { "name": "Honeybadger", "icon": "bug" },
  "external_id": "hb-4821",                                   // dedupe key with source.name
  "links": [{ "label": "Honeybadger event #4821", "url": "..." }],
  "repository": "acme/storefront",
  "instructions": "agent prompt override",
  "priority": "high",
  "tags": ["production"],
  "auto_start": false,
  "metadata": {}
}
```
Response: `{ id, url: "gantry://actionable/<id>" }`. Idempotent on `source.name + external_id` (updates existing). `auto_start: true` dispatches with defaults on arrival (respects concurrency limit).

Also: `GET /v1/actionables/:id`, `PATCH /v1/actionables/:id` (title/body/links/tags), `POST /v1/actionables/:id/dismiss`. "Send test actionable" button in Connections.

---

## 9. LLM detection layer

Preferences › AI: provider (Anthropic · OpenAI · OpenAI-compatible URL), API key (Keychain), model id. Default Anthropic `claude-haiku-5-5`. Calls go directly from the app. Used by: Slack unreplied/follow-up, Email needs-action gate. Each decision is logged as a Received event with the verdict and reason; cards get an `AI detected` tag.

---

## 10. Activity log

One view, filterable by event type, source, date, text, and actionable. Live updates. Export JSON/CSV. Retention setting (default 90 days).

Event types: `received` (tag: created / ignored:trigger-off / ignored:filtered / ignored:duplicate / ignored:llm), `dispatched`, `agent_update`, `paused`, `resumed`, `awaiting_input`, `answered`, `stopped`, `completed`, `failed`, `review`, `done`, `reopened`, `dismissed`, `snoozed`, `unsnoozed`, `moved`, `resolved_externally`, `connection` (connected / reconnect required / disconnected), `api_token`, `settings`.

Every event stores `actionableId?`, `source`, `actor` (user / agent / source / Gantry), `title`, `detail`, `timestamp`. Clicking an event opens the card; the card panel lists its events.

---

## 11. Preferences

**Agent defaults**: default provider/model, workspace location, registered repositories, default permission preset, confirm before dispatching, confirm before stopping, max concurrent agents.

**When work is done**: agent workspace — Delete / Keep / Ask each time (remote branches and PRs always kept). Keep completed actionables (on → auto-archive from Done after N days, default 7, searchable; off → removed from board on Done, still in Activity).

**Snooze presets**: 1 h, 3 h, tomorrow 9 am, next Monday, custom.

**AI**: provider, key, model (section 9).

**Notifications**: per type — agent needs input, agent completed, agent failed, new actionable. Click opens the card.

**General**: launch at login, appearance (System/Light/Dark), activity retention.

**Account**: name, sign-in status, device id, sign out.

**Local data**: Delete all Gantry data — stops agents, deletes worktrees under workspace location, wipes SQLite and Keychain, calls Worker to delete inbox, revoke OAuth grants and API tokens. Confirm dialog. Disconnect single input: revoke that grant at Worker; existing cards kept and tagged `Source disconnected`.

---

## 12. First run

1. Modal: name + optional GitHub/email sign-in.
2. Welcome view with three steps: Connect inputs (GitHub / Slack / Email), Choose triggers, Dispatch first agent (requires Claude Code on PATH and ≥1 registered repository). Status "N of 3 complete".
3. Empty board below with "Connect GitHub" / "Create manually". API banner: "Set up API access".
4. Welcome collapses to a banner once any actionable exists; Help reopens it.

---

## 13. Worker

- Hono on Cloudflare Workers, D1 for users / grants / tokens / inbox, Secrets for OAuth client secrets.
- Routes: `POST /v1/actionables`, `GET/PATCH /v1/actionables/:id`, `GET /v1/inbox`, `POST /v1/inbox/ack`, `POST /v1/devices`, `POST /auth/email` (magic link), `GET /oauth/:provider/start|callback`, `POST /webhooks/github`, `POST /webhooks/slack`, `DELETE /v1/me` (delete all).
- Webhook signature verification (GitHub HMAC, Slack signing secret).
- Inbox items are deleted after ack; undelivered items expire after 30 days.
- OAuth access tokens are returned to the app on connect and stored in Keychain; Worker keeps refresh tokens only where polling must survive app restarts (GitHub App installation token minting, Google refresh). Webhook routing uses the grant → user mapping.

---

## 14. Non-functional

- All local data in SQLite under `~/Library/Application Support/Gantry/`; tokens in Keychain.
- Board renders ≤ 500 visible cards without jank; Activity paginates ("Load earlier events").
- Inbox poll 15 s; reconciliation 5–10 min; both back off on rate-limit headers and surface a `connection` event when throttled.
- App closed: Worker queues; nothing is lost for 30 days.
- Dev distribution: `pnpm package` produces an unsigned `.app`/DMG. No auto-update.

---

## 15. Deep links

`gantry://actionable/<id>` opens the card. Electron registers the scheme in Info.plist and handles both the running-app event and the cold-launch URL. Used by API responses and notifications.
