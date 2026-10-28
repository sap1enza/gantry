# gantry-api

Cloudflare Worker (Hono + D1) for Gantry: device registration, per-user inbox, public actionables API, OAuth callbacks, token refresh, magic-link sign-in, GitHub webhooks. See `docs/PRD.md` sections 8 and 13.

## Configuration

Vars (`wrangler.toml` `[vars]`):

| Name | Purpose |
|---|---|
| `PUBLIC_URL` | Public origin of the Worker; used for OAuth redirect URIs and magic links |
| `EMAIL_FROM` | Sender for magic-link emails |
| `GITHUB_CLIENT_ID` | GitHub App client id (user-to-server tokens with expiry enabled) |
| `SLACK_CLIENT_ID` | Slack app client id |

Secrets (`wrangler secret put <NAME>`; locally in `.dev.vars`, see `.dev.vars.example`):

| Name | Purpose |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | Base64 32-byte AES-GCM key for stored OAuth tokens: `openssl rand -base64 32` |
| `GITHUB_CLIENT_SECRET` | GitHub App client secret |
| `GITHUB_WEBHOOK_SECRET` | GitHub App webhook secret (`X-Hub-Signature-256`) |
| `SLACK_CLIENT_SECRET` | Slack app client secret |
| `SLACK_SIGNING_SECRET` | Slack signing secret (Events API) |
| `RESEND_API_KEY` | Optional. Without it, magic links are printed to the Worker log |

## Provider setup

- GitHub App: callback URLs `<PUBLIC_URL>/oauth/github/callback` and `<PUBLIC_URL>/oauth/github_signin/callback`, "Expire user authorization tokens" on, webhook URL `<PUBLIC_URL>/webhooks/github`.

## Run locally

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in
pnpm wrangler d1 migrations apply gantry --local
pnpm dev                          # wrangler dev on :8787
pnpm test                         # vitest against a Miniflare D1
```

Use a tunnel (e.g. `cloudflared tunnel --url http://localhost:8787`) and set `PUBLIC_URL` to it when testing OAuth or webhooks.

## Deploy

```sh
pnpm wrangler d1 create gantry    # put the id in wrangler.toml
pnpm wrangler d1 migrations apply gantry --remote
pnpm deploy
```

A cron (`17 * * * *`) deletes expired inbox items, OAuth states, email links, completion codes and rate-limit windows.

## Auth completion

OAuth callbacks and magic links never finalize in the browser. They create a single-use completion code (10 minutes, bound to the device that started the flow) and redirect to `gantry://auth/complete?code=…`, also showing the code to paste. The app redeems it with `POST /auth/complete`; any other device, an expired code or a reused code gets `400 invalid_code`.
