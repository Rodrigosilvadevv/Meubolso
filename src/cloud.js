import { useEffect, useMemo, useState } from 'react'
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

// Nome guardado no cadastro (metadata do usuário no Supabase Auth)
const nameOf = u => u?.user_metadata?.name || u?.user_metadata?.full_name || ''

// Login nativo da Apple no iOS; OAuth normal na web
export const oauth = provider => makeOauth(sb)(provider)

export const signUpPhone = async (name, tel, password) => {
  const email = `${tel.replace(/\D/g, '')}@meubolso.app`
  return await sb.auth.signUp({
    email,
    password,
    options: { data: { name } },
  })
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

// Usa um código de indicação no servidor. Devolve {} se deu certo, ou { error, final }.
// final = true quando o servidor respondeu de vez (não adianta tentar de novo).
const REF_MSG = {
  invalid: 'Código não encontrado. Confira e tente de novo.',
  self: 'Você não pode usar o seu próprio código.',
  already: 'Você já usou um código de indicação.',
}
const claimRef = async c => {
  const { data, error } = await sb.rpc('bolso_claim_referral', { p_code: c })
  if (error) return { error: 'Não foi possível validar o código agora.' }
  if (REF_MSG[data]) return { error: REF_MSG[data], final: true }
  return {}
}
// Único dado local que sobra: o código de indicação ANTES do login (ainda não existe usuário no banco).
// Assim que a pessoa entra, ele é enviado ao servidor e apagado do aparelho.
const refGet = () => { try { return localStorage.getItem('bolso:ref') } catch { return null } }
const refClear = () => { try { localStorage.removeItem('bolso:ref') } catch {} }

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Plano da App Store que está salvo no banco (bolso_profiles.store_plan), se ainda valer
const storedPlan = p => {
  if (!p?.store_plan) return null
  if (p.store_until && new Date(p.store_until) <= new Date()) return null
  return { plan: p.store_plan, plan_until: p.store_until || null }
}

export function useCloud() {
  const [user, setUser] = useState(null)
  // Perfil que vem do Supabase
  const [dbProfile, setDbProfile] = useState(null)
  // Plano que vem da App Store (RevenueCat), da checagem mais recente
  const [rcPlan, setRcPlan] = useState(null)
  // No iPhone, só decidimos entre app e tela de planos depois da primeira checagem da assinatura
  const [entReady, setEntReady] = useState(!isNative)
  const [status, setStatus] = useState('loading')
  const [profileErr, setProfileErr] = useState('')
  // Só decidimos entre app e tela de planos depois que o perfil foi carregado (ou falhou)
  const [profReady, setProfReady] = useState(false)

  // Junta o perfil do banco com o plano da App Store (ao vivo, ou o último salvo no banco).
  const profile = useMemo(() => {
    if (!dbProfile && !rcPlan) return null
    const store = rcPlan?.plan ? rcPlan : storedPlan(dbProfile)
    const p = { ...(dbProfile || {}), ...(store || {}) }
    // O nome do cadastro (editável em Minha conta) vale mais que o do banco
    p.name = nameOf(user) || p.name
    return p
  }, [dbProfile, rcPlan, user])

  const fetchProfile = async (userId, u) => {
    try {
      let { data, error } = await sb.from('bolso_profiles').select('*').eq('user_id', userId).maybeSingle()
      if (!error && !data) {
        // Usuário sem perfil: tenta criar agora
        const ins = await sb.from('bolso_profiles')
          .upsert({ user_id: userId, name: nameOf(u) || null }, { onConflict: 'user_id' })
          .select().maybeSingle()
        data = ins.data
      } else if (!error && data && !data.name && nameOf(u)) {
        const up = await sb.from('bolso_profiles').update({ name: nameOf(u) }).eq('user_id', userId).select().maybeSingle()
        if (up.data) data = up.data
      }
      if (error) setProfileErr(error.message)
      else { setDbProfile(data); setProfileErr('') }
    } catch (e) {
      setProfileErr(e.message || 'Erro ao carregar perfil')
    } finally {
      setProfReady(true)
    }
  }

  useEffect(() => {
    let alive = true

    withTimeout(sb.auth.getSession(), 8000)
      .then(async ({ data: { session } }) => {
        if (!alive) return
        if (session?.user) {
          setUser(session.user)
          try { await withTimeout(fetchProfile(session.user.id, session.user), 8000) } catch {}
          if (alive) setStatus('in')
        } else {
          setStatus('out')
        }
      })
      .catch(e => {
        console.warn('getSession:', e?.message)
        if (alive) setStatus('out')
      })

    const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        setUser(session.user)
        // adia a chamada para fora do callback (evita deadlock do supabase-js)
        setTimeout(async () => {
          await fetchProfile(session.user.id, session.user)
          setStatus('in')
        }, 0)
      } else {
        setUser(null)
        setDbProfile(null)
        setRcPlan(null)
        setEntReady(!isNative)
        setProfReady(false)
        setStatus('out')
      }
    })

    return () => { alive = false; subscription.unsubscribe() }
  }, [])

  // Aplica o que o RevenueCat respondeu e grava no banco. Se não veio resposta (erro de rede), não mexe em nada.
  // Se veio e não há assinatura ativa, limpa o plano guardado (assinatura acabou).
  const applyInfo = info => {
    if (!info) return null
    const p = planFromInfo(info)
    setRcPlan(p)
    setDbProfile(v => (v ? { ...v, store_plan: p?.plan || null, store_until: p?.plan_until || null } : v))
    sb.rpc('bolso_save_store_plan', { p_plan: p?.plan || null, p_until: p?.plan_until || null })
      .then(({ error }) => { if (error) console.warn('store_plan:', error.message) })
    return p
  }

  // Se o banco já tem um plano válido da App Store, o app abre direto, sem passar pela tela de planos
  useEffect(() => {
    if (isNative && storedPlan(dbProfile)) setEntReady(true)
  }, [dbProfile])

  // Depois do login: configura RevenueCat, confere a assinatura e acompanha mudanças
  useEffect(() => {
    if (!user || !isNative) return
    const uid = user.id

    let off = () => {}
    let dead = false
    // Se o RevenueCat demorar demais, segue em frente com o que já se sabe
    const timer = setTimeout(() => { if (!dead) setEntReady(true) }, 10000)

    ;(async () => {
      try {
        await initPurchases(uid)
        let info = await getCustomerInfo()
        if (!info && !dead) { await sleep(2500); info = await getCustomerInfo() }
        if (!dead) applyInfo(info)
        const stop = await watchPurchases(i => { if (!dead) applyInfo(i) })
        if (dead) stop(); else off = stop
      } catch (e) { console.warn('purchases:', e?.message) }
      finally { if (!dead) setEntReady(true) }
    })()

    return () => { dead = true; clearTimeout(timer); off() }
  }, [user?.id])

  // Login ou criação de conta: assim que há usuário, pede permissão e já salva o token de push no banco.
  useEffect(() => {
    if (!user || !isNative) return
    makeEnablePush(sb)(user).catch(e => console.warn('push:', e?.message))
  }, [user?.id])

  const buy = async plan => {
    const info = await purchasePlan(plan)
    applyInfo(info)
    return info
  }

  const restore = async () => !!applyInfo(await restorePurchases())

  // Código de indicação digitado no app: valida no servidor
  const applyRef = async code => {
    const c = parseRef(code)
    if (!c) return { error: 'Código inválido.' }
    if (!user) {
      try { localStorage.setItem('bolso:ref', c) } catch {}
      return {}
    }
    const r = await claimRef(c)
    if (!r.error || r.final) refClear()
    return r.error ? { error: r.error } : {}
  }

  // Quem criou a conta por um link de indicação: assim que entra, o código vai para o servidor
  useEffect(() => {
    if (!user) return
    const c = refGet()
    if (!c) return
    claimRef(c).then(r => { if (!r.error || r.final) refClear() }).catch(() => {})
  }, [user?.id])

  const logout = async () => {
    try { await makeRemovePushToken(sb)(user) } catch {}
    try { await resetPurchases() } catch {}
    try { await sb.auth.signOut({ scope: 'local' }) } catch {}
    setUser(null)
    setDbProfile(null)
    setRcPlan(null)
    setEntReady(!isNative)
    setProfReady(false)
    setStatus('out')
  }

  // Salva o nome no cadastro (Supabase Auth) e espelha no perfil para aparecer na saudação
  const saveName = async name => {
    const n = (name || '').trim()
    if (!n || !user) return { error: 'Digite seu nome.' }
    const { data, error } = await sb.auth.updateUser({ data: { name: n, full_name: n } })
    if (error) return { error: error.message }
    if (data?.user) setUser(data.user)
    try { await sb.rpc('set_my_name', { p_name: n }) } catch {}
    return {}
  }

  // Enquanto o perfil e a assinatura não foram conferidos, o app mostra "Carregando…" em vez da tela de planos
  const shownStatus = status === 'in' && !(entReady && profReady) ? 'loading' : status

  return { user, profile, status: shownStatus, profileErr, logout, buy, restore, applyRef, saveName }
}