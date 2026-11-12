import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { PushNotifications } from '@capacitor/push-notifications'
import { SocialLogin } from '@capgo/capacitor-social-login'

// ====== TROQUE ESTES 2 VALORES (Google Cloud Console) ======
const GOOGLE_WEB_CLIENT_ID = 'SEU_WEB_CLIENT_ID.apps.googleusercontent.com'
const GOOGLE_IOS_CLIENT_ID = 'SEU_IOS_CLIENT_ID.apps.googleusercontent.com'
// ===========================================================

export const isNative = Capacitor.isNativePlatform()

// Sessão persistente no iOS (não é apagada pelo sistema)
export const authStorage = {
  getItem: async k => (await Preferences.get({ key: k })).value,
  setItem: async (k, v) => { await Preferences.set({ key: k, value: v }) },
  removeItem: async k => { await Preferences.remove({ key: k }) },
}

// ---------- Nonce (Google + Supabase) ----------
const randomNonce = () => {
  const a = new Uint8Array(32)
  crypto.getRandomValues(a)
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('')
}
const sha256Hex = async str => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
}

// ---------- Inicialização única do plugin ----------
let initPromise = null
const initSocial = () => {
  if (!initPromise) {
    initPromise = SocialLogin.initialize({
      google: { webClientId: GOOGLE_WEB_CLIENT_ID, iOSClientId: GOOGLE_IOS_CLIENT_ID, mode: 'online' },
      apple: {}, // iOS usa o login nativo da Apple (Bundle ID)
    }).catch(e => { initPromise = null; throw e })
  }
  return initPromise
}

const googleNative = async (sb, retry = true) => {
  await initSocial()
  const raw = randomNonce()
  const digest = await sha256Hex(raw)
  const res = await SocialLogin.login({
    provider: 'google',
    options: { scopes: ['email', 'profile'], nonce: digest }, // Google recebe o HASH
  })
  const g = res.result
  if (!g || g.responseType !== 'online' || !g.idToken) return { error: new Error('Google não retornou o token.') }
  const out = await sb.auth.signInWithIdToken({ provider: 'google', token: g.idToken, nonce: raw }) // Supabase recebe o ORIGINAL
  // Token em cache pode causar erro de nonce: sai do Google e tenta 1 vez de novo
  if (out.error && retry && /nonce/i.test(out.error.message || '')) {
    try { await SocialLogin.logout({ provider: 'google' }) } catch {}
    return googleNative(sb, false)
  }
  return out
}

const appleNative = async sb => {
  await initSocial()
  const res = await SocialLogin.login({ provider: 'apple', options: { scopes: ['email', 'name'] } })
  const idToken = res.result?.idToken
  if (!idToken) return { error: new Error('Apple não retornou o token.') }
  const out = await sb.auth.signInWithIdToken({ provider: 'apple', token: idToken })
  // A Apple só envia o nome na primeira vez: guarda agora
  const p = res.result?.profile
  const name = [p?.givenName, p?.familyName].filter(Boolean).join(' ')
  if (!out.error && name) { try { await sb.auth.updateUser({ data: { full_name: name } }) } catch {} }
  return out
}

// Login social: nativo no iOS, OAuth normal no navegador
export const makeOauth = sb => async provider => {
  if (!isNative) {
    return sb.auth.signInWithOAuth({ provider, options: { redirectTo: window.location.origin } })
  }
  try {
    if (provider === 'apple') return await appleNative(sb)
    if (provider === 'google') return await googleNative(sb)
    return { error: new Error('Provedor não suportado.') }
  } catch (e) {
    if (e?.code === 'USER_CANCELLED' || /cancel|1001|12501/i.test(e?.message || String(e))) return { error: null, cancelled: true }
    return { error: e }
  }
}

// ---------- Push iOS: salva o token APNs na tabela push_tokens ----------
export const makeEnablePush = sb => async user => {
  if (!isNative) throw new Error('unsupported')
  let perm = await PushNotifications.checkPermissions()
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PushNotifications.requestPermissions()
  if (perm.receive !== 'granted') throw new Error('denied')

  await PushNotifications.removeAllListeners()
  await PushNotifications.addListener('registration', async t => {
    const { error } = await sb.from('push_tokens').upsert(
      { user_id: user.id, token: t.value, platform: Capacitor.getPlatform(), updated_at: new Date().toISOString() },
      { onConflict: 'token' }
    )
    if (error) console.error('push_tokens:', error.message)
  })
  await PushNotifications.addListener('registrationError', e => console.error('Push erro:', e))
  await PushNotifications.register()
}

export const makeRemovePushToken = sb => async user => {
  if (!isNative || !user) return
  await sb.from('push_tokens').delete().eq('user_id', user.id).eq('platform', Capacitor.getPlatform())
}