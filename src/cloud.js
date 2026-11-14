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
const refGet = () => { try { return localStorage.getItem('bolso:ref') } catch { return null } }
const refClear = () => { try { localStorage.removeItem('bolso:ref') } catch {} }

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

  // Código de indicação digitado no app: guarda e valida no servidor
  const applyRef = async code => {
    const c = parseRef(code)
    if (!c) return { error: 'Código inválido.' }
    try { localStorage.setItem('bolso:ref', c) } catch {}
    if (!user) return {}
    const r = await claimRef(c)
    if (!r.error || r.final) refClear()
    return r.error ? { error: r.error } : {}
  }

  // Quem criou a conta por um link de indicação: assim que entra, o código é validado
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

// ---------- Dados do usuário na nuvem (Supabase) ----------
// O Supabase é a fonte dos dados: ao entrar o app lê tudo da nuvem, e cada mudança é gravada de volta.
// O que fica no aparelho (localStorage) é só uma cópia para abrir rápido.
const OWNER = 'bolso:owner' // de quem são os dados guardados neste aparelho
const DIRTY = 'bolso:dirty' // 1 = há mudanças ainda não enviadas
const lsGet = k => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k) } catch {} }

const isoDate = d => {
  if (!d) return null
  if (typeof d === 'string') return d.slice(0, 10)
  const x = new Date(d)
  if (isNaN(x)) return null
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}
const num = n => (Number.isFinite(Number(n)) ? Number(n) : 0)
const money = n => Math.round(num(n) * 100) / 100
const okDate = d => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null)
const intOrNull = n => { const v = Math.round(Number(n)); return Number.isFinite(v) && v > 0 ? v : null }
const omit = (o, keys) => { const r = {}; for (const k in o) if (!keys.includes(k)) r[k] = o[k]; return r }
const h32 = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }

// Uma entrada por lista do app: tabela, campos conhecidos e a conversão app <-> banco
const COLL = {
  fixed: {
    table: 'bolso_fixed', known: ['name', 'value', 'level', 'day'],
    to: r => ({ name: String(r.name ?? ''), value: money(r.value), level: r.level === 'livre' ? 'livre' : 'essencial', day: intOrNull(r.day) }),
    from: d => ({ name: d.name, value: Number(d.value), level: d.level, day: d.day || 0 }),
  },
  goals: {
    table: 'bolso_goals', known: ['name', 'target', 'saved', 'date', 'delays'],
    to: r => ({ name: String(r.name ?? ''), target: money(r.target), saved: money(r.saved), date: okDate(r.date), delays: Math.max(0, Math.round(num(r.delays))) }),
    from: d => ({ name: d.name, target: Number(d.target), saved: Number(d.saved), date: d.date || '', delays: d.delays || 0 }),
  },
  deposits: {
    table: 'bolso_deposits', known: ['goalId', 'value', 'date'],
    to: r => ({ goal_id: r.goalId != null && Number.isFinite(Number(r.goalId)) ? Number(r.goalId) : null, value: money(r.value), date: okDate(r.date) || isoDate(new Date()) }),
    from: d => ({ goalId: d.goal_id, value: Number(d.value), date: d.date }),
  },
  spends: {
    table: 'bolso_spends', known: ['desc', 'value', 'bucket', 'date'], newestFirst: true,
    to: r => ({ descr: String(r.desc ?? ''), value: money(r.value), bucket: String(r.bucket || 'essencial'), date: okDate(r.date) || isoDate(new Date()) }),
    from: d => ({ desc: d.descr, value: Number(d.value), bucket: d.bucket, date: d.date }),
  },
  earns: {
    table: 'bolso_earns', known: ['desc', 'value', 'date'], newestFirst: true,
    to: r => ({ descr: String(r.desc ?? ''), value: money(r.value), date: okDate(r.date) || isoDate(new Date()) }),
    from: d => ({ desc: d.descr, value: Number(d.value), date: d.date }),
  },
}
const NAMES = Object.keys(COLL)

// Estado em branco para quem entra num aparelho que tinha dados de outra pessoa
const BLANK = { salary: 0, payDay: 5, fixed: [], varEss: 0, reservePct: 10, goals: [], deposits: [], spends: [], variable: false, earns: [], refs: 0 }

