import { Purchases } from '@revenuecat/purchases-capacitor'
import { isNative } from './nativeAuth.js'

export const PRODUCT_IDS = {
  premium: 'meubolso.premium.mensal',
  plus: 'meubolso.plus.mensal',
}

const MANAGE_URL = 'https://apps.apple.com/account/subscriptions'

const timeout = (p, ms = 10000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

let configured = false

export async function initPurchases(userId) {
  if (!isNative) return
  const apiKey = import.meta.env.VITE_RC_IOS_KEY
  if (!apiKey) throw new Error('NO_RC_KEY')
  try {
    if (!configured) {
      await timeout(Purchases.configure({ apiKey, appUserID: userId || undefined }))
      configured = true
    } else if (userId) {
      await timeout(Purchases.logIn({ appUserID: userId }))
    }
  } catch (e) {
    console.error('Erro ao inicializar RevenueCat:', e)
  }
}

export async function resetPurchases() {
  if (!isNative || !configured) return
  try {
    await Purchases.logOut()
  } catch (e) {
    console.error('Erro ao fazer logout no RevenueCat:', e)
  }
}

export const planFromInfo = info => {
  const a = info?.entitlements?.active || {}
  const e = a.plus || a.premium
  if (!e) return null
  return { plan: a.plus ? 'plus' : 'premium', plan_until: e.expirationDate || null }
}

export async function getCustomerInfo() {
  if (!isNative) return null
  try {
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

async function packages() {
  if (!isNative) return []
  try {
    const offerings = await timeout(Purchases.getOfferings())
    const current = offerings?.current
    const all = offerings?.all || {}
    return [
      ...(current?.availablePackages || []),
      ...Object.values(all).flatMap(o => o?.availablePackages || []),
    ]
  } catch (e) {
    console.error('Erro ao buscar offerings:', e)
    return []
  }
}

export async function getPrices() {
  if (!isNative) return {}
  const list = await packages()
  const out = {}
  for (const k of Object.keys(PRODUCT_IDS)) {
    const p = list.find(x => x?.product?.identifier === PRODUCT_IDS[k])
    if (p?.product?.priceString) {
      out[k] = p.product.priceString
    }
  }
  return out
}

export async function purchasePlan(plan) {
  if (!isNative) throw new Error('NOT_NATIVE')
  const list = await packages()
  const pkg = list.find(x => x?.product?.identifier === PRODUCT_IDS[plan])
  if (!pkg) throw new Error('NO_PACKAGE')
  const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg })
  return customerInfo
}

export async function restorePurchases() {
  if (!isNative) throw new Error('NOT_NATIVE')
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