// Exclui o usuário e, por cascata, perfil, dados, mensagens e inscrições de push.
import { createClient } from 'npm:@supabase/supabase-js@2'
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey' }
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = Deno.env.get('SUPABASE_URL')!
  const authed = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } })
  const { data: { user } } = await authed.auth.getUser()
  if (!user) return j({ error: 'login' }, 401)
  const { error } = await createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!).auth.admin.deleteUser(user.id)
  return error ? j({ error: error.message }, 500) : j({ ok: true })
})
