import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { App as CapApp } from '@capacitor/app'
import { authStorage, isNative, makeOauth, makeEnablePush, makeRemovePushToken } from './nativeAuth.js'
// Sessão salva no aparelho (no iOS usa Preferences, que não é apagado pelo sistema).
// Só o token fica guardado, nunca a senha. O usuário só sai ao tocar em "Sair".
export const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: {
    storage: isNative ? authStorage : window.localStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: !isNative,
    storageKey: 'bolso:auth',
  },
})

// No app nativo, renova o token só enquanto o app está aberto
if (isNative) {
  sb.auth.startAutoRefresh()
  CapApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) sb.auth.startAutoRefresh()
    else sb.auth.stopAutoRefresh()
  })
}

const q = new URLSearchParams(location.search)
if (q.get('ref')) localStorage.setItem('bolso:ref', q.get('ref'))

const now = () => new Date()
export const active = p => !!p && ((p.trial_until && new Date(p.trial_until) > now()) || (p.plan !== 'none' && (!p.plan_until || new Date(p.plan_until) > now())))
export const isPlus = p => !!p && p.plan === 'plus' && (!p.plan_until || new Date(p.plan_until) > now())

// Nível do usuário: 'plus' | 'premium' | 'free' (mês grátis ou sem plano pago)
export const tierOf = p => isPlus(p) ? 'plus' : (p && p.plan === 'premium' && (!p.plan_until || new Date(p.plan_until) > now())) ? 'premium' : 'free'

// Normaliza o telefone: só dígitos, sem zeros à esquerda e sem o 55 do Brasil.
const normTel = t => {
  let d = t.replace(/\D/g, '').replace(/^0+/, '')
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2)
  return d
}
const fakeEmail = tel => `${normTel(tel)}@tel.meubolso.app`

// Google/Apple: login nativo no iOS (signInWithIdToken) e OAuth normal no navegador
export const oauth = makeOauth(sb)

export const signUpPhone = async (name, tel, pass) => {
  const r = await sb.auth.signUp({ email: fakeEmail(tel), password: pass, options: { data: { name, phone: tel } } })
  // Sem sessão e sem erro = o Supabase ainda exige confirmação de e-mail (o e-mail é falso e nunca chega).
  if (!r.error && !r.data.session) return { ...r, error: { message: 'EMAIL_CONFIRM_ON' } }
  return r
}
export const signInPhone = (tel, pass) => sb.auth.signInWithPassword({ email: fakeEmail(tel), password: pass })

const enableNativePush = makeEnablePush(sb)
const removeNativePushToken = makeRemovePushToken(sb)

export function useCloud() {
  const [session, setSession] = useState(undefined)
  const [profile, setProfile] = useState(null)
  const [loadedFor, setLoadedFor] = useState(null)
  const [profileErr, setProfileErr] = useState('')
  const load = useCallback(async sess => {
    if (!sess) { setProfile(null); setLoadedFor(null); return }
    const md = sess.user.user_metadata || {}
    const { data, error } = await sb.rpc('bolso_ensure_profile', { p_name: md.name || md.full_name || 'Você', p_ref: localStorage.getItem('bolso:ref') })
    setProfileErr(error ? error.message : '')
    setProfile(data || null); setLoadedFor(sess.user.id)
  }, [])
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => { setSession(data.session); load(data.session) })
    const { data: sub } = sb.auth.onAuthStateChange((_e, sess) => { setSession(sess); setTimeout(() => load(sess), 0) })
    return () => sub.subscription.unsubscribe()
  }, [load])
  const status = session === undefined || (session && loadedFor !== session.user.id) ? 'loading' : !session ? 'out' : active(profile) ? 'in' : 'locked'

  // iOS: a cada abertura com o usuário logado, registra o aparelho para notificações
  // (se a permissão ainda não foi pedida, o iOS mostra o pedido; se negada, ignora)
  useEffect(() => {
    if (isNative && session?.user) enableNativePush(session.user).catch(() => {})
  }, [session?.user?.id])

  const leave = async () => {
    try { await removeNativePushToken(session?.user) } catch {}
    try { await sb.auth.signOut() } catch {}
    localStorage.removeItem('bolso:v1')
    location.reload()
  }
  return { status, user: session?.user, profile, profileErr, refresh: () => load(session), logout: leave }
}

// Sincroniza o estado do app com o Supabase e carrega banners do admin. Não envia 'user' nem 'cfg'.
export function useSync(s, setS, on, user, profile) {
  const ready = useRef(false)
  useEffect(() => {
    if (!on || !user) return
    ready.current = false
    ;(async () => {
      const [st, bn, rc] = await Promise.all([
        sb.from('bolso_state').select('data').eq('user_id', user.id).maybeSingle(),
        sb.from('bolso_banners').select('*'),
        sb.rpc('bolso_ref_count'),
      ])
      const banners = (bn.data || []).map(r => ({ id: r.id, on: true, title: r.title, text: r.body || '', tone: r.tone }))
      setS(v => ({ ...v, ...(st.data?.data || {}), refs: rc.data || 0, refCode: profile?.ref_code || v.refCode, cfg: { ...v.cfg, banners } }))
      ready.current = true
    })()
  }, [on, user?.id])
  useEffect(() => {
    if (!on || !user || !ready.current) return
    const t = setTimeout(() => {
      const { user: _u, cfg: _c, refs: _r, refCode: _k, ...data } = s
      sb.from('bolso_state').upsert({ user_id: user.id, data, updated_at: new Date().toISOString() })
    }, 1200)
    return () => clearTimeout(t)
  }, [s, on, user?.id])
}

export async function enablePush(user) {
  // iOS nativo (Capacitor): salva o token do APNs na tabela push_tokens
  if (isNative) return enableNativePush(user)

  // Navegador / PWA: Web Push com VAPID
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('unsupported')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('denied')
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '='))
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)) })
  const j = sub.toJSON()
  await sb.from('bolso_push_subs').upsert({ user_id: user.id, endpoint: j.endpoint, sub: j }, { onConflict: 'endpoint' })
}