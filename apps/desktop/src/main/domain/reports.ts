import type { CreateReportRequest, GantryPush, Report } from '@gantry/shared'
import type { Db } from '../db'

export interface ReportsDeps {
  db: Db
  push(push: GantryPush): void
  now?: () => Date
}

const parse = (row: unknown) => JSON.parse((row as { data: string }).data) as Report

export class Reports {
  constructor(private deps: ReportsDeps) {}

  private iso() {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  private write(report: Report, dedupeKey?: string) {
    this.deps.db
      .prepare('INSERT INTO reports (id, dedupe_key, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(report.id, dedupeKey ?? null, JSON.stringify(report))
    this.deps.push({ type: 'reports.changed' })
  }

  private get(id: string) {
    const row = this.deps.db.prepare('SELECT data FROM reports WHERE id = ?').get(id)
    return row ? parse(row) : undefined
  }

  upsert(request: CreateReportRequest, id: string) {
    const name = request.source?.name ?? 'API'
    const externalKey = `${name}:${request.external_id ?? id}`
    const existing = this.deps.db.prepare('SELECT data FROM reports WHERE dedupe_key = ?').get(externalKey)
    const now = this.iso()
    const { readAt: _read, archivedAt: _archived, ...current } = existing ? parse(existing) : ({ id, createdAt: now } as Report)
    this.write(
      { ...current, title: request.title, body: request.body, source: { name }, externalKey, links: request.links ?? [], tags: request.tags ?? [], updatedAt: now },
      externalKey,
    )
  }

  list(showArchived = false) {
    return this.deps.db
      .prepare(`SELECT data FROM reports ${showArchived ? '' : "WHERE json_extract(data, '$.archivedAt') IS NULL"} ORDER BY json_extract(data, '$.updatedAt') DESC`)
      .all()
      .map(parse)
  }

  markRead(id: string) {
    const report = this.get(id)
    if (report && !report.readAt) this.write({ ...report, readAt: this.iso() })
  }

  archive(id: string) {
    const report = this.get(id)
    if (report && !report.archivedAt) this.write({ ...report, archivedAt: this.iso() })
  }
}
