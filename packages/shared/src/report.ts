import type { Link } from './actionable'

export interface Report {
  id: string
  title: string
  body: string
  source: { name: string }
  externalKey?: string
  links: Link[]
  tags: string[]
  createdAt: string
  updatedAt: string
  readAt?: string
  archivedAt?: string
}
