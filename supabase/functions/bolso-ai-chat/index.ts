// Chat com IA (Groq). A chave fica só aqui. Só o plano Plus passa.
import { createClient } from 'npm:@supabase/supabase-js@2'
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey' }
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const SYSTEM = `Você é o assistente do app Meu bolso, para quem tem salário apertado ou renda que varia todo dia no Brasil.
Responda em português simples, curto e prático (até 6 frases). Ajude a organizar gastos, priorizar contas, negociar dívidas e guardar um pouco.
Não recomende investimentos, não prometa resultados e não peça senhas ou dados de cartão. Para dívidas e direitos, sugira canais oficiais (banco, Procon, CRAS) e diga para confirmar as regras atuais.`

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = Deno.env.get('SUPABASE_URL')!
  const authed = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } })
  const { data: { user } } = await authed.auth.getUser()
  if (!user) return j({ error: 'login' }, 401)
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: p } = await db.from('bolso_profiles').select('plan,plan_until').eq('id', user.id).single()
  if (!(p?.plan === 'plus' && (!p.plan_until || new Date(p.plan_until) > new Date()))) return j({ error: 'plus_required' }, 403)

  const since = new Date(Date.now() - 3600e3).toISOString()
  const { count } = await db.from('bolso_messages').select('id', { count: 'exact', head: true })
    .eq('user_id', user.id).eq('channel', 'ai').eq('role', 'user').gte('created_at', since)
  if ((count ?? 0) >= 20) return j({ error: 'limit' }, 429)

  const { text, summary } = await req.json()
  const msg = String(text ?? '').slice(0, 1000).trim()
  if (!msg) return j({ error: 'empty' }, 400)
  const { data: hist } = await db.from('bolso_messages').select('role,body').eq('user_id', user.id).eq('channel', 'ai')
    .order('created_at', { ascending: false }).limit(8)

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('GROQ_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: Deno.env.get('GROQ_MODEL') ?? 'llama-3.3-70b-versatile', temperature: 0.4, max_tokens: 500,
      messages: [
        { role: 'system', content: `${SYSTEM}\nResumo do ciclo do usuário (sem nome): ${String(summary ?? '').slice(0, 500)}` },
        ...(hist ?? []).reverse().map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.body })),
        { role: 'user', content: msg },
      ],
    }),
  })
  if (!r.ok) return j({ error: 'ai_unavailable' }, 502)
  const reply = (await r.json()).choices?.[0]?.message?.content?.trim() ?? 'Não consegui responder agora.'
  await db.from('bolso_messages').insert([
    { user_id: user.id, channel: 'ai', role: 'user', body: msg },
    { user_id: user.id, channel: 'ai', role: 'assistant', body: reply },
  ])
  return j({ reply })
})
