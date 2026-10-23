import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { loadPersistedState } from './lib/persist'

// Stores read persisted state when their modules load, so load it before importing the app
await loadPersistedState()
// Apply the saved theme before the first paint so light mode doesn't flash dark
const themes = await import('./lib/themes')
themes.migrateAccentSetting()
themes.applyCurrentTheme()
const [{ App }, { queryClient }] = await Promise.all([import('./App'), import('./lib/queries')])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
)
