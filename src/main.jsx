import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// O registro do token de push agora acontece em cloud.js, depois do login
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)