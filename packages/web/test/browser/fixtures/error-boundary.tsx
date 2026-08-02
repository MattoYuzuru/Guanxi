import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '../../../src/components/ErrorBoundary.tsx'
import '../../../src/index.css'

function BrokenChat(): never {
  throw new TypeError('fixture render failure')
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')

createRoot(root).render(
  <ErrorBoundary scope="chat">
    <BrokenChat />
  </ErrorBoundary>,
)
