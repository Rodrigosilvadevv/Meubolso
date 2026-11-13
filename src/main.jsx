import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// O registro do token de push agora acontece em cloud.js, depois do login

const box = {
  color: '#fff',
  background: '#900',
  padding: 16,
  whiteSpace: 'pre-wrap',
  fontSize: 12,
  margin: 0,
  minHeight: '100vh',
}

class ErrorBoundary extends Component {
  state = { err: null }
  static getDerivedStateFromError(err) { return { err } }
  render() {
    if (this.state.err) {
      return <pre style={box}>{`ERRO DE RENDER: ${this.state.err?.message || this.state.err}\n\n${this.state.err?.stack || ''}`}</pre>
    }
    return this.props.children
  }
}

const show = msg => {
  const el = document.getElementById('root') || document.body
  el.innerHTML = ''
  const pre = document.createElement('pre')
  Object.assign(pre.style, { ...box, padding: '16px' })
  pre.textContent = msg
  el.appendChild(pre)
}

window.addEventListener('error', e => show(`ERRO: ${e.message}\n${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', e => show(`PROMISE: ${e.reason?.message || e.reason}`))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)