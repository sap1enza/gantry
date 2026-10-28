export interface Env {
  DB: D1Database
  PUBLIC_URL: string
  EMAIL_FROM: string
  TOKEN_ENCRYPTION_KEY: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  GITHUB_WEBHOOK_SECRET: string
  SLACK_CLIENT_ID: string
  SLACK_CLIENT_SECRET: string
  SLACK_SIGNING_SECRET: string
  RESEND_API_KEY?: string
}

export interface AppEnv {
  Bindings: Env
  Variables: { userId: string; deviceId?: string; tokenName?: string }
}
