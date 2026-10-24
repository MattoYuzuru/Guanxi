import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { ThemeProvider } from './lib/theme.tsx'
import { AppearanceProvider } from './lib/appearance.tsx'
import { LocaleProvider } from './lib/locale-context.tsx'
import { PRODUCT_NAME } from './lib/brand.ts'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root container')
document.title = PRODUCT_NAME

createRoot(container).render(
  <StrictMode>
    <LocaleProvider>
      <ErrorBoundary scope="root">
        <ThemeProvider>
          <AppearanceProvider>
            <App />
          </AppearanceProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </LocaleProvider>
  </StrictMode>,
)
