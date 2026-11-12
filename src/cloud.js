import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { makeOauth, makeEnablePush, makeRemovePushToken, authStorage, isNative } from './nativeAuth.js'
import {
  initPurchases, resetPurchases, planFromInfo, getCustomerInfo,
  watchPurchases, purchasePlan, restorePurchases,
} from './purchases'

const SUPABASE_URL = 'https://xtwdxmrpnmzaxofuxbps.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0d2R4bXJwbm16YXhvZnV4YnBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0Mzk0MjcsImV4cCI6MjExMDAxNTQyN30.inm92mdOZNF7Ig6olSr59G6qvoB7ltN2FisNypPAHHQ'

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: isNative ? authStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: !isNative,
  },
})

export const isPlus = profile => profile?.plan === 'premium' || profile?.plan === 'plus'

export const tierOf = profile => {
  if (!profile) return 'free'
  const now = new Date()
  const hasPlan = profile.plan === 'premium' || profile.plan === 'plus'
  const hasTrial = profile.trial_until && new Date(profile.trial_until) > now
  if (hasPlan || hasTrial) {
    return profile.plan === 'plus' ? 'plus' : 'premium'
  }
  return 'free'
}

export const parseRef = code => {
  if (!code) return ''
  const clean = code.trim()
  const match = clean.match(/(?:ref=)?([A-Za-z0-9-_]{4,20})$/)
  return match ? match[1] : clean
}

// Login nativo da Apple no iOS; OAuth normal na web
export const oauth = provider => makeOauth(sb)(provider)

export const signUpPhone = async (name, tel, password) => {
  const email = `${tel.replace(/\D/g, '')}@meubolso.app`
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { name } },
  })
  if (!error && data.user) {
    await sb.from('bolso_profiles').upsert({
      user_id: data.user.id,
      name,
      created_at: new Date().toISOString(),
    })
  }
  return { data, error }
}

export const signInPhone = async (tel, password) => {
  const email = `${tel.replace(/\D/g, '')}@meubolso.app`
  return await sb.auth.signInWithPassword({ email, password })
}

export const enablePush = async user => {
  if (isNative) return makeEnablePush(sb)(user)
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
      if (error) setProfileErr(error.message)
      else { setProfile(data); setProfileErr('') }
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

    const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        setUser(session.user)
        // adia a chamada para fora do callback (evita deadlock do supabase-js)
        setTimeout(async () => {
          await fetchProfile(session.user.id)
          setStatus('in')
        }, 0)
      } else {
        setUser(null)
        setProfile(null)
        setStatus('out')
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  // Depois do login: configura RevenueCat, sincroniza o plano e registra o token de push
  useEffect(() => {
    if (!user) return
    let off = () => {}
    let dead = false
    const merge = info => {
      const p = planFromInfo(info)
      if (p) setProfile(v => (v ? { ...v, ...p } : v))
    }
    ;(async () => {
      try {
        await initPurchases(user.id)
        merge(await getCustomerInfo())
        const stop = await watchPurchases(merge)
        if (dead) stop(); else off = stop
      } catch (e) { console.warn('purchases:', e?.message) }
      // registra o token APNs já com usuário logado
      if (isNative) makeEnablePush(sb)(user).catch(() => {})
    })()
    return () => { dead = true; off() }
  }, [user?.id])

  const buy = async plan => {
    const info = await purchasePlan(plan)
    const p = planFromInfo(info)
    if (p) setProfile(v => ({ ...v, ...p }))
    return info
  }

  const restore = async () => {
    const p = planFromInfo(await restorePurchases())
    if (p) setProfile(v => ({ ...v, ...p }))
    return !!p
  }

  // Ajuste para a sua função/tabela de indicação, se houver
  const applyRef = async code => {
    const c = parseRef(code)
    if (!c) return { error: 'Código inválido.' }
    localStorage.setItem('bolso:ref', c)
    return {}
  }

  const logout = async () => {
    try { await makeRemovePushToken(sb)(user) } catch {}
    try { await resetPurchases() } catch {}
    await sb.auth.signOut()
    setUser(null)
    setProfile(null)
    setStatus('out')
  }

  return { user, profile, status, profileErr, logout, buy, restore, applyRef }
}

// Sincronização com a nuvem (ainda não implementada). O App.jsx já chama este hook.
export function useSync() {}