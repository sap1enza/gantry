import type { SourceKind } from './actionable'
import type { OAuthProvider } from './api'

export const SECRET_KEYS = {
  grant: (provider: OAuthProvider) => `grant.${provider}`,
} as const

export const RESULT_BLOCK_TAG = 'gantry-result'

export const COMPLETION_INSTRUCTIONS = `When you finish, end your final message with a fenced code block tagged \`${RESULT_BLOCK_TAG}\` containing JSON with exactly these keys:
{"summary": string, "filesChanged": string[], "branch": string | null, "prUrl": string | null, "testsRun": string | null, "openQuestions": string[]}`

export const DEEP_LINKS = {
  scheme: 'gantry',
  actionable: (id: string) => `gantry://actionable/${id}`,
  authComplete: (code: string) => `gantry://auth/complete?code=${encodeURIComponent(code)}`,
} as const

export const PROVIDER_SOURCE: Record<OAuthProvider, SourceKind> = { github: 'github' }

export const GITHUB_FAILED_CONCLUSIONS: readonly string[] = ['failure', 'timed_out', 'startup_failure', 'action_required']
