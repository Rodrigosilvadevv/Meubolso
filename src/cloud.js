import { createClient } from '@supabase/supabase-js'
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'

const SUPABASE_URL = 'https://xtwdxmrpnmzaxofuxbps.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0d2R4bXJwbm16YXhvZnV4YnBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0Mzk0MjcsImV4cCI6MjExMDAxNTQyN30.inm92mdOZNF7Ig6olSr59G6qvoB7ltN2FisNypPAHHQ'

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
})

export const isPlus = profile => profile?.plan === 'premium' || profile?.plan === 'plus'

export const parseRef = code => {
  if (!code) return ''
  const clean = code.trim()
  const match = clean.match(/(?:ref=)?([A-Za-z0-9-_]{4,20})$/)
  return match ? match[1] : clean
}

export const oauth = async provider => {
  const redirectTo = window.location.origin
  const { data, error } = await sb.auth.signInWithOAuth({
    provider,
    options: { redirectTo }
  })
  return { data, error }
}

export const signUpPhone = async (name, tel, password) => {
  const email = `${tel.replace(/\D/g, '')}@meubolso.app`
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { name } }
  })
  if (!error && data.user) {
    await sb.from('bolso_profiles').upsert({ user_id: data.user.id, name })
  }
  return { data, error }
}

export const signInPhone = async (tel, password) => {
  const email = `${tel.replace(/\D/g, '')}@meubolso.app`
  return await sb.auth.signInWithPassword({ email, password })
}

export const enablePush = async user => {
  if (Capacitor.isNativePlatform()) {
    let perm = await PushNotifications.checkPermissions()
    if (perm.receive !== 'granted') {
      perm = await PushNotifications.requestPermissions()
    }
    if (perm.receive !== 'granted') throw new Error('denied')
    await PushNotifications.register()
    return true
  }
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('denied')
  return true
}

export function useCloud() {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [status, setStatus] = useState('loading')
  const [profileErr, setProfileErr] = useState('')

  const fetchProfile = async userId => {
    try {
      const { data, error } = await sb.from('bolso_profiles').select('*').eq('user_id', userId).single()
      if (error) {
        setProfileErr(error.message)
      } else {
        setProfile(data)
      }
    } catch (e) {
      setProfileErr(e.message || 'Erro ao carregar perfil')
    }
  }

  useEffect(() => {
    sb.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        setUser(session.user)
        await fetchProfile(session.user.id)
        setStatus('in')
      } else {
        setStatus('out')
      }
    })

    const { data: { subscription } } = sb.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        setUser(session.user)
        await fetchProfile(session.user.id)
        setStatus('in')
      } else {
        setUser(null)
        setProfile(null)
        setStatus('out')
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const logout = async () => {
    await sb.auth.signOut()
    setUser(null)
    setProfile(null)
    setStatus('out')
  }

  return { user, profile, status, profileErr, logout }
}

export function useSync() {
  // Hook de sincronização vazio ou existente
}