import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { ThemeProvider } from './lib/theme.tsx'
import { LocaleProvider } from './lib/locale-context.tsx'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('Не найден #root')

createRoot(container).render(
  <StrictMode>
    <LocaleProvider>
      <ErrorBoundary scope="root">
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </ErrorBoundary>
    </LocaleProvider>
  </StrictMode>,
)
