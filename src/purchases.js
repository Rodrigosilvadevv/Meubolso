import { Purchases } from '@revenuecat/purchases-capacitor'
import { isNative } from './nativeAuth.js'

// Troque pelos IDs reais dos produtos no App Store Connect
export const PRODUCT_IDS = {
  premium: 'meubolso.premium.mensal',
  plus: 'meubolso.plus.mensal',
}

const timeout = (p, ms = 8000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

let configured = false

export async function initPurchases(userId) {
  if (!isNative) return
  const apiKey = import.meta.env.VITE_RC_IOS_KEY
  if (!apiKey) throw new Error('NO_RC_KEY')
  if (!configured) {
    await timeout(Purchases.configure({ apiKey, appUserID: userId }))
    configured = true
  } else {
    await timeout(Purchases.logIn({ appUserID: userId }))
  }
}

export async function resetPurchases() {
  if (!isNative || !configured) return
  await Purchases.logOut()
}

// Converte o customerInfo do RevenueCat em { plan, plan_until } (ou null se não tem assinatura ativa)
export const planFromInfo = info => {
  const a = info?.entitlements?.active || {}
  const e = a.plus || a.premium
  if (!e) return null
  return { plan: a.plus ? 'plus' : 'premium', plan_until: e.expirationDate || null }
}

export async function getCustomerInfo() {
  const { customerInfo } = await timeout(Purchases.getCustomerInfo())
  return customerInfo
}

export async function watchPurchases(cb) {
  const id = await Purchases.addCustomerInfoUpdateListener(info => cb(info))
  return () => { try { Purchases.removeCustomerInfoUpdateListener({ listenerToRemove: id }) } catch {} }
}

async function packages() {
  const { current, all } = await timeout(Purchases.getOfferings())
  return [
    ...(current?.availablePackages || []),
    ...Object.values(all || {}).flatMap(o => o.availablePackages || []),
  ]
}

// Preços localizados vindos da App Store (a Apple exige mostrar o preço da loja)
export async function getPrices() {
  if (!isNative) return {}
  const list = await packages()
  const out = {}
  for (const k of Object.keys(PRODUCT_IDS)) {
    const p = list.find(x => x.product.identifier === PRODUCT_IDS[k])
    if (p) out[k] = p.product.priceString
  }
  return out
}

export async function purchasePlan(plan) {
  const list = await packages()
  const pkg = list.find(x => x.product.identifier === PRODUCT_IDS[plan])
  if (!pkg) throw new Error('NO_PACKAGE')
  const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg })
  return customerInfo
}

export async function restorePurchases() {
  const { customerInfo } = await timeout(Purchases.restorePurchases(), 15000)
  return customerInfo
}