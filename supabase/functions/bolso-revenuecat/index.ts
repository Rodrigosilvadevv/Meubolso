// Webhook do RevenueCat (App Store + Google Play). app_user_id = id do usuário no Supabase.
// Produtos: bolso_premium_mensal e bolso_plus_mensal (o id com "plus" vira Premium Plus).
import { createClient } from 'npm:@supabase/supabase-js@2'
Deno.serve(async req => {
  if (req.headers.get('Authorization') !== `Bearer ${Deno.env.get('REVENUECAT_WEBHOOK_SECRET')}`) return new Response('forbidden', { status: 403 })
  const { event: e } = await req.json()
  const uid: string = e?.app_user_id ?? ''
  if (!/^[0-9a-f-]{36}$/.test(uid)) return new Response('ignored')
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const plan = String(e.product_id ?? '').includes('plus') ? 'plus' : 'premium'
  const until = e.expiration_at_ms ? new Date(e.expiration_at_ms).toISOString() : null
  if (e.type === 'EXPIRATION') await db.from('bolso_profiles').update({ plan: 'none', plan_until: null }).eq('id', uid)
  else if (['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION'].includes(e.type))
    await db.from('bolso_profiles').update({ plan, plan_until: until }).eq('id', uid)
  return new Response('ok')
})
