import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { sb } from './cloud'
import './index.css'
import App from './App.jsx'

export function MainRoot() {
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      PushNotifications.requestPermissions().then(permission => {
        if (permission.receive === 'granted') {
          PushNotifications.register()
        }
      })

      PushNotifications.addListener('registration', async token => {
        const { data: { session } } = await sb.auth.getSession()
        if (session?.user) {
          await sb.from('bolso_push_tokens').upsert({
            user_id: session.user.id,
            token: token.value,
            updated_at: new Date().toISOString()
          }, { onConflict: 'token' })
        }
      })

      PushNotifications.addListener('registrationError', err => {
        console.error('Erro ao registrar push:', err.error)
      })
    }
  }, [])

  return (
    <StrictMode>
      <App />
    </StrictMode>
  )
}

createRoot(document.getElementById('root')).render(<MainRoot />)