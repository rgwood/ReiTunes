import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { enableRemoteLogging } from './utils/remoteLogger'

// Enable remote logging in development so frontend logs appear in `just logs`
enableRemoteLogging()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
