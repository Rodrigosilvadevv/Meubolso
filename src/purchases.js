import { Purchases, LOG_LEVEL } from '@revenuecat/purchases-capacitor'
import { isNative } from './nativeAuth.js'

export const PRODUCT_IDS = {
  premium: 'meubolso.premium.mensal',
  plus: 'meubolso.plus.mensal',
}

const MANAGE_URL = 'https://apps.apple.com/account/subscriptions'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const timeout = (p, ms = 10000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

// ---------- Inicialização ----------
// `current` guarda a promise da última inicialização. Todas as outras funções
// esperam por ela (ver ready()), então não dá mais para chamar o RevenueCat
// antes de ele estar configurado.
let configured = false
let currentUser = null
let current = null

export function initPurchases(userId) {
  if (!isNative) return Promise.resolve()

  const apiKey = import.meta.env.VITE_RC_IOS_KEY
  if (!apiKey) return Promise.reject(new Error('NO_RC_KEY'))

  const prev = current || Promise.resolve()
  current = prev.catch(() => {}).then(async () => {
    if (!configured) {
      // Logs detalhados no console do Xcode. Pode remover depois que funcionar.
      await Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG })
      await Purchases.configure({ apiKey, appUserID: userId || undefined })
      configured = true
      currentUser = userId || null
    } else if (userId && userId !== currentUser) {
      await Purchases.logIn({ appUserID: userId })
      currentUser = userId
    }
  })
  return current
}

// Espera a inicialização terminar. Se ela ainda nem começou (o Paywall pode
// montar antes do useCloud), espera até 8 segundos pelo início.
async function ready() {
  if (!isNative) return
  for (let i = 0; i < 40 && !current; i++) await sleep(200)
  if (!current) throw new Error('RevenueCat não foi iniciado (usuário ainda não logou?)')
  await timeout(current, 15000)
}

export async function resetPurchases() {
  if (!isNative || !configured) return
  try {
    await (current || Promise.resolve()).catch(() => {})
    await Purchases.logOut()
    currentUser = null
  } catch (e) {
    console.error('Erro ao fazer logout no RevenueCat:', e)
  }
}

// ---------- Plano a partir do customerInfo ----------
export const planFromInfo = info => {
  const a = info?.entitlements?.active || {}
  const e = a.plus || a.premium
  if (e) return { plan: a.plus ? 'plus' : 'premium', plan_until: e.expirationDate || null }

  // Rede de segurança: se o entitlement ainda não foi ligado ao produto no painel do
  // RevenueCat, mas existe uma assinatura ativa, libera o plano mesmo assim.
  const subs = info?.activeSubscriptions || []
  const key = subs.includes(PRODUCT_IDS.plus) ? 'plus' : subs.includes(PRODUCT_IDS.premium) ? 'premium' : null
  if (!key) return null
  return { plan: key, plan_until: info?.allExpirationDates?.[PRODUCT_IDS[key]] || null }
}

export async function getCustomerInfo() {
  if (!isNative) return null
  try {
    await ready()
    const { customerInfo } = await timeout(Purchases.getCustomerInfo())
    return customerInfo
  } catch (e) {
    console.error('Erro ao buscar customerInfo:', e)
    return null
  }
}

export async function watchPurchases(cb) {
  if (!isNative) return () => {}
  try {
    await ready()
    const listener = await Purchases.addCustomerInfoUpdateListener(info => cb(info))
    return () => {
      try {
        if (listener && typeof listener.remove === 'function') {
          listener.remove()
        } else if (listener?.id) {
          Purchases.removeCustomerInfoUpdateListener({ listenerToRemove: listener.id })
        }
      } catch {}
    }
  } catch (e) {
    console.error('Erro ao registrar listener do RevenueCat:', e)
    return () => {}
  }
}

// ---------- Produtos e preços ----------
// Não engole o erro: quem chama decide o que mostrar.
async function loadPackages() {
  await ready()
  const offerings = await timeout(Purchases.getOfferings(), 15000)
  const all = offerings?.all || {}
  const list = [
    ...(offerings?.current?.availablePackages || []),
    ...Object.values(all).flatMap(o => o?.availablePackages || []),
  ]
  if (!list.length) console.warn('RevenueCat: nenhuma offering com pacotes (confira se há uma marcada como Current).')
  return list
}

// Plano B: busca o produto direto na App Store, sem depender da Offering.
async function loadProducts(ids) {
  await ready()
  const { products } = await timeout(Purchases.getProducts({ productIdentifiers: ids }), 15000)
  return products || []
}

export async function getPrices() {
  if (!isNative) return {}
  const out = {}

  try {
    const list = await loadPackages()
    for (const k of Object.keys(PRODUCT_IDS)) {
      const p = list.find(x => x?.product?.identifier === PRODUCT_IDS[k])
      if (p?.product?.priceString) out[k] = p.product.priceString
    }
  } catch (e) {
    console.error('Erro ao buscar offerings:', e)
  }

  if (Object.keys(out).length < Object.keys(PRODUCT_IDS).length) {
    try {
      const products = await loadProducts(Object.values(PRODUCT_IDS))
      for (const k of Object.keys(PRODUCT_IDS)) {
        const p = products.find(x => x?.identifier === PRODUCT_IDS[k])
        if (!out[k] && p?.priceString) out[k] = p.priceString
      }
    } catch (e) {
      console.error('Erro ao buscar produtos:', e)
    }
  }

  return out
}

// ---------- Compra ----------
export async function purchasePlan(plan) {
  if (!isNative) throw new Error('NOT_NATIVE')
  const id = PRODUCT_IDS[plan]
  if (!id) throw new Error(`Plano desconhecido: ${plan}`)

  // 1) Tenta pela Offering
  let pkg = null
  try {
    pkg = (await loadPackages()).find(x => x?.product?.identifier === id) || null
  } catch (e) {
    console.error('Offerings falhou, tentando o produto direto:', e)
  }
  if (pkg) {
    const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg })
    return customerInfo
  }

  // 2) Plano B: compra o produto direto (a mensagem de erro vem da Apple/RevenueCat)
  const product = (await loadProducts([id])).find(x => x?.identifier === id)
  if (!product) throw new Error(`Produto não encontrado na App Store: ${id}`)
  const { customerInfo } = await Purchases.purchaseStoreProduct({ product })
  return customerInfo
}

export async function restorePurchases() {
  if (!isNative) throw new Error('NOT_NATIVE')
  await ready()
  const { customerInfo } = await timeout(Purchases.restorePurchases(), 15000)
  return customerInfo
}

export async function manageSubscription() {
  if (!isNative) {
    window.open(MANAGE_URL, '_blank')
    return
  }
  try {
    await Purchases.showManageSubscriptions()
  } catch {
    window.open(MANAGE_URL, '_blank')
  }
}