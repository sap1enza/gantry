# Gantry PRD conformance audit — main @ 6a6788a

Read-only. `pnpm -r typecheck` passes; `pnpm -r test` passes (shared 7, desktop 206, worker 28). Paths: `desktop/` = `apps/desktop/src/`, `worker/` = `cloudflare-workers/api/src/`, `shared/` = `packages/shared/src/`.
Out of scope (another worker): auth-completion / login-CSRF flow, Slack `search:read` scope.
Items marked ✔ below were re-verified by reading the cited code during assembly.

## Top gaps (summary)
1. **Permission presets are bypassable** ✔ (`desktop/main/providers/claude/policy.ts:7-12,36-40`). Edit+test can push or POST to GitHub. Full can force-push or delete branches without asking. Read-only can run scripts or write files. Every preset allows WebFetch, which opens a prompt-injection exfiltration path.
2. **The API token can PATCH or dismiss any card** ✔, including GitHub/Slack cards and running agents (`desktop/main/domain/board.ts:136-143,332-353`).
3. **The Worker ignores `?force=1` on grant refresh** ✔ (`worker/app.ts:294-302`). After a 401 the app gets the same token back and marks the connection Reconnect required.
4. **The Slack channel allow/deny list calls `conversations.info` without `channels:read`/`groups:read`** ✔ (`worker/oauth.ts:36`, `desktop/main/ingestion/slack.ts:63`). Once any list entry exists, channel mentions fail and are dropped after 5 retries. This depends on the scope change the other worker is making.
5. **`agent_update` events are never emitted.**
6. **Moving a card to Done by drag or the menu skips worktree cleanup and the `done` event** ✔ (`board.ts:412`).
7. **Re-dispatching after a repository change reuses the old repo's worktree** ✔ (`desktop/main/agents/runner.ts:176`).
8. **No avatar or name auto-fill from GitHub.**
9. **No Orca terminal detection.**
10. **No DMG output.**
11. **No Gmail quota tracking.**
12. **GitHub mentions are never backfilled.**

---

## §1 Glossary
- [Implemented] Source kinds `github|slack|email|api|manual` — `shared/actionable.ts:1`
- [Implemented] Agent provider is pluggable, with Claude as the only implementation — `shared/provider.ts:34-45`, `desktop/main/providers/claude/index.ts`
- [Implemented] Workspace is a per-card git worktree — `runner.ts:120-128,198-205`
- [Implemented] Every event links to zero or one actionable (`actionableId?`) — `shared/events.ts:35-47`

## §2 Goals / Non-goals
- [Implemented] One board for every source; one-click dispatch into a worktree; signals and state changes logged (see §6, §7, §10)
- [Implemented] Ingestion through an open API (see §8.4)
- [Implemented] Non-goals respected: single user, Gmail only, unsigned build, a single provider implementation

## §3 Architecture / data flow
- [Partial] Stack — `node:sqlite` instead of better-sqlite3 and safeStorage+SQLite instead of Keychain (both sanctioned by CLAUDE.md). The Agent SDK is used (`desktop/package.json:16`). node-pty is not used.
- [Implemented] Inbox polled every 15 s and acked — `desktop/main/ingestion/index.ts:8,101-124,153`
- [Implemented] Trigger evaluation (toggle → filter → LLM gate) → ingest or logIgnored — `ingestion/context.ts:160-178`
- [Partial] Update/dismiss inbox items skip trigger evaluation — `ingestion/index.ts:68-71`. An API PATCH or dismiss still applies when the "API / custom" trigger is off.
- [Partial] Inbox poll cadence — `ingestion/index.ts:133-147`. The poll shares one serialized `busy` chain with reconcile and Slack/Gmail jobs, so a slow job, or a hung fetch (there are no timeouts, `ingestion/llm.ts:34`, `context.ts:134`), delays or freezes inbox delivery.
- [Implemented] Worker stores only users, grants, tokens and inbox, plus short-lived devices, oauth_states, email_links and rate_limits — `cloudflare-workers/api/migrations/0001_init.sql`