const settingsRow = s => ({
  salary: money(s.salary),
  pay_day: Math.min(31, Math.max(1, Math.round(num(s.payDay)) || 5)),
  var_ess: money(s.varEss),
  reserve_pct: Math.min(100, Math.max(0, Math.round(num(s.reservePct)))),
  variable: !!s.variable,
  hue: Math.min(360, Math.max(0, Math.round(num(s.hue ?? 172)))),
  mode: s.mode === 'light' ? 'light' : 'dark',
  hide: !!s.hide,
})

// Lista do app -> Map(id -> linha do banco). Item sem id ganha um id estável calculado do conteúdo.
const toRows = (name, list) => {
  const c = COLL[name], seen = new Map(), out = new Map()
  for (const r of list || []) {
    if (!r || typeof r !== 'object') continue
    const body = { ...c.to(r), extra: omit(r, ['id', ...c.known]) }
    let id = Number(r.id)
    if (r.id == null || r.id === '' || !Number.isFinite(id)) {
      const key = JSON.stringify(body)
      const n = (seen.get(key) || 0) + 1
      seen.set(key, n)
      id = h32(key) * 10 + n
    }
    out.set(id, { id, ...body })
  }
  return out
}

// Retrato do que já está salvo na nuvem (para só enviar o que mudou)
const baseOf = state => {
  const b = {}
  for (const n of NAMES) { b[n] = new Map(); for (const [id, row] of toRows(n, state[n])) b[n].set(id, JSON.stringify(row)) }
  b.settings = state.salary == null ? '' : JSON.stringify(settingsRow(state))
  return b
}

const fetchAll = async (table, uid) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('*').eq('user_id', uid).order('id').range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

// Lê tudo da nuvem. Devolve null se essa pessoa ainda não tem dados lá.
const loadAll = async uid => {
  const { data: st, error } = await sb.from('bolso_settings').select('*').eq('user_id', uid).maybeSingle()
  if (error) throw new Error(`bolso_settings: ${error.message}`)
  if (!st) return null
  const lists = await Promise.all(NAMES.map(n => fetchAll(COLL[n].table, uid)))
  const patch = {
    salary: Number(st.salary), payDay: st.pay_day, varEss: Number(st.var_ess), reservePct: st.reserve_pct,
    variable: !!st.variable, hue: st.hue, mode: st.mode, hide: !!st.hide,
  }
  NAMES.forEach((n, i) => {
    const rows = lists[i].map(d => ({ ...(d.extra || {}), id: Number(d.id), ...COLL[n].from(d) }))
    patch[n] = COLL[n].newestFirst ? rows.reverse() : rows
  })
  return patch
}

