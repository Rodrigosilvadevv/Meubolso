import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { oauth, signUpPhone, signInPhone, enablePush, isPlus, parseRef } from './cloud'
import { isNative } from './nativeAuth.js'
import { getPrices } from './purchases'
import { Indique } from './Extras'

const SUPABASE_URL = 'https://xtwdxmrpnmzaxofuxbps.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0d2R4bXJwbm16YXhvZnV4YnBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0Mzk0MjcsImV4cCI6MjExMDAxNTQyN30.inm92mdOZNF7Ig6olSr59G6qvoB7ltN2FisNypPAHHQ'

// Cliente Supabase robusto com detecção de sessão na URL ativada
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
})

const Policy = () => <a href="/privacidade.html" target="_blank" rel="noreferrer">Política de Privacidade e LGPD</a>
const Eula = () => <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/" target="_blank" rel="noreferrer">Termos de Uso</a>

export function Auth() {
  const [mode, setMode] = useState('in'), [f, setF] = useState({ name: '', tel: '', pass: '' })
  const [ok, setOk] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const ref = localStorage.getItem('bolso:ref')
  const need = () => ok || (setErr('Aceite a Política de Privacidade para continuar.'), false)
  const saveCode = () => { const c = parseRef(code); if (c) localStorage.setItem('bolso:ref', c) }

  // Intercepta e limpa tokens de retorno do OAuth na montagem do componente
  useEffect(() => {
    if (window.location.hash && window.location.hash.includes('access_token')) {
      sb.auth.getSession().then(({ data: { session } }) => {
        if (session) {
          window.history.replaceState({}, document.title, window.location.pathname)
        }
      })
    }
  }, [])

  const social = async provider => {
    if (!need()) return
    setErr(''); setBusy(true)
    saveCode()
    const { error, cancelled } = await oauth(provider)
    setBusy(false)
    if (error && !cancelled) setErr(`Não foi possível entrar: ${error.message || error}`)
  }

  const go = async e => {
    e.preventDefault(); setErr('')
    if (mode === 'up' && !need()) return
    if (mode === 'up' && !f.name.trim()) return setErr('Diga seu nome.')
    if (f.tel.replace(/\D/g, '').length < 10) return setErr('Digite o telefone com DDD.')
    if (f.pass.length < 8) return setErr('A senha precisa ter 8 caracteres ou mais.')
    setBusy(true)
    if (mode === 'up') saveCode()
    const { error } = mode === 'up' ? await signUpPhone(f.name.trim(), f.tel, f.pass) : await signInPhone(f.tel, f.pass)
    setBusy(false)
    if (error) {
      const msg = error.message || ''
      setErr(
        /EMAIL_CONFIRM_ON|not confirmed/i.test(msg) ? 'Erro de configuração: a confirmação de e-mail está ligada no Supabase (Authentication → Providers → Email → Confirm email).'
        : /invalid login/i.test(msg) ? 'Telefone ou senha incorretos.'
        : /registered/i.test(msg) ? 'Esse telefone já tem conta. Entre com a senha.'
        : /rate limit|too many/i.test(msg) ? 'Muitas tentativas. Espere alguns minutos.'
        : `Não foi possível entrar: ${msg}`
      )
    }
  }
  return (
    <main className="login">
      <section className="hero">
        <div className="logo"><i />Meu bolso</div>
        <h2>Para fazer o dinheiro durar até o fim do mês.</h2>
        <p>Feito para quem tem salário apertado ou renda que muda todo dia. Não pedimos Open Finance nem acesso ao seu banco: você anota só o que quiser.</p>
        <div className="orb" aria-hidden="true" />
      </section>
      <section className="box">
        <div className="seg">{[['in', 'Entrar'], ['up', 'Criar conta']].map(([k, l]) => <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}</div>
        {ref && <p className="good">Você veio por indicação: 30 dias grátis ao criar a conta.</p>}
        {!ref && mode === 'up' && <input placeholder="Código ou link de indicação (opcional)" value={code} onChange={e => setCode(e.target.value)} />}
        <button className="ghost" disabled={busy} onClick={() => social('apple')}>Continuar com Apple</button>
        <p className="muted">ou com telefone e senha</p>
        <form className="form" onSubmit={go}>
          {mode === 'up' && <input placeholder="Seu nome" autoComplete="name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />}
          <input type="tel" inputMode="tel" autoComplete="tel" placeholder="Telefone com DDD" value={f.tel} onChange={e => setF({ ...f, tel: e.target.value })} />
          <input type="password" autoComplete={mode === 'up' ? 'new-password' : 'current-password'} placeholder="Senha (8 ou mais caracteres)" value={f.pass} onChange={e => setF({ ...f, pass: e.target.value })} />
          <label className="chk"><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} />Li e aceito a <Policy /></label>
          <p className="err" role="alert">{err}</p>
          <button className="cta" disabled={busy}>{mode === 'up' ? 'Criar conta' : 'Entrar'}</button>
        </form>
      </section>
    </main>
  )
}

export function Paywall({ cloud }) {
  const p = cloud.profile
  const [prices, setPrices] = useState({})
  const [busy, setBusy] = useState(''), [msg, setMsg] = useState('')
  const [code, setCode] = useState(''), [showRef, setShowRef] = useState(false)

  useEffect(() => { getPrices().then(setPrices).catch(() => {}) }, [])

  const buy = async plan => {
    if (!isNative) return setMsg('A assinatura é feita no app do iPhone, pela App Store.')
    setMsg(''); setBusy(plan)
    try { await cloud.buy(plan) }
    catch (e) { if (!e?.userCancelled) setMsg('Não foi possível concluir a compra. Tente novamente.') }
    setBusy('')
  }
  const restore = async () => {
    setMsg(''); setBusy('restore')
    try { if (!(await cloud.restore())) setMsg('Nenhuma assinatura encontrada neste Apple ID.') }
    catch { setMsg('Não foi possível restaurar agora.') }
    setBusy('')
  }
  const useCode = async e => {
    e.preventDefault(); setMsg(''); setBusy('ref')
    const r = await cloud.applyRef(code)
    setBusy('')
    if (r.error) setMsg(r.error)
  }

  return (
    <main className="paywall">
      <div>
        <div className="logo"><i />Meu bolso</div>
        <h1 style={{ marginTop: 12 }}>{p?.trial_until ? 'Seu mês grátis acabou' : 'Escolha seu plano'}</h1>
        <p className="muted">{p?.name ? `${p.name}, assine` : 'Assine'} para continuar organizando seu dinheiro.</p>
        {cloud.profileErr && <p className="err">Erro ao carregar seu perfil: {cloud.profileErr}</p>}
      </div>
      <div className="grid">
        <section>
          <h2>Premium</h2>
          <p className="big">{prices.premium || 'R$ 19,90'}<small>por mês</small></p>
          <p className="muted">Até 3 objetivos, renda variável, relatórios, avisos e chat com a equipe.</p>
          <button className="cta" disabled={!!busy} onClick={() => buy('premium')}>{busy === 'premium' ? 'Aguarde…' : 'Assinar Premium'}</button>
        </section>
        <section className="hero-card">
          <h2>Premium Plus</h2>
          <p className="big">{prices.plus || 'R$ 29,90'}<small>por mês</small></p>
          <p className="muted">Tudo do Premium, até 5 objetivos e chat com assistente de IA.</p>
          <button className="cta" disabled={!!busy} onClick={() => buy('plus')}>{busy === 'plus' ? 'Aguarde…' : 'Assinar Plus'}</button>
        </section>
      </div>
      {msg && <p className="err" role="alert">{msg}</p>}

      {!showRef
        ? <div><button className="ghost" onClick={() => setShowRef(true)}>Tenho um código ou link de indicação</button></div>
        : (
          <form className="form" onSubmit={useCode}>
            <input placeholder="Cole o código ou o link de indicação" value={code} onChange={e => setCode(e.target.value)} />
            <button className="cta" disabled={!!busy || !code.trim()}>{busy === 'ref' ? 'Verificando…' : 'Usar código'}</button>
          </form>
        )}

      <p className="tiny">A assinatura renova todo mês até você cancelar, nas configurações da App Store (Ajustes → seu nome → Assinaturas). O pagamento é cobrado na sua conta Apple na confirmação da compra e renova automaticamente, a menos que seja cancelado pelo menos 24 horas antes do fim do período.</p>
      <div>
        <button className="ghost" disabled={!!busy} onClick={restore}>{busy === 'restore' ? 'Restaurando…' : 'Restaurar compras'}</button>
        <button className="ghost" onClick={cloud.logout}>Sair</button>
      </div>
      <p className="tiny"><Policy /> · <Eula /></p>
    </main>
  )
}

export function Chat({ s, P, cloud, say }) {
  const plus = isPlus(cloud.profile)
  const [ch, setCh] = useState('admin'), [msgs, setMsgs] = useState([]), [t, setT] = useState(''), [busy, setBusy] = useState(false)
  const load = async () => { const { data } = await sb.from('bolso_messages').select('role,body,id').eq('channel', ch).order('created_at').limit(60); setMsgs(data || []) }
  useEffect(() => { load() }, [ch])
  const send = async e => {
    e.preventDefault()
    const text = t.trim(); if (!text || busy) return
    setT(''); setBusy(true)
    if (ch === 'admin') {
      const { error } = await sb.from('bolso_messages').insert({ user_id: cloud.user.id, channel: 'admin', role: 'user', body: text })
      if (error) say('Não foi possível enviar agora.')
    } else {
      const summary = `Renda do ciclo R$ ${Math.round(s.variable && P.canVar ? P.earned : s.salary)}; pode gastar hoje R$ ${Math.round(P.daily / P.daysLeft)}; faltam ${P.daysLeft} dias para receber; plano ${P.livreVar < 0 ? 'apertado' : 'fechando'}.`
      const { error } = await sb.functions.invoke('bolso-ai-chat', { body: { text, summary } })
      if (error) say('O assistente não respondeu agora. Tente em instantes.')
    }
    await load(); setBusy(false)
  }
  return (
    <section className="wide">
      <div className="seg">{[['admin', 'Falar com a equipe'], ['ai', 'Assistente IA']].map(([k, l]) => <button key={k} className={ch === k ? 'on' : ''} onClick={() => setCh(k)}>{l}</button>)}</div>
      {ch === 'ai' && !plus ? (
        <div className="locked" style={{ marginTop: 14 }}><p className="muted">O assistente de IA faz parte do Premium Plus (R$ 29,90 por mês).</p></div>
      ) : (
        <>
          {ch === 'ai' && <p className="tiny">Para responder, enviamos ao provedor de IA (Groq) a sua pergunta e um resumo dos números do ciclo, sem seu nome. Não é consultoria financeira.</p>}
          <div className="msgs" style={{ marginTop: 14 }}>
            {msgs.length === 0 && <p className="muted">Nenhuma mensagem ainda. {ch === 'admin' ? 'Conte como podemos ajudar.' : 'Pergunte como fechar o mês.'}</p>}
            {msgs.map(x => <p key={x.id} className={x.role === 'user' ? 'me' : ''}>{x.body}</p>)}
          </div>
          <form className="form" onSubmit={send}><input value={t} onChange={e => setT(e.target.value)} placeholder="Escreva sua mensagem" maxLength={1000} /><button className="cta" disabled={busy}>Enviar</button></form>
        </>
      )}
    </section>
  )
}

export function Visual({ s, set, say, onExit }) {
  const [perm, setPerm] = useState('Notification' in window ? Notification.permission : 'unsupported')
  const ask = async () => { const r = await Notification.requestPermission(); setPerm(r); say(r === 'granted' ? 'Avisos ativados neste aparelho' : 'Permissão não concedida') }
  return (
    <div className="grid">
      <section>
        <h2>Cor do seu app</h2>
        <div className="sw">{[172, 215, 265, 330, 18, 45].map(h => <button key={h} aria-label={`Matiz ${h}`} className={s.hue === h ? 'on' : ''} style={{ background: `hsl(${h} 85% 60%)` }} onClick={() => set({ hue: h })} />)}</div>
        <label>Ajuste fino<input type="range" min="0" max="360" value={s.hue} onChange={e => set({ hue: +e.target.value })} className="hue" /></label>
        <div className="seg">{[['dark', 'Escuro'], ['light', 'Claro']].map(([k, l]) => <button key={k} className={s.mode === k ? 'on' : ''} onClick={() => set({ mode: k })}>{l}</button>)}</div>
      </section>
      <section>
        <h2>Avisos e privacidade</h2>
        {isNative ? <p className="muted">Ative os avisos do aparelho em Minha conta.</p>
          : perm === 'unsupported' ? <p className="muted">Este navegador não oferece avisos no aparelho.</p>
          : perm === 'granted' ? <p className="muted">Avisos ativos: você recebe o principal alerta do dia ao abrir o app.</p>
          : <button className="ghost" onClick={ask}>Ativar avisos no aparelho</button>}
        <button className="ghost" onClick={() => set({ hide: !s.hide })}>{s.hide ? 'Mostrar valores' : 'Ocultar valores'}</button>
        <button className="ghost" onClick={onExit}>Sair</button>
      </section>
    </div>
  )
}

function Perfil({ cloud, say, P }) {
  const p = cloud.profile, [conf, setConf] = useState('')
  const left = p?.trial_until ? Math.ceil((new Date(p.trial_until) - Date.now()) / 864e5) : 0
  const push = async () => {
    try { await enablePush(cloud.user); say('Avisos ativados neste aparelho') }
    catch (e) { say(e.message === 'denied' ? 'Permissão negada. Libere nas configurações do aparelho.' : 'Este aparelho não suporta avisos. No iPhone, adicione o app à Tela de Início.') }
  }
  const del = async () => {
    const { error } = await sb.functions.invoke('bolso-delete-account')
    if (error) return say('Não foi possível excluir agora.')
    cloud.logout()
  }
  return (
    <div className="grid">
      <section>
        <h2>Minha conta</h2>
        <p>{p?.name}</p>
        <p className="muted">{p?.plan === 'plus' ? 'Premium Plus' : p?.plan === 'premium' ? 'Premium' : left > 0 ? `Mês grátis: ${left} ${left === 1 ? 'dia' : 'dias'} restantes` : 'Sem plano ativo'}</p>
        <p className="tiny">Seu plano inclui até {P.limit} {P.limit === 1 ? 'objetivo' : 'objetivos'}{P.canVar ? ' e renda variável' : ''}.</p>
        <button className="ghost" onClick={push}>Ativar avisos no aparelho</button>
        <button className="ghost" onClick={cloud.logout}>Sair</button>
        <p className="tiny"><Policy /></p>
      </section>
      <section className="danger">
        <h2>Excluir conta</h2>
        <p className="muted">Apaga seus dados, mensagens e avisos de forma definitiva. Se você tem assinatura, cancele também na App Store ou no Google Play.</p>
        <div className="form"><input placeholder="Digite EXCLUIR para confirmar" value={conf} onChange={e => setConf(e.target.value)} /><button className="cta" disabled={conf !== 'EXCLUIR'} onClick={del}>Excluir minha conta</button></div>
      </section>
    </div>
  )
}

const SUBS = [['conta', 'Minha conta'], ['indique', 'Indique'], ['chat', 'Chat'], ['visual', 'Visual']]

export function Conta(props) {
  const { cloud, sub, setSub, s, set, say } = props
  return (
    <>
      <div className="seg" style={{ marginBottom: 14 }}>{SUBS.map(([k, l]) => <button key={k} className={sub === k ? 'on' : ''} onClick={() => setSub(k)}>{l}</button>)}</div>
      {sub === 'conta' && <Perfil {...props} />}
      {sub === 'indique' && <Indique s={s} say={say} code={cloud.profile?.ref_code} />}
      {sub === 'chat' && <Chat {...props} />}
      {sub === 'visual' && <Visual s={s} set={set} say={say} onExit={cloud.logout} />}
    </>
  )
}