## §4 Identity
- [Implemented] First-launch modal: name required, GitHub/email sign-in optional — `desktop/renderer/src/views/overlays.tsx:283-313`
- [Implemented] Name only → device token registered at the Worker — `desktop/main/system/account.ts:40-51`, `worker/app.ts:157-176`
- [Out of scope] Sign-in completion (GitHub callback, email verify, `/auth/complete`)
- [Partial] Upgrade keeps local data; the Worker moves the device to the user (`worker/store.ts:120-131`). The device secret is not re-keyed as the PRD says.
- [Missing] Avatar and name auto-filled from GitHub. `account.ts:60-65` never sets `avatarUrl` or `name`, `MeResponse` has no avatar (`shared/api.ts:92-99`), and the renderer never displays an avatar.
- [Implemented] Single "Personal workspace" — `desktop/renderer/src/shell.tsx:49`

## §5 Actionable model
- [Implemented] Every field in the PRD's model — `shared/actionable.ts:39-99`
- [Implemented] One card per external entity (`kind:externalKey` unique) — `board.ts:75,145-154`, `desktop/main/db/index.ts:13`
- [Implemented] A new trigger adds the tag, updates the body, merges links, bumps updatedAt — `board.ts:270-288`
- [Partial] Re-trigger does not update `priority`, `instructions`, or `repository`/`Needs repository` — `board.ts:270-289` (matters for API re-POSTs)
- [Implemented] Done or Snoozed → To-do — `board.ts:281-285`. A snoozed card in In Progress is only un-snoozed.
- [Implemented] A dismissed card stays dismissed unless the trigger type is new (`ignored:duplicate`) — `board.ts:265-269`

## §6 Board
- [Implemented] Fixed column order enforced; custom columns can sit anywhere — `board.ts:521-551`
- [Partial] Add column always appends at the end — `desktop/renderer/src/views/triage.tsx:58-61`. Placing it needs Move left/right afterwards.
- [Implemented] To-do → In Progress via Start — `runner.ts:108-151`
- [Implemented] In Progress → Review on complete or fail — `runner.ts:254-283`
- [Implemented] In Progress → To-do on Stop — `runner.ts:325-337`
- [Partial] Review → Done with cleanup ✔ — the Done button cleans up (`runner.ts:370-380`), but drag or Move-to Done (`board.ts:412`, `triage.tsx:31,446`) only calls `markDoneFields`. There is no worktree cleanup, the "Ask" prompt is skipped, and the event logged is `moved`, not `done`.
- [Partial] Manual moves allow transitions the PRD doesn't list — `shared/rules.ts:43-45`: drag To-do/custom → Done and Review → To-do
- [Implemented] Review → In Progress via Reopen with feedback, same session — `runner.ts:353-368`
- [Partial] Dismiss uses the Stop confirmation only for running/awaiting_input — `desktop/renderer/src/app.tsx:229-233`. Dismissing a paused or queued agent kills it without asking.
- [Implemented] Snooze blocked while the agent runs — `rules.ts:28`, `board.ts:436-441`
- [Implemented] Custom-column move rules — `rules.ts:40-46`
- [Implemented] Auto-resolve only for GitHub; To-do → Done + `Resolved externally`; In Progress/Review get the tag only — `board.ts:316-330`
- [Implemented] Card buttons for To-do, In Progress running/awaiting, paused, Custom, and Done (… menu) — `rules.ts:25-36`, `triage.tsx:367,435-443`
- [Partial] In Progress (queued) — `rules.ts:30` has no ▶ Resume
- [Partial] Review "Open in terminal" — hidden when `dispatch.sessionId` is missing (`rules.ts:32`)
- [Partial] "Reopen to To-do" from Done — `app.tsx:263-264` calls `board.move`, which logs `moved`, not `reopened`
- [Implemented] Card fields toggle, saved in settings — `triage.tsx:10-18,57`, `shared/settings.ts:8-16`
- [Implemented] Manual ordering; new cards on top; In Progress auto-sort; sort dropdown — `board.ts:71,89-95,163-168,407-434`, `app.tsx:409-422`
- [Implemented] Filters (source, provider, snoozed, dismissed) — `triage.tsx:206-258`, `board.ts:482-489`
- [Implemented] Header and New actionable form — `triage.tsx:65-92`, `overlays.tsx:63-150`
- [Partial] Details panel — `desktop/renderer/src/views/details.tsx:80-264` has everything except the `instructions` override, which is not shown until a dispatch exists (`details.tsx:142-165`)
- [Implemented] ⌘K search over title/body/source/id across all cards, including Done/Dismissed/Snoozed/archived; Enter opens the panel — `board.ts:508-515`, `overlays.tsx:10-60` (capped at 50 results)

