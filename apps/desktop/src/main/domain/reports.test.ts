import { describe, expect, it } from 'vitest'
import { setup } from './testing'

const request = { title: 'Flaky checkout', body: '# Notes', source: { name: 'Claude triage' }, external_id: 'checkout', tags: ['recurring'] }

describe('reports', () => {
  it('creates a report keyed by source and external id', () => {
    const { reports, pushes } = setup()
    reports.upsert(request, 'r1')
    expect(reports.list()).toMatchObject([{ id: 'r1', title: 'Flaky checkout', source: { name: 'Claude triage' }, externalKey: 'Claude triage:checkout', links: [], tags: ['recurring'] }])
    expect(pushes).toContainEqual({ type: 'reports.changed' })
  })

  it('falls back to the API source and the generated id for the key', () => {
    const { reports } = setup()
    reports.upsert({ title: 't', body: 'b' }, 'r1')
    expect(reports.list()[0]).toMatchObject({ source: { name: 'API' }, externalKey: 'API:r1' })
  })

  it('makes an updated report unread and unarchived again', () => {
    const { reports, advance } = setup()
    reports.upsert(request, 'r1')
    reports.markRead('r1')
    reports.archive('r1')
    advance(1000)
    reports.upsert({ ...request, title: 'Still flaky' }, 'r2')
    const [report] = reports.list()
    expect(reports.list()).toHaveLength(1)
    expect(report).toMatchObject({ id: 'r1', title: 'Still flaky', createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:01.000Z' })
    expect(report!.readAt).toBeUndefined()
    expect(report!.archivedAt).toBeUndefined()
  })

  it('hides archived reports unless asked and lists newest first', () => {
    const { reports, advance } = setup()
    reports.upsert({ ...request, external_id: 'a' }, 'a')
    advance(1000)
    reports.upsert({ ...request, external_id: 'b' }, 'b')
    reports.archive('a')
    expect(reports.list().map((r) => r.id)).toEqual(['b'])
    expect(reports.list(true).map((r) => r.id)).toEqual(['b', 'a'])
    reports.markRead('b')
    expect(reports.list()[0]!.readAt).toBeDefined()
  })
})
