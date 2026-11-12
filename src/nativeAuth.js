import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { PushNotifications } from '@capacitor/push-notifications'
import { SocialLogin } from '@capgo/capacitor-social-login'

export const isNative = Capacitor.isNativePlatform()

// Tabela única de tokens (a mesma que a Edge Function de envio deve ler)
const TOKENS = 'bolso_push_tokens'

// Sessão persistente no iOS (não é apagada pelo sistema)
export const authStorage = {
  getItem: async k => (await Preferences.get({ key: k })).value,
  setItem: async (k, v) => { await Preferences.set({ key: k, value: v }) },
  removeItem: async k => { await Preferences.remove({ key: k }) },
}

// ---------- Login com Apple (nativo no iOS) ----------
let initPromise = null
const initSocial = () => {
  if (!initPromise) {
    initPromise = SocialLogin.initialize({
      apple: {}, // iOS usa o login nativo da Apple (Bundle ID)
    }).catch(e => { initPromise = null; throw e })
  }
  return initPromise
}

const appleNative = async sb => {
  await initSocial()
  const res = await SocialLogin.login({ provider: 'apple', options: { scopes: ['email', 'name'] } })
  const idToken = res.result?.idToken
  if (!idToken) return { error: new Error('A Apple não retornou o token.') }
  const out = await sb.auth.signInWithIdToken({ provider: 'apple', token: idToken })
  // A Apple só envia o nome na primeira vez: guarda agora
  const p = res.result?.profile
  const name = [p?.givenName, p?.familyName].filter(Boolean).join(' ')
  if (!out.error && name) { try { await sb.auth.updateUser({ data: { full_name: name } }) } catch {} }
  return out
}

// Nativo no iOS; no navegador usa o OAuth normal
export const makeOauth = sb => async provider => {
  if (!isNative) {
    return sb.auth.signInWithOAuth({ provider, options: { redirectTo: window.location.origin } })
  }
  try {
    if (provider === 'apple') return await appleNative(sb)
    return { error: new Error('Esse tipo de login ainda não está disponível.') }
  } catch (e) {
    if (e?.code === 'USER_CANCELLED' || /cancel|1001/i.test(e?.message || String(e))) return { error: null, cancelled: true }
    return { error: e }
  }
}

// Salva o token no banco. A função RPC reatribui o token ao usuário logado mesmo que ele
// já pertença a outra conta (troca de conta no mesmo aparelho). Sem a RPC, cai no upsert direto.
const saveToken = async (sb, user, token) => {
  const platform = Capacitor.getPlatform()
  const { error } = await sb.rpc('save_push_token', { p_token: token, p_platform: platform })
  if (!error) return
  const { error: e2 } = await sb.from(TOKENS).upsert(
    { user_id: user.id, token, platform, updated_at: new Date().toISOString() },
    { onConflict: 'token' }
  )
  if (e2) console.error(`${TOKENS}:`, e2.message)
}

// ---------- Push iOS: salva o token APNs na tabela bolso_push_tokens ----------
export const makeEnablePush = sb => async user => {
  if (!isNative) throw new Error('unsupported')
  let perm = await PushNotifications.checkPermissions()
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PushNotifications.requestPermissions()
  if (perm.receive !== 'granted') throw new Error('denied')

  await PushNotifications.removeAllListeners()
  await PushNotifications.addListener('registration', t => saveToken(sb, user, t.value))
  await PushNotifications.addListener('registrationError', e => console.error('Push erro:', e))
  await PushNotifications.register()
}

export const makeRemovePushToken = sb => async user => {
  if (!isNative || !user) return
  await sb.from(TOKENS).delete().eq('user_id', user.id).eq('platform', Capacitor.getPlatform())
}