## §7 Agent dispatch
- [Partial] Provider interface — `shared/provider.ts:34-45` uses `start(request, sink)` with a push sink instead of `dispatch(actionable, opts)` + `events(id): AsyncIterable`, and `answer` takes a questionId. Functionally equivalent.
- [Implemented] `claude` on PATH, with the login-shell PATH imported — `claude/index.ts:46-51,161-169`, `desktop/main/index.ts:72`
- [Implemented] Headless Agent SDK streaming; session id stored and resumed — `claude/index.ts:116-130`, `runner.ts:189,218-219`
- [Partial] Worktree naming — `runner.ts:120-128,198-205` uses displayId (GT-###) rather than the uuid. It branches from the local `defaultBranch` without a fetch, so the base can be stale.
- [Partial] Reuse of the recorded worktree ✔ — `runner.ts:176` only checks `exists(path)`. After a repository change the agent runs in the old repo's checkout, and any pre-existing directory at that path is adopted as Gantry's.
- [Implemented] Pause / Resume / Stop semantics — `claude/index.ts:187-212`, `runner.ts:285-337`
- [Partial] Paused session across an app restart — `runner.ts:392-395` `recover()` turns paused cards into Stopped, and re-dispatch drops the sessionId (`runner.ts:121-134`), so the session can't be resumed.
- [Implemented] Cleanup on Done and Delete-all via `git worktree remove <recorded path>` — `runner.ts:370-384,403-405`
- [Implemented] Awaiting input for AskUserQuestion and permission prompts — `claude/index.ts:74-106`, `runner.ts:228-238,339-351`
- [Partial] Open in terminal — `claude/index.ts:220-223` supports Terminal.app only. Orca is never detected.
- [Implemented] Structured result → `result`; PR link added; Failed tag — `shared/conventions.ts:10-11`, `claude/result.ts`, `runner.ts:255-283`
- [Implemented] Dispatch sheet when confirm is on or the repo can't be inferred; instructions built from fetched context; repo inferred or picked from a dropdown — `runner.ts:34-44,94,104`, `desktop/main/domain/repositories.ts:13-20`, `app.tsx:216-219`
- [Partial] Agent provider + model — the sheet lets you pick the model only (`overlays.tsx:230-238`). Without the sheet `model` is `undefined` when `defaultModel` is unset (`runner.ts:124`), so the SDK default runs, not the model the preview shows.
- [Partial] Permission presets mapped to SDK mode and tools ✔ — `policy.ts:26-64` maps them with bypassable regexes (see Risk 1)
- [Implemented] Concurrency default 3, `Queued` tag, auto-start — `settings.ts:58`, `runner.ts:138-167,296-308`. Raising the limit does not drain the queue.
- [Partial] Setup command — `runner.ts:206-209` logs the output and fails on a non-zero exit, but the worktree is kept, so a retry skips setup (`runner.ts:176`).
- [Implemented] `gh auth` check for Full in the dispatch sheet — `runner.ts:84-86,116`, `overlays.tsx:243-249`
- [Missing] Welcome step 3 `gh auth` check — `welcome.tsx:110-145` never shows `checks.gh`
- [Implemented] Transcript per dispatch, same retention, "Open transcript" — `board.ts:476,588-597`, `details.tsx:227-230`
- [Partial] Cost per dispatch and "today" sum — `runner.ts:221-226`, `shell.tsx:70-78`. "Today" groups by `started_at`, so a dispatch that started yesterday is excluded.

## §8 Integrations (intro)
- [Implemented] One grant per provider — `worker/store.ts:74-78`
- [Implemented] Status labels — `desktop/renderer/src/views/connections.tsx:8,69`
- [Partial] Manage access and Disconnect render only while Connected — `connections.tsx:76-88`. A dead grant in "Reconnect required" can't be disconnected.
- [Implemented] Per-trigger toggles; existing work untouched — `connections.tsx:115`, `context.ts:161-164`
- [Implemented] Webhooks → inbox → the same trigger code as polling — `worker/app.ts:372-402`, `ingestion/index.ts:79-82`, `ingestion/github.ts:336`
- [Implemented] GitHub reconcile every 5–10 min — `ingestion/index.ts:32`
- [Partial] Reconcile backfill — GitHub mentions are never searched (`ingestion/github.ts:352-372,423-428`), so a missed webhook means a lost mention
- [Implemented] GitHub `x-ratelimit-remaining` (backs off at ≤5% left) and Slack `Retry-After` — `context.ts:46-52`
- [Missing] Gmail quota-unit tracking — `context.ts:46-55` only reacts to a 429. A 403 `rateLimitExceeded` is treated as a plain HttpError.

## §8.1 GitHub
- [Implemented] Failing CI matching — `github.ts:147-157,311-312`
- [Partial] Failing CI resolve — `github.ts:162,337`: green checks are seen only by reconcile (the green webhook is ignored), so resolution lags up to 10 min
- [Implemented] Merge conflicts match + resolve — `github.ts:173-176,313`
- [Partial] Changes requested resolve — `github.ts:190,337`: the review `dismissed` webhook is not handled; only reconcile catches it
- [Implemented] Review requests: me only, team requests ignored; resolve on submitted, removed, or closed — `github.ts:166,170,184,360`
- [Implemented] Mentions match (issue/PR/review comments) — `github.ts:191,194-201`
- [Partial] Mentions resolve — `github.ts:162,218,405-420`: besides "user replied" (the PRD's only condition) it also resolves on issue closed, PR merged, or inaccessible
- [Implemented] Dependabot threshold default `high`; resolves when fixed or dismissed — `settings.ts:64`, `github.ts:205-211,376`
- [Implemented] New issues: assigned-to-me or any-new toggle; resolves on close — `shared/triggers.ts:30`, `github.ts:216-223,357-369`
- [Implemented] Auto-resolve column rules — `board.ts:316-330`

## §8.2 Slack
- [Partial] Channel allow/deny ✔ — `slack.ts:59-71` needs `conversations.info`, but the user scopes (`worker/oauth.ts:36`) lack `channels:read`/`groups:read`. Any list entry breaks all channel events.
- [Implemented] Unreplied-after-N-min, default 30 — `settings.ts:65`, `slack.ts:97-135`
- [Implemented] LLM provider (in Preferences › AI)
- [Implemented] New mentions: channels + DMs; @here/@channel only in DMs — `slack.ts:54-57`
- [Partial] Follow-up conversations — logic at `slack.ts:143-183`. It also hits the allow/deny `conversations.info` issue (`slack.ts:174`). The `search:read` dependency is out of scope.
- [Implemented] Events API delivery with signature + replay check, routed by team:user — `worker/app.ts:389-402`
- [Implemented] Mention detection by user id; original text kept on the card — `slack.ts:56,80-81`

## §8.3 Gmail
- [Implemented] Inbox/unread/category/domain/label filters — `ingestion/gmail.ts:33-48`
- [Implemented] Optional LLM gate — `gmail.ts:112`
- [Implemented] Polling only (60 s) — `ingestion/index.ts:33`
- [Implemented] Expired OAuth → Reconnect required, cards kept, connection event logged — `worker/app.ts:310-319`, `context.ts:83,108-110,147-149`

## §8.4 API & custom sources
- [Implemented] `POST /v1/actionables` with Bearer token + zod — `worker/app.ts:113-150,245`, `shared/api.ts:6-18`
- [Implemented] Tokens created in Connections, stored hashed, shown once — `worker/app.ts:219-234`
- [Implemented] Response `{id, url: gantry://actionable/<id>}` — `worker/app.ts:149`
- [Partial] Idempotent update on `source.name + external_id` — the key is `api:${name}:${external_id}` (`ingestion/index.ts:53`, `board.ts:237`). A re-POST ignores priority, instructions, and repository (`board.ts:270-289`). A re-POST to a dismissed card is dropped as `ignored:duplicate` (`board.ts:265-269`).
- [Implemented] `auto_start` ignores confirm and respects concurrency — `board.ts:261,292-294`
- [Implemented] Unknown repository → To-do + `Needs repository`; auto-start deferred — `board.ts:241,254-257,297-307`
- [Partial] PATCH/dismiss queued and applied on the next poll ✔ — `worker/app.ts:247-255`, `board.ts:332-353`. Targets are not limited to API-source cards (Risk 2). Dismiss failures are swallowed by console.error after the item is acked (`board.ts:351-352`). Lookup by bare `external_id` can't match the stored `api:name:id` key (`board.ts:139`).
- [Implemented] No GET route; "Send test actionable" — `connections.tsx:357-361`, `worker/app.ts:243`

## §9 LLM detection layer
- [Implemented] Anthropic / OpenAI / OpenAI-compatible — `ingestion/llm.ts:20,48-62`
- [Implemented] Key in safeStorage — `desktop/main/api.ts:141`
- [Partial] Model default `claude-haiku-5-5` — `settings.ts:76`. Switching the provider to OpenAI keeps that model id, so every call fails. OpenAI-compatible with an empty base URL fetches a relative URL (`llm.ts:49`, `preferences.tsx:188`).
- [Implemented] Calls go directly from the app; Received event with verdict + reason; `AI detected` tag — `context.ts:171-175`, `board.ts:239-240`

## §10 Activity log
- [Implemented] Filters by type, source, text, actionable — `board.ts:561-586`, `activity.tsx:91-94`
- [Partial] Date filter — `activity.tsx:47-52` offers only presets (Today/7d/30d/All); no custom range
- [Partial] Text filter — `board.ts:573` (server) matches only title/detail, while the live filter (`activity.tsx:73`) also matches displayId. `%` and `_` are not escaped.
- [Partial] Source filter options come only from events already loaded — `activity.tsx:122`
- [Implemented] Live updates; JSON/CSV export; retention default 90 d enforced — `board.ts:204,474-476`, `api.ts:43-49,105-111`, `desktop/main/index.ts:202-203`
- [Implemented] Event fields; click opens card; card lists its events; "Load earlier events" — `shared/events.ts:35-47`, `activity.tsx:233,258-262`, `board.ts:576-584`
- [Implemented] Event types emitted in main: received (created / ignored:*), dispatched, paused, resumed, awaiting_input, answered, stopped, completed, failed, done, reopened, dismissed, snoozed, unsnoozed, moved, resolved_externally, connection
- [Missing] `agent_update` ✔ — grep finds no emitter in `desktop/main`. Agent output only goes to the transcript and the `agent.event` push (`board.ts:588-591`), so the "Agent updates" filter is always empty.
- [Partial] `paused` — not logged when the provider itself reports a paused state (`runner.ts:244-247`)

## §11 Preferences
- [Implemented] Agent defaults (provider/model, workspace, repos, preset, both confirms, max concurrent) — `preferences.tsx:60-166`
- [Implemented] Workspace Delete/Keep/Ask — `preferences.tsx:144-154`, `runner.ts:370-380` (but see §6: drag to Done bypasses it)
- [Implemented] Keep completed + auto-archive after N days (default 7), searchable — `board.ts:230-233,471-472`
- [Implemented] Snooze presets — `desktop/renderer/src/lib/snooze.ts`, `overlays.tsx:156-176`
- [Implemented] AI section (§9)
- [Implemented] Notifications per type; click opens card — `desktop/main/system/notifications.ts`, `index.ts:100-106`
- [Partial] Launch at login — `system/login-item.ts`, `index.ts:111-115`. Sync starts from `current=false`, so if the OS item is already on and the setting is off, it is never cleared.
- [Implemented] Appearance, retention, dock badge with toggle — `index.ts:90-99,114`
- [Implemented] Every keyboard shortcut in the PRD — `lib/shortcuts.ts:17-61`, `app.tsx:268-320`
- [Implemented] Account section — `preferences.tsx:292-337`
- [Partial] Delete all data — `api.ts:201-212`. All steps exist, but `git worktree remove` without `--force` fails on dirty worktrees and the error is ignored. A failed Worker `DELETE /v1/me` is only logged, and the local device token is wiped anyway, so it can't be retried (orphaned grants and inbox).
- [Implemented] Disconnect single input + `Source disconnected` tag — `api.ts:116-119`, `ingestion/index.ts:86-91`, `board.ts:379-386`

## §12 First run
- [Implemented] Name modal — `shell.tsx:102`, `overlays.tsx`
- [Implemented] Welcome 3 steps + "N of 3 complete"; step 3 requires claude + ≥1 repo — `welcome.tsx:10-20,65,110-145` (but no `gh` check, see §7)
- [Implemented] Empty-board CTAs + "Set up API access" banner — `welcome.tsx:180-202`
- [Partial] Collapse to banner / Help reopens — `triage.tsx:55` shows the full Welcome when `stats.total === 0 && !actionables.length`. If filtered/snoozed/archived state makes both zero, Welcome replaces the board, and it has no filter controls (unverified whether `stats.total` is filter-scoped). The Help button in Welcome goes to Preferences (`welcome.tsx:157`).

## §13 Worker
- [Implemented] Routes: POST/PATCH actionables, dismiss, GET inbox, POST ack, POST devices, POST grants refresh, POST auth/email, oauth callback, both webhooks, DELETE /v1/me — `worker/app.ts:157-403`
- [Partial] `GET /oauth/:provider/start` is `POST` with device auth — `worker/app.ts:257` (deliberate and safer; differs from the PRD)
- [Implemented] GitHub HMAC (constant time) and Slack signing secret + 5-min replay window — `worker/app.ts:372-375,389-397`
- [Implemented] 60 req/min per token, 429 + Retry-After; revoked tokens checked on every request — `worker/store.ts:25-33`, `worker/app.ts:68,106-122`
- [Partial] 64 KB body cap — `worker/app.ts:42-43,96-98` exempts `/webhooks/*` (1 MB)
- [Implemented] Inbox deleted on ack; 30-day TTL with a filter and hourly cron purge — `worker/app.ts:201,207-212`, `worker/store.ts:6,14,136`
- [Partial] Refresh route ✔ — `worker/app.ts:294-302` refreshes only within 5 min of `expires_at` and ignores `?force=1` (sent at `shared/worker-client.ts:73`, `context.ts:144`)
- [Partial] "Worker keeps refresh tokens" — it also stores the encrypted access token (`worker/store.ts:72-92`)
- [Partial] Webhook routing by grant → user — `worker/app.ts:379-385`. An installation is routed only if the installing `sender` is already a connected user, so an App installed by an org admin after you connect is never routed.

## §14 Non-functional
- [Implemented] Data under `~/Library/Application Support/Gantry` (overridable by `GANTRY_USER_DATA`) — `desktop/main/index.ts:30`
- [Partial] 500 cards without jank — only `memo(Card)` (`triage.tsx:364`); no virtualization. Every `board.changed` (including per-usage updates) refetches and re-sorts the whole snapshot. Not measured.
- [Implemented] Activity pagination — `board.ts:561-585`
- [Implemented] Throttled → `connection` event — `context.ts:126`
- [Implemented] Worker queues while the app is closed, 30-day TTL
- [Partial] `pnpm package` — `apps/desktop/package.json:13` runs electron-builder `--dir`, producing an unsigned .app only. The `dmg` target in `electron-builder.yml` is never built.

## §15 Deep links
- [Implemented] Scheme registered (`electron-builder.yml` protocols, `setAsDefaultProtocolClient` at `desktop/main/index.ts:218`)
- [Implemented] Running-app `open-url` and `second-instance` — `index.ts:219-227`
- [Partial] Cold launch — `index.ts:34,37-43,61-65` buffers the URL and pushes `navigate` on `did-finish-load`. If the renderer's `onPush` subscriber isn't mounted yet, the link is lost (unverified race).
- [Implemented] Targets resolve by id, display id, or alias; used by API responses and notification clicks — `board.ts:136-143`, `system/deeplink.ts:3-6`

---

## Top correctness / security risks
1. **Edit + test preset can push or mutate remotes** ✔ (`policy.ts:11,36-38`). `git -c alias.p=push p` slips past `\spush\b`. `gh api -XPOST repos/...` slips past `\s(-X)\b` because the `\b` fails before `P`. So does `curl -X POST -H "Authorization: token $(gh auth token)" ...`, as does writing a script and running `bash x.sh`. `agentEnv` forwards `GH_TOKEN`/`GITHUB_TOKEN` (`claude/index.ts:32-35`).
2. **Full preset auto-allows any push** ✔ (`policy.ts:12,40`). `FULL_ALLOWED` strips every `git … push` before the check, so `git push --force origin HEAD:main` or `git push origin --delete main` runs without asking. The PRD says only the card's branch may be pushed and remote branches are kept.
3. **Read-only preset executes and writes** (`policy.ts:7-9`). `rg --pre ./x.sh foo` runs a repo script. `find . -fprint out`, `git diff --output=path` and `tree -o file` write files.
4. **Prompt-injection exfiltration in every preset** (`policy.ts:42-43`). Untrusted GitHub/Slack/email text goes into the instructions (`runner.ts:34-44`). The agent can Read `~/.aws/credentials` (no path restriction) and WebFetch it to an attacker URL; WebFetch is allowed even in Read-only.
5. **An API token can dismiss or edit any card** ✔ (`board.ts:136-143,332-353`). A leaked Honeybadger token can `POST /v1/actionables/GT-1/dismiss` against a GitHub card that has a running agent, and the agent is killed. Targets are not restricted to `source.kind==='api'`.
6. **Forced refresh is ignored** ✔ (`worker/app.ts:294-302`). If GitHub revokes the user token early, the 401 → refresh?force=1 call returns the same token, and the connection flips to Reconnect required even though the refresh token is valid.
7. **Slack allow/deny drops channel mentions** ✔ (`slack.ts:63`, `worker/oauth.ts:36`). Add `#eng` to the allow list and `conversations.info` throws `missing_scope`. The inbox item is retried 5× and then acked and dropped (`ingestion/index.ts:111-119`), and each failing item blocks the items behind it for ~75 s.
8. **Gmail errors lose mail permanently** (`gmail.ts:113-118`). An LLM 404 (e.g. OpenAI with the default Claude model id) or a Gmail 403 is swallowed by `skipUnlessFatal` while `historyId` advances, so the email is never carded and no Received event is logged.
9. **Drag to Done leaks worktrees** ✔ (`board.ts:412`). Drag a Review card to Done and `runner.done` never runs, so the worktree stays on disk regardless of the Delete setting, and Activity logs `moved`.
10. **Repo-switch worktree reuse** ✔ (`runner.ts:176`). Stop a card on repo A, re-dispatch on repo B: the path exists, so no `worktree add` runs. The agent edits A's checkout while the dispatch records B, and later `git -C B worktree remove <A path>` fails. The same check means a failed setup command is never retried, and an unrelated directory at that path gets adopted and later removed.
11. **Paused agent leaks after moving to a custom column** (`rules.ts:44`, `board.ts:79`). Moving a paused card to a custom column makes `hasLiveAgent` false. Dismissing it then doesn't stop the provider, and Start registers a second session under the same actionableId.
12. **No fetch timeouts** (`ingestion/llm.ts:34`, `context.ts:134`). One hung LLM or API call stalls the shared `busy` chain, which freezes inbox delivery and every poller.
13. **Cross-user webhook fan-out** (`worker/app.ts:384-385`). Every GitHub webhook for an installation is queued to every routed user, including comment bodies from private repos that user may not be able to read.
14. **Unauthenticated `/v1/devices`** (`worker/app.ts:157-176`). It is limited only to 60/min per IP (all clients share an `unknown` key when the header is absent), so user and device rows in D1 can grow without bound.
15. **Inbox response size** (`worker/app.ts:200-204`). Up to 500 webhook payloads of up to 1 MB each in one response can exceed Worker limits. The poll then fails every 15 s and never drains.
16. **Duplicate Slack DM cards and LLM calls** (`slack.ts:56,79,99-100`). Each message in a 1:1 DM is its own card (`channel:ts`), and Slack retries aren't deduped by `event_id`.
