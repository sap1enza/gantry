import { createRoot } from 'react-dom/client'
import { AppProvider } from './app'
import { Shell } from './shell'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <AppProvider>
    <Shell />
  </AppProvider>,
)
