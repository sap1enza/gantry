import type { Report } from '@gantry/shared'
import { Archive, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useApp, usePush } from '../app'
import { api } from '../bridge'
import { Button, Markdown, Tag, when } from '../ui'

export function ReportsView() {
  const { run } = useApp()
  const [reports, setReports] = useState<Report[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const selected = reports.find((r) => r.id === selectedId)

  const reload = useCallback(() => api.reports.list(showArchived).then(setReports), [showArchived])
  useEffect(() => void reload(), [reload])
  usePush('reports.changed', () => void reload())

  const select = (r: Report) => {
    setSelectedId(r.id)
    if (!r.readAt) void run(api.reports.markRead(r.id))
  }
  const openLink = (url: string) => void run(api.board.openLink(url))

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p>Long-form findings that are not actionable yet.</p>
        </div>
        <div className="actions">
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={() => setShowArchived(!showArchived)} /> Show archived
          </label>
        </div>
      </div>
      <div className="reports">
        <div className="report-list">
          {reports.length === 0 && <span className="small muted" style={{ padding: 16 }}>No reports yet</span>}
          {reports.map((r) => (
            <Button key={r.id} className={`report-row ${r.id === selectedId ? 'active' : ''} ${r.readAt ? '' : 'unread'}`} onClick={() => select(r)}>
              <span className="truncate report-title">{r.title}</span>
              <span className="small muted">
                {r.source.name} · {when(r.updatedAt)}
              </span>
            </Button>
          ))}
        </div>
        <div className="report-detail">
          {selected ? (
            <>
              <div className="row">
                <h2 className="selectable grow">{selected.title}</h2>
                {!selected.archivedAt && (
                  <Button className="btn sm" onClick={() => run(api.reports.archive(selected.id))}>
                    <Archive size={12} /> Archive
                  </Button>
                )}
              </div>
              <div className="row small muted">
                {selected.source.name} · updated {when(selected.updatedAt)}
                {selected.tags.map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
              </div>
              {selected.links.map((l) => (
                <a key={l.url} className="card-link" style={{ fontSize: 12 }} href={l.url} onClick={(e) => (e.preventDefault(), openLink(l.url))}>
                  <ExternalLink size={12} /> {l.label}
                </a>
              ))}
              <Markdown source={selected.body} onLink={openLink} />
            </>
          ) : (
            <span className="small muted">Select a report</span>
          )}
        </div>
      </div>
    </>
  )
}