// Envia só o que mudou: linhas novas/alteradas e linhas apagadas. As configurações vão por último,
// então "ter configurações na nuvem" significa que o envio inicial terminou.
const syncOnce = async (uid, s, base, stillMe) => {
  for (const n of NAMES) {
    const c = COLL[n], b = base[n], rows = toRows(n, s[n])
    const str = new Map(), changed = []
    for (const [id, row] of rows) {
      const js = JSON.stringify(row)
      str.set(id, js)
      if (b.get(id) !== js) changed.push(row)
    }
    const removed = [...b.keys()].filter(id => !rows.has(id))
    for (let i = 0; i < changed.length; i += 400) {
      if (!stillMe()) return
      const part = changed.slice(i, i + 400)
      const { error } = await sb.from(c.table).upsert(part.map(r => ({ user_id: uid, ...r, updated_at: new Date().toISOString() })), { onConflict: 'user_id,id' })
      if (error) throw new Error(`${c.table}: ${error.message}`)
      part.forEach(r => b.set(r.id, str.get(r.id)))
    }
    for (let i = 0; i < removed.length; i += 200) {
      if (!stillMe()) return
      const part = removed.slice(i, i + 200)
      const { error } = await sb.from(c.table).delete().eq('user_id', uid).in('id', part)
      if (error) throw new Error(`${c.table}: ${error.message}`)
      part.forEach(id => b.delete(id))
    }
  }
  const row = settingsRow(s), js = JSON.stringify(row)
  if (base.settings !== js && stillMe()) {
    const { error } = await sb.from('bolso_settings').upsert({ user_id: uid, ...row, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    if (error) throw new Error(`bolso_settings: ${error.message}`)
    base.settings = js
  }
}

// ---------- Resumo para os avisos programados (só no iPhone) ----------
// Envia ao servidor um resumo pequeno (vencimentos, metas, limites e data do último gasto)
// para a Edge Function bolso-scheduled-push decidir quais avisos mandar.
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

// Sincronização: carrega da nuvem ao entrar e grava cada mudança (espera 1,2 s depois da última).
// Devolve true quando a carga inicial terminou.
export function useSync(s, setS, ok, user, profile, P) {
  const uid = user?.id
  const [loaded, setLoaded] = useState(false)
  const base = useRef(null)
  const sRef = useRef(s)
  const uidRef = useRef(uid)
  const busy = useRef(false)
  const again = useRef(false)
  const lastSnap = useRef('')
  sRef.current = s
  uidRef.current = uid

  // 1) Entrou: lê da nuvem
  useEffect(() => {
    setLoaded(false)
    base.current = null
    if (!ok || !uid) return
    let dead = false
    ;(async () => {
      for (let tries = 0; !dead; tries++) {
        try {
          const cloud = await loadAll(uid)
          if (dead) return
          const owner = lsGet(OWNER)
          const mine = !owner || owner === uid // os dados do aparelho são desta pessoa?
          const dirty = mine && lsGet(DIRTY) === '1' // há mudanças que ainda não subiram?
          if (cloud) {
            base.current = baseOf(cloud)
            if (!dirty) setS(v => ({ ...v, ...cloud }))
          } else {
            // Primeira vez na nuvem: sobe o que já existe neste aparelho (se for dela)
            base.current = baseOf({})
            if (!mine) setS(v => ({ ...v, ...BLANK }))
          }
          lsSet(OWNER, uid)
          setLoaded(true)
          return
        } catch (e) {
          console.warn('sync load:', e?.message)
          await new Promise(r => setTimeout(r, Math.min(30000, 4000 * (tries + 1))))
        }
      }
    })()
    return () => { dead = true }
  }, [ok, uid])

  const push = async () => {
    const me = uidRef.current
    if (!me || !base.current) return
    if (busy.current) { again.current = true; return }
    busy.current = true
    try {
      let cur
      do {
        again.current = false
        cur = sRef.current
        await syncOnce(me, cur, base.current, () => uidRef.current === me)
      } while (again.current)
      if (sRef.current === cur) lsSet(DIRTY, '')
    } catch (e) {
      console.warn('sync:', e?.message)
      setTimeout(() => { push() }, 15000)
    } finally {
      busy.current = false
    }
  }

  // 2) Mudou algo: grava na nuvem (e também ao mandar o app para segundo plano)
  useEffect(() => {
    if (!ok || !uid || !loaded) return
    lsSet(DIRTY, '1')
    const t = setTimeout(push, 1200)
    const hide = () => { if (document.visibilityState === 'hidden') push() }
    document.addEventListener('visibilitychange', hide)
    return () => { clearTimeout(t); document.removeEventListener('visibilitychange', hide) }
  }, [s, ok, uid, loaded])

  // 3) Quantas pessoas a pessoa indicou (libera o relatório personalizado). Atualiza ao voltar para o app.
  useEffect(() => {
    if (!ok || !uid || !loaded) return
    const refresh = async () => {
      try {
        const { count, error } = await sb.from('bolso_referrals').select('id', { count: 'exact', head: true })
        if (error || count == null || uidRef.current !== uid) return
        setS(v => (v.refs === count ? v : { ...v, refs: count }))
      } catch {}
    }
    refresh()
    const vis = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', vis)
    return () => document.removeEventListener('visibilitychange', vis)
  }, [ok, uid, loaded])

  // 4) Resumo para os avisos programados (só no iPhone)
  useEffect(() => {
    if (!ok || !uid || !loaded || !isNative || !P) return
    const t = setTimeout(async () => {
      try {
        const snapshot = buildSnapshot(s, P)
        const key = JSON.stringify(snapshot)
        if (key === lastSnap.current) return
        const { error } = await sb.from('bolso_push_state')
          .upsert({ user_id: uid, snapshot, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
        if (error) console.warn('push_state:', error.message)
        else lastSnap.current = key
      } catch (e) { console.warn('push_state:', e?.message) }
    }, 2500)
    return () => clearTimeout(t)
  }, [s, P, ok, uid, loaded])
  useEffect(() => { lastSnap.current = '' }, [uid])

  return loaded
}