import { useCallback, useEffect, useState } from 'react'
import { sb, signInPhone } from './cloud'

const fmt = d => (d ? new Date(d).toLocaleDateString('pt-BR') : '—')
const TONE = { assinante: 'good', 'em teste': 'info', 'sem acesso': 'neg' }

export default function AdminPage() {
  const [st, setSt] = useState('loading') // loading | out | denied | in
  const [f, setF] = useState({ tel: '', pass: '' }), [err, setErr] = useState(''), [busy, setBusy] = useState(false)

  const check = useCallback(async () => {
    const { data: { session } } = await sb.auth.getSession()
    if (!session) return setSt('out')
    const { data, error } = await sb.rpc('bolso_is_admin')
    if (error) { setErr('Erro no banco: ' + error.message); return setSt('out') }
    setSt(data ? 'in' : 'denied')
  }, [])
  useEffect(() => { check() }, [check])

  const login = async e => {
    e.preventDefault(); setErr(''); setBusy(true)
    const { error } = await signInPhone(f.tel, f.pass)
    setBusy(false)
    if (error) return setErr(/invalid login/i.test(error.message) ? 'Telefone ou senha incorretos.' : error.message)
    check()
  }
  const out = async () => { await sb.auth.signOut(); setF({ tel: '', pass: '' }); setSt('out') }

  const wrap = ch => <div className="app dark" style={{ '--h': 172 }}>{ch}</div>

  if (st === 'loading') return wrap(<p className="muted" style={{ padding: 40 }}>Carregando…</p>)
  if (st === 'out') return wrap(
    <main className="login">
      <section className="box">
        <h2>Admin</h2>
        <form className="form" onSubmit={login}>
          <input type="tel" autoComplete="tel" placeholder="Telefone com DDD" value={f.tel} onChange={e => setF({ ...f, tel: e.target.value })} />
          <input type="password" autoComplete="current-password" placeholder="Senha" value={f.pass} onChange={e => setF({ ...f, pass: e.target.value })} />
          <p className="err" role="alert">{err}</p>
          <button className="cta" disabled={busy}>Entrar</button>
        </form>
      </section>
    </main>
  )
  if (st === 'denied') return wrap(
    <main className="login"><section className="box">
      <h2>Acesso negado</h2>
      <p className="muted">Esta conta não é de administrador.</p>
      <button className="ghost" onClick={out}>Sair</button>
    </section></main>
  )
  return wrap(<Panel onExit={out} />)
}

function Panel({ onExit }) {
  const [tab, setTab] = useState('users')
  return (
    <div className="main" style={{ padding: 16, maxWidth: 1000, margin: '0 auto' }}>
      <header><div><small>Meu bolso</small><h1>Admin</h1></div><div className="acts"><button className="ghost" onClick={onExit}>Sair</button></div></header>
      <div className="seg">{[['users', 'Usuários'], ['msgs', 'Mensagens']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'users' ? <Users /> : <Msgs />}
    </div>
  )
}

function Users() {
  const [rows, setRows] = useState([]), [err, setErr] = useState(''), [q, setQ] = useState(''), [flt, setFlt] = useState('todos'), [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    const { data, error } = await sb.rpc('bolso_admin_list')
    if (error) return setErr(error.message)
    setErr(''); setRows(data || [])
  }, [])
  useEffect(() => { load() }, [load])
  const setPlan = async (id, plan) => {
    setBusy(id)
    const { error } = await sb.rpc('bolso_admin_set_plan', { p_user: id, p_plan: plan, p_days: 30 })
    setBusy(''); if (error) setErr(error.message); else load()
  }
  const count = s => rows.filter(r => r.situacao === s).length
  const shown = rows.filter(r => (flt === 'todos' || r.situacao === flt) && (`${r.name} ${r.email}`.toLowerCase().includes(q.toLowerCase())))
  return (
    <section className="wide" style={{ marginTop: 14 }}>
      <p className="muted">
        {rows.length} usuários · {count('assinante')} assinantes ({rows.filter(r => r.plan === 'premium' && r.situacao === 'assinante').length} Premium, {rows.filter(r => r.plan === 'plus' && r.situacao === 'assinante').length} Plus) · {count('em teste')} em teste · {count('sem acesso')} sem acesso
      </p>
      {err && <p className="err">{err}</p>}
      <div className="form" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
        <input placeholder="Buscar nome ou telefone" value={q} onChange={e => setQ(e.target.value)} />
        <select value={flt} onChange={e => setFlt(e.target.value)}>
          {['todos', 'assinante', 'em teste', 'sem acesso'].map(x => <option key={x}>{x}</option>)}
        </select>
        <button className="ghost" onClick={load}>Atualizar</button>
      </div>
      <ul className="list">
        {shown.map(r => (
          <li key={r.user_id} style={{ flexWrap: 'wrap', gap: 8 }}>
            {(r.email || '').replace(/@(tel\.)?meubolso\.app$/, '')}
            <em className={TONE[r.situacao]}>{r.situacao}{r.situacao === 'assinante' ? ` · ${r.plan}` : ''}</em>
            <small>{r.situacao === 'assinante' ? `até ${fmt(r.plan_until)}` : `teste até ${fmt(r.trial_until)}`}</small>
            <button className="ghost" disabled={busy === r.user_id} onClick={() => setPlan(r.user_id, 'premium')}>Premium 30d</button>
            <button className="ghost" disabled={busy === r.user_id} onClick={() => setPlan(r.user_id, 'plus')}>Plus 30d</button>
            <button className="ghost" disabled={busy === r.user_id} onClick={() => setPlan(r.user_id, 'none')}>Remover plano</button>
          </li>
        ))}
        {shown.length === 0 && <li className="muted">Nenhum usuário.</li>}
      </ul>
    </section>
  )
}

function Msgs() {
  const [rows, setRows] = useState([]), [err, setErr] = useState(''), [to, setTo] = useState(null), [t, setT] = useState('')
  const load = useCallback(async () => {
    const { data, error } = await sb.rpc('bolso_admin_inbox')
    if (error) return setErr(error.message)
    setErr(''); setRows(data || [])
  }, [])
  useEffect(() => { load() }, [load])
  const send = async e => {
    e.preventDefault()
    if (!to || !t.trim()) return
    const { error } = await sb.rpc('bolso_admin_reply', { p_user: to.user_id, p_body: t.trim() })
    if (error) return setErr(error.message)
    setT(''); load()
  }
  return (
    <section className="wide" style={{ marginTop: 14 }}>
      {err && <p className="err">{err}</p>}
      <form className="form" onSubmit={send}>
        <p className="muted">{to ? `Respondendo para ${to.name || 'usuário'} (toque em outra mensagem para trocar)` : 'Toque em uma mensagem para responder.'}</p>
        <input value={t} onChange={e => setT(e.target.value)} placeholder="Sua resposta" maxLength={1000} disabled={!to} />
        <button className="cta" disabled={!to}>Enviar resposta</button>
      </form>
      <ul className="list">
        {rows.map(m => (
          <li key={m.id} onClick={() => setTo(m)} style={{ cursor: 'pointer' }}>
            <span>{m.name || 'Usuário'} {m.role === 'admin' ? '(você)' : ''}<small>{new Date(m.created_at).toLocaleString('pt-BR')}</small>{m.body}</span>
          </li>
        ))}
        {rows.length === 0 && <li className="muted">Nenhuma mensagem.</li>}
      </ul>
      <button className="ghost" onClick={load}>Atualizar</button>
    </section>
  )
}