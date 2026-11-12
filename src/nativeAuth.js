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

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Salva o token no banco. A função RPC reatribui o token ao usuário logado mesmo que ele
// já pertença a outra conta (troca de conta no mesmo aparelho). Sem a RPC, cai no upsert direto.
// Retorna true se salvou, false se falhou.
const saveToken = async (sb, user, token) => {
  const platform = Capacitor.getPlatform()
  const { error } = await sb.rpc('save_push_token', { p_token: token, p_platform: platform })
  if (!error) return true
  console.warn('save_push_token falhou:', error.message)
  const { error: e2 } = await sb.from(TOKENS).upsert(
    { user_id: user.id, token, platform, updated_at: new Date().toISOString() },
    { onConflict: 'token' }
  )
  if (e2) { console.error(`${TOKENS}:`, e2.message); return false }
  return true
}

// Tenta salvar até 3 vezes, com espera crescente entre as tentativas
const saveTokenRetry = async (sb, user, token) => {
  for (let i = 0; i < 3; i++) {
    if (await saveToken(sb, user, token)) return true
    await sleep(1500 * (i + 1))
  }
  console.error('Não foi possível salvar o token de push após 3 tentativas')
  return false
}

// ---------- Push iOS: salva o token APNs na tabela bolso_push_tokens ----------
export const makeEnablePush = sb => async user => {
  if (!isNative) throw new Error('unsupported')
  let perm = await PushNotifications.checkPermissions()
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PushNotifications.requestPermissions()
  if (perm.receive !== 'granted') throw new Error('denied')

  await PushNotifications.removeAllListeners()

  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('push-timeout')), 20000)
    // Listener permanente: também salva se o iOS trocar o token depois
    PushNotifications.addListener('registration', t => {
      clearTimeout(timer)
      resolve(t.value)
      saveTokenRetry(sb, user, t.value)
    })
    PushNotifications.addListener('registrationError', e => {
      clearTimeout(timer)
      console.error('Push erro:', e)
      reject(new Error(e?.error || 'registrationError'))
    })
    PushNotifications.register().catch(e => { clearTimeout(timer); reject(e) })
  })

  return token
}

export const makeRemovePushToken = sb => async user => {
  if (!isNative || !user) return
  await sb.from(TOKENS).delete().eq('user_id', user.id).eq('platform', Capacitor.getPlatform())
}
