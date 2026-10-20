import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './app/App'
import { watchPasswordRecovery } from './app/recovery'
import './styles/index.css'

registerSW({ immediate: true })
// Before anything renders, so a reset link can never show the app first.
watchPasswordRecovery()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
