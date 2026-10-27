import { createRoot } from 'react-dom/client'
import { AppProvider } from './app'
import { Shell } from './shell'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  window.gantryTransport ? (
    <AppProvider>
      <Shell />
    </AppProvider>
  ) : (
    <div className="empty-state muted">Open Gantry in the desktop app.</div>
  ),
)
