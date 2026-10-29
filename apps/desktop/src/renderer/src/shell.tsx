import { Activity, Blocks, Columns3, FileText, PanelLeft, Plug, Search, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useApp, type View } from './app'
import { ActivityView } from './views/activity'
import { ConnectionsView } from './views/connections'
import { DispatchSheet, NewActionableModal, SearchPalette, SnoozeMenu } from './views/overlays'
import { Onboarding } from './views/onboarding'
import { PreferencesView } from './views/preferences'
import { ReportsView } from './views/reports'
import { TriageView } from './views/triage'
import { initials, INPUTS, SOURCE_LABELS, SourceIcon } from './ui'

const NAV: { view: View; label: string; icon: typeof Activity }[] = [
  { view: 'triage', label: 'Triage', icon: Columns3 },
  { view: 'reports', label: 'Reports', icon: FileText },
  { view: 'activity', label: 'Activity', icon: Activity },
  { view: 'connections', label: 'Connections', icon: Plug },
]
const TITLES: Record<View, string> = { triage: 'Triage', reports: 'Reports', activity: 'Activity', connections: 'Connections', preferences: 'Preferences' }

export function Shell() {
  const app = useApp()
  const [sidebar, setSidebar] = useState(true)
  const stats = app.snapshot?.stats
  const welcome = app.view === 'triage' && app.snapshot && ((app.snapshot.stats.total === 0 && !app.filter.today) || app.showWelcome)

  if (app.account && !app.account.onboarded) return <Onboarding />

  return (
    <div className={`app ${sidebar ? '' : 'no-sidebar'}`}>
      <header className="titlebar">
        <button className="icon-btn" aria-label="Toggle sidebar" onClick={() => setSidebar(!sidebar)}>
          <PanelLeft size={15} />
        </button>
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <b>Gantry</b>
          <span>/</span>
          <span>{welcome ? 'Welcome to Gantry' : TITLES[app.view]}</span>
        </nav>
        <button className="search-trigger" onClick={() => app.setSearchOpen(true)}>
          <Search size={13} />
          Search actionables
          <span className="kbd">⌘ K</span>
        </button>
      </header>

      <aside className="sidebar" hidden={!sidebar}>
        <div className="workspace">
          <div className="logo">
            <Blocks size={15} />
          </div>
          <div>
            <b>Gantry</b>
            <span>Personal workspace</span>
          </div>
        </div>
        {NAV.map(({ view, label, icon: Icon }) => (
          <button key={view} className={`nav ${app.view === view ? 'active' : ''}`} onClick={() => app.go(view)}>
            <Icon size={15} />
            {label}
            {view === 'triage' && <span className="count">{stats?.total ?? 0}</span>}
            {view === 'reports' && app.unreadReports > 0 && <span className="count">{app.unreadReports}</span>}
          </button>
        ))}
        <div className="eyebrow">Inputs</div>
        {INPUTS.map(({ provider, kind }) => {
          const status = app.connections.find((c) => c.provider === provider)?.status
          return (
            <button key={provider} className="input-row" onClick={() => app.go('connections')}>
              <SourceIcon kind={kind} />
              {SOURCE_LABELS[kind]}
              <span className={`dot ${status ?? ''}`} title={status?.replace('_', ' ')} />
            </button>
          )
        })}
        <div className="spacer" />
        {stats && (stats.running > 0 || stats.paused > 0 || stats.completedToday > 0 || stats.costTodayUsd > 0) && (
          <div className="status-block" role="status">
            <b>
              {stats.running} agent{stats.running === 1 ? '' : 's'} running
            </b>
            <span>
              {stats.paused} paused · {stats.completedToday} completed today · ${stats.costTodayUsd.toFixed(2)} today
            </span>
          </div>
        )}
        <button className={`nav ${app.view === 'preferences' ? 'active' : ''}`} onClick={() => app.go('preferences')}>
          <SlidersHorizontal size={15} />
          Preferences
        </button>
        <div className="account">
          <span className="avatar">{initials(app.account?.name ?? '')}</span>
          <span className="truncate">{app.account?.name || 'Not set'}</span>
        </div>
      </aside>

      <main className="main">
        {app.view === 'triage' && <TriageView />}
        {app.view === 'reports' && <ReportsView />}
        {app.view === 'activity' && <ActivityView />}
        {app.view === 'connections' && <ConnectionsView />}
        {app.view === 'preferences' && <PreferencesView />}
      </main>

      {app.searchOpen && <SearchPalette />}
      {app.newOpen && <NewActionableModal />}
      {app.snoozeFor && <SnoozeMenu />}
      {app.dispatchFor && <DispatchSheet />}
    </div>
  )
}
