// Web Push direto (VAPID), sem Firebase. Chamado pelo pg_cron (x-cron-secret) ou por um admin logado.
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret, apikey' }
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  let allowed = !!Deno.env.get('CRON_SECRET') && req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
  if (!allowed) {
    const { data: { user } } = await db.auth.getUser((req.headers.get('Authorization') ?? '').replace('Bearer ', ''))
    if (user) { const { data } = await db.from('bolso_admins').select('user_id').eq('user_id', user.id).maybeSingle(); allowed = !!data }
  }
  if (!allowed) return j({ error: 'forbidden' }, 403)

  const { title, body, url = '/', user_ids, daily } = await req.json()
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!)
  let ids: string[] | undefined = user_ids
  if (daily) { // lembrete diário só para quem tem renda variável
    const { data } = await db.from('bolso_state').select('user_id').eq('data->>variable', 'true')
    ids = (data ?? []).map(r => r.user_id)
  }
  let q = db.from('bolso_push_subs').select('id,sub')
  if (ids) q = q.in('user_id', ids)
  const { data: subs } = await q
  const payload = JSON.stringify({ title, body, url })
  const dead: number[] = []
  await Promise.all((subs ?? []).map(async s => {
    try { await webpush.sendNotification(s.sub, payload) } catch (e) { if ([404, 410].includes((e as { statusCode?: number }).statusCode ?? 0)) dead.push(s.id) }
  }))
  if (dead.length) await db.from('bolso_push_subs').delete().in('id', dead)
  return j({ sent: (subs?.length ?? 0) - dead.length, removed: dead.length })
})
