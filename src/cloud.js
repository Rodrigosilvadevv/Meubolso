import { useEffect, useMemo, useRef, useState } from 'react'
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

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- Último plano conhecido (vindo da App Store) ----------
// Serve só para o app abrir direto, sem piscar a tela de planos. A checagem real no RevenueCat
// roda em seguida e corrige se a assinatura tiver acabado.
const planCacheKey = id => `bolso:plan:${id}`

const readPlanCache = id => {
  try {
    const c = JSON.parse(localStorage.getItem(planCacheKey(id)) || 'null')
    if (!c?.plan) return null
    if (c.plan_until && new Date(c.plan_until) <= new Date()) return null
    return c
  } catch { return null }
}

const writePlanCache = (id, p) => {
  try {
    if (p) localStorage.setItem(planCacheKey(id), JSON.stringify(p))
    else localStorage.removeItem(planCacheKey(id))
  } catch {}
}

export function useCloud() {
  const [user, setUser] = useState(null)
  // Perfil que vem do Supabase
  const [dbProfile, setDbProfile] = useState(null)
  // Plano que vem da App Store (RevenueCat). Fica separado para o perfil do banco nunca apagá-lo.
  const [rcPlan, setRcPlan] = useState(null)
  // No iPhone, só decidimos entre app e tela de planos depois da primeira checagem da assinatura
  const [entReady, setEntReady] = useState(!isNative)
  const [status, setStatus] = useState('loading')
  const [profileErr, setProfileErr] = useState('')
  // Só decidimos entre app e tela de planos depois que o perfil foi carregado (ou falhou)
  const [profReady, setProfReady] = useState(false)

  // Junta o perfil do banco com o plano da App Store. Se o perfil não tem nome, usa o do cadastro.
  // A App Store só sobrescreve o plano quando há assinatura ativa; sem ela, vale o que está no banco.
  const profile = useMemo(() => {
    if (!dbProfile && !rcPlan) return null
    const p = { ...(dbProfile || {}), ...(rcPlan?.plan ? rcPlan : {}) }
    // O nome do cadastro (editável em Minha conta) vale mais que o do banco
    p.name = nameOf(user) || p.name
    return p
  }, [dbProfile, rcPlan, user])

  const fetchProfile = async (userId, u) => {
    try {
      let { data, error } = await sb.from('bolso_profiles').select('*').eq('user_id', userId).maybeSingle()
      if (!error && !data) {
        // Usuário sem perfil: cria um agora
        const ins = await sb.from('bolso_profiles')
          .upsert({ user_id: userId, name: nameOf(u) || null }, { onConflict: 'user_id' })
          .select().maybeSingle()
        // Se o banco não deixar criar o perfil por aqui, segue sem perfil e sem mostrar erro
        data = ins.data
      } else if (!error && data && !data.name && nameOf(u)) {
        // Perfil sem nome (o nome pode chegar depois do login): grava o nome do cadastro
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

  // Aplica o que o RevenueCat respondeu. Se não veio resposta (erro de rede), não mexe em nada.
  // Se veio e não há assinatura ativa, limpa o plano guardado (assinatura acabou).
  const applyInfo = (info, uid) => {
    if (!info) return null
    const p = planFromInfo(info)
    setRcPlan(p)
    if (uid) writePlanCache(uid, p)
    return p
  }

  // Depois do login: configura RevenueCat, confere a assinatura e acompanha mudanças
  useEffect(() => {
    if (!user || !isNative) return
    const uid = user.id

    // Mostra de cara o último plano conhecido, para o app abrir sem passar pela tela de planos
    const cached = readPlanCache(uid)
    if (cached) { setRcPlan(cached); setEntReady(true) }

    let off = () => {}
    let dead = false
    // Se o RevenueCat demorar demais, segue em frente com o que já se sabe
    const timer = setTimeout(() => { if (!dead) setEntReady(true) }, 10000)

    ;(async () => {
      try {
        await initPurchases(uid)
        let info = await getCustomerInfo()
        if (!info && !dead) { await sleep(2500); info = await getCustomerInfo() }
        if (!dead) applyInfo(info, uid)
        const stop = await watchPurchases(i => { if (!dead) applyInfo(i, uid) })
        if (dead) stop(); else off = stop
      } catch (e) { console.warn('purchases:', e?.message) }
      finally { if (!dead) setEntReady(true) }
    })()

    return () => { dead = true; clearTimeout(timer); off() }
  }, [user?.id])

  // Login ou criação de conta: assim que há usuário, pede permissão e já salva o token de push.
  // Roda separado do RevenueCat para não depender dele. Também roda a cada abertura do app.
  useEffect(() => {
    if (!user || !isNative) return
    makeEnablePush(sb)(user).catch(e => console.warn('push:', e?.message))
  }, [user?.id])

  const buy = async plan => {
    const info = await purchasePlan(plan)
    applyInfo(info, user?.id)
    return info
  }

  const restore = async () => !!applyInfo(await restorePurchases(), user?.id)

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
    try { await sb.auth.signOut({ scope: 'local' }) } catch {}
    setUser(null)
    setDbProfile(null)
    setRcPlan(null)
    setEntReady(!isNative)
    setProfReady(false)
    setStatus('out')
  }

  // Salva o nome no perfil (e no cadastro) para aparecer na saudação
  const saveName = async name => {
    const n = (name || '').trim()
    if (!n || !user) return { error: 'Digite seu nome.' }
    // O nome fica no cadastro do usuário (não depende de permissão na tabela de perfis)
    const { data, error } = await sb.auth.updateUser({ data: { name: n, full_name: n } })
    if (error) return { error: error.message }
    if (data?.user) setUser(data.user)
    // Extra: espelha no perfil do banco se a função set_my_name existir; se falhar, não atrapalha
    try { await sb.rpc('set_my_name', { p_name: n }) } catch {}
    return {}
  }

  // Enquanto o perfil e a assinatura não foram conferidos, o app mostra "Carregando…" em vez da tela de planos
  const shownStatus = status === 'in' && !(entReady && profReady) ? 'loading' : status

  return { user, profile, status: shownStatus, profileErr, logout, buy, restore, applyRef, saveName }
}

// ---------- Resumo para os avisos programados ----------
// Só no iPhone: envia ao servidor um resumo pequeno (vencimentos, metas, limites e data do último gasto)
// para a Edge Function bolso-scheduled-push decidir quais avisos mandar. Não envia a lista de gastos.
const isoDate = d => {
  if (!d) return null
  if (typeof d === 'string') return d.slice(0, 10)
  const x = new Date(d)
  if (isNaN(x)) return null
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

const num = n => (Number.isFinite(Number(n)) ? Number(n) : 0)

const buildSnapshot = (s, P) => {
  const dates = (s?.spends || []).map(x => isoDate(x?.date)).filter(Boolean).sort()
  return {
    v: 1,
    cycleStart: isoDate(P?.start),
    cycleEnd: isoDate(P?.end),
    lastSpend: dates.length ? dates[dates.length - 1] : null,
    bills: (s?.fixed || [])
      .filter(f => f && Number(f.day) >= 1 && Number(f.day) <= 31)
      .map(f => ({ id: String(f.id), name: String(f.name || 'Conta'), value: num(f.value), day: Number(f.day) })),
    goals: (P?.goals || [])
      .filter(g => g && num(g.target) > 0)
      .map(g => ({ id: String(g.id), name: String(g.name || 'Objetivo'), target: num(g.target), saved: num(g.saved) })),
    budget: {
      essencial: { used: num(P?.spent?.('essencial')), limit: num(s?.varEss) },
      livre: { used: num(P?.spent?.('livre')), limit: num(P?.livreVar) },
    },
  }
}

// Sincronização do resumo com a nuvem. Espera 2,5 s depois da última mudança e só envia se algo mudou.
export function useSync(s, setS, ok, user, profile, P) {
  const last = useRef('')
  const uid = user?.id
  useEffect(() => { last.current = '' }, [uid])
  useEffect(() => {
    if (!ok || !uid || !isNative || !P) return
    const t = setTimeout(async () => {
      try {
        const snapshot = buildSnapshot(s, P)
        const key = JSON.stringify(snapshot)
        if (key === last.current) return
        const { error } = await sb.from('bolso_push_state')
          .upsert({ user_id: uid, snapshot, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
        if (error) console.warn('push_state:', error.message)
        else last.current = key
      } catch (e) { console.warn('push_state:', e?.message) }
    }, 2500)
    return () => clearTimeout(t)
  }, [s, P, ok, uid])
}