import ReactDOM from 'react-dom/client'
import App from './App'
import { ToastProvider } from './components/Toast'
import ErrorBoundary, { PageErrorFallback } from './components/ErrorBoundary'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <ErrorBoundary
      fallback={(error, reset) => (
        <main className="mx-auto max-w-xl px-4 py-16">
          <PageErrorFallback error={error} reset={reset} what="SeaDex Companion" />
        </main>
      )}
    >
      <App />
    </ErrorBoundary>
  </ToastProvider>,
)
