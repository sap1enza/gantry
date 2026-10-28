import type { SourceKind } from './actionable'

export const TRIGGERS = {
  'github.ci_failed': { source: 'github', label: 'Pull requests with failing CI', tag: 'CI failed', autoResolves: true },
  'github.merge_conflict': { source: 'github', label: 'Pull requests with merge conflicts', tag: 'Merge conflicts', autoResolves: true },
  'github.changes_requested': { source: 'github', label: 'Pull requests with changes requested', tag: 'Changes requested', autoResolves: true },
  'github.review_requested': { source: 'github', label: 'Review requests', tag: 'Review requested', autoResolves: true },
  'github.mention': { source: 'github', label: 'Mentions', tag: 'Mentioned', autoResolves: true },
  'github.dependabot': { source: 'github', label: 'Dependabot security alerts', tag: 'Dependabot', autoResolves: true },
  'github.issue': { source: 'github', label: 'New issues', tag: 'Issue', autoResolves: true },
  'slack.mention': { source: 'slack', label: 'New mentions', tag: 'Mention', autoResolves: false },
  'slack.unreplied': { source: 'slack', label: 'Unreplied mentions', tag: 'Needs reply', autoResolves: false },
  'slack.follow_up': { source: 'slack', label: 'Conversations needing follow-up', tag: 'Follow-up', autoResolves: false },
  'api.custom': { source: 'api', label: 'Custom API source', tag: 'API', autoResolves: false },
  manual: { source: 'manual', label: 'Created manually', tag: 'Manual', autoResolves: false },
} as const satisfies Record<string, { source: SourceKind; label: string; tag: string; autoResolves: boolean }>

export type TriggerId = keyof typeof TRIGGERS

export const DEFAULT_ENABLED_TRIGGERS: Record<TriggerId, boolean> = {
  'github.ci_failed': true,
  'github.merge_conflict': true,
  'github.changes_requested': true,
  'github.review_requested': true,
  'github.mention': true,
  'github.dependabot': true,
  'github.issue': false,
  'slack.mention': true,
  'slack.unreplied': true,
  'slack.follow_up': true,
  'api.custom': true,
  manual: true,
}
