import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// O registro do token de push acontece em cloud.js, depois do login

const box = {
  color: '#fff',
  background: '#900',
  padding: 16,
  whiteSpace: 'pre-wrap',
  fontSize: 12,
  margin: 0,
  minHeight: '100vh',
}

// Tela de erro de render. Em produção mostra uma mensagem simples com botão de recarregar;
// o texto técnico (stack) só aparece em desenvolvimento.
class ErrorBoundary extends Component {
  state = { err: null }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) { console.error('render:', err) }
  render() {
    if (!this.state.err) return this.props.children
    if (import.meta.env.DEV) {
      return <pre style={box}>{`ERRO DE RENDER: ${this.state.err?.message || this.state.err}\n\n${this.state.err?.stack || ''}`}</pre>
    }
    return (
      <div style={{ ...box, display: 'grid', placeContent: 'center', gap: 16, textAlign: 'center', fontSize: 16, background: '#111' }}>
        <p>Algo deu errado.</p>
        <button style={{ padding: '12px 20px', borderRadius: 12, border: 0, fontSize: 16 }} onClick={() => location.reload()}>Recarregar</button>
      </div>
    )
  }
}

// Antes, qualquer erro solto ou promessa rejeitada (ex.: uma falha de rede passageira) apagava o app
// inteiro e mostrava uma tela vermelha. Agora só aparece essa tela em desenvolvimento; em produção o erro vai para o console.
const show = msg => {
  const el = document.getElementById('root') || document.body
  el.innerHTML = ''
  const pre = document.createElement('pre')
  Object.assign(pre.style, { ...box, padding: '16px' })
  pre.textContent = msg
  el.appendChild(pre)
}

window.addEventListener('error', e => {
  console.error('erro:', e.message, e.filename, e.lineno)
  if (import.meta.env.DEV) show(`ERRO: ${e.message}\n${e.filename}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', e => {
  console.error('promessa rejeitada:', e.reason)
  if (import.meta.env.DEV) show(`PROMISE: ${e.reason?.message || e.reason}`)
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
