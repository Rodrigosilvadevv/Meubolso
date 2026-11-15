import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Ganhos, Relatorio, Dicas, controlAlerts, addMonth, TIPS0 } from './Extras'
import { useCloud, tierOf } from './cloud'
import { useStore, usePushState } from './db'
import AdminPage from './AdminPage'
import { Auth, Paywall, Conta } from './Account'
import { Ciclo } from './Ciclo'


const LEVELS = {
  essencial: { label: 'Essencial', color: 'var(--ess)' },
  imprevisto: { label: 'Imprevistos', color: 'var(--imp)' },
  objetivo: { label: 'Objetivo', color: 'var(--obj)' },
  livre: { label: 'Livre', color: 'var(--liv)' },
}
// Quantos objetivos cada nível pode ter. Renda variável: só premium e plus.
const LIMITS = { free: 1, premium: 3, plus: 5 }
const brl = n => (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const pad = n => String(n).padStart(2, '0')
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const at = (y, m, d) => new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()))
const diff = (a, b) => Math.round((b - a) / 864e5)
const when = n => (n <= 0 ? 'hoje' : n === 1 ? 'amanhã' : `em ${n} dias`)
// Banners e dicas são configuração fixa do app (não são dados da pessoa)
const CFG = { banners: [], tips: TIPS0 }

function cycle(payDay) {
  const t = new Date()
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate())
  const y = today.getFullYear(), m = today.getMonth()
  const p = at(y, m, payDay)
  const paid = today >= p
  return { today, start: paid ? p : at(y, m - 1, payDay), end: paid ? at(y, m + 1, payDay) : p }
}

function plan(s0, tier) {
  const canVar = tier !== 'free'
  const { today, start, end } = cycle(s0.payDay)
  const a0 = toISO(start), b0 = toISO(end), t0 = toISO(today)
  const daysLeft = Math.max(1, diff(today, end))
  const earned = s0.earns.filter(x => x.date >= a0 && x.date < b0).reduce((a, x) => a + x.value, 0)
  const s = { ...s0, salary: s0.variable && canVar ? Math.max(earned, s0.salary) : s0.salary }
  const sum = l => s.fixed.filter(f => f.level === l).reduce((a, f) => a + f.value, 0)
  const essFixed = sum('essencial'), livFixed = sum('livre')
  const reserve = (s.salary * s.reservePct) / 100

  // Objetivos. O valor reservado por ciclo (need) é calculado sobre o que faltava NO INÍCIO
  // do ciclo (left + depósitos deste ciclo). Assim, guardar dinheiro não "libera" mais gasto livre.
  const deps = s.deposits || []
  const goals = (s.goals || []).map(g => {
    const dep = deps.filter(d => d.goalId === g.id && d.date >= a0 && d.date < b0).reduce((a, d) => a + d.value, 0)
    const left = Math.max(0, g.target - g.saved)
    const before = Math.min(g.target, Math.max(0, g.target - (g.saved - dep)))
    const months = g.date ? Math.max(1, Math.round(diff(today, new Date(g.date + 'T00:00')) / 30.44)) : 0
    const need = months ? before / months : 0
    return { ...g, left, months, need, dep, todo: Math.max(0, need - dep), pct: g.target ? Math.min(100, (g.saved / g.target) * 100) : 0 }
  })
  const left = goals.reduce((a, g) => a + g.left, 0)
  const goalNeed = goals.reduce((a, g) => a + g.need, 0)
  const livreVar = s.salary - essFixed - livFixed - s.varEss - reserve - goalNeed

  const cyc = s.spends.filter(x => x.date >= a0 && x.date < b0)
  const spent = b => cyc.filter(x => x.bucket === b).reduce((a, x) => a + x.value, 0)
  const spentToday = b => cyc.filter(x => x.bucket === b && x.date === t0).reduce((a, x) => a + x.value, 0)
  const rem = { essencial: s.varEss - spent('essencial'), imprevisto: reserve - spent('imprevisto'), livre: livreVar - spent('livre') }

  // Saldo livre do ciclo (essencial variável + livre variável)
  const daily = Math.max(0, rem.essencial) + Math.max(0, rem.livre)

  // Limite do dia = saldo que havia no começo de hoje dividido pelos dias que restam (hoje incluído).
  // "Pode gastar hoje" = limite do dia menos o que já foi gasto hoje.
  const poolStart = Math.max(0, rem.essencial + spentToday('essencial')) + Math.max(0, rem.livre + spentToday('livre'))
  const perDay = poolStart / daysLeft
  const todayLeft = Math.max(0, perDay - spentToday('essencial') - spentToday('livre'))

  // Quanto sobra por mês depois de tudo, menos os objetivos
  const free = s.salary - essFixed - livFixed - s.varEss - reserve
  // A previsão só faz sentido quando o plano NÃO fecha no prazo dos objetivos
  const eta = livreVar < 0 && free > 0 && left > 0 ? new Date(today.getFullYear(), today.getMonth() + Math.ceil(left / free), 1) : null
  return {
    today, start, end, earned, daysLeft, goals, goalNeed, livreVar, rem, spent, cyc, eta, free, left, reserve,
    tier, canVar, limit: LIMITS[tier],
    split: { essencial: essFixed + s.varEss, imprevisto: reserve, objetivo: goalNeed, livre: Math.max(0, livreVar) + livFixed },
    daily, perDay, todayLeft,
  }
}

function alerts(s, P) {
  const a = [], { today } = P
  const y = today.getFullYear(), m = today.getMonth()
  s.fixed.filter(f => f.day).map(f => {
    const d = at(y, m, f.day)
    return { f, n: diff(today, d >= today ? d : at(y, m + 1, f.day)) }
  }).filter(x => x.n <= 5).sort((p, q) => p.n - q.n).forEach(({ f, n }) =>
    a.push({ id: 'due' + f.id, tone: n <= 1 ? 'warn' : 'info', title: `${f.name} vence ${when(n)}`, text: `${brl(f.value)} — deixe separado para não apertar.`, tab: 'plano' }))
  if (s.salary > 0 && P.daysLeft <= 5)
    a.push({ id: 'pay', tone: 'good', title: `Seu salário cai ${when(P.daysLeft)}`, text: 'Hora de revisar o que sobrou e planejar o próximo ciclo.', tab: 'inicio' })
  P.goals.forEach(g => {
    if (!g.target) return
    const nm = g.name || 'objetivo'
    if (g.pct >= 100) a.push({ id: 'won' + g.id, tone: 'good', title: `Meta batida: ${nm}!`, text: 'Você conquistou. Que tal definir o próximo objetivo?', tab: 'meta' })
    else {
      const next = [25, 50, 75, 100].find(x => x > g.pct)
      const gap = (g.target * next) / 100 - g.saved
      if (gap <= g.target * 0.08) a.push({ id: 'near' + g.id, tone: 'good', title: `Falta pouco para ${next}% de ${nm}`, text: `Mais ${brl(gap)} e você chega lá.`, tab: 'meta' })
    }
  })
  ;[['essencial', 'Essencial', s.varEss], ['livre', 'Livre', P.livreVar]].forEach(([k, label, b]) => {
    const used = P.spent(k)
    if (b > 0 && used >= b * 0.8)
      a.push({ id: 'bud' + k, tone: used > b ? 'bad' : 'warn', title: used > b ? `${label}: limite estourado` : `${label}: ${Math.round((used / b) * 100)}% usado`, text: used > b ? `Passou ${brl(used - b)} do planejado.` : `Restam ${brl(b - used)} neste ciclo.`, tab: 'gastos' })
  })
  return [...controlAlerts(s, P), ...a]
}

const ICONS = {
  chart: 'M4 20V10m6 10V4m6 16v-8m4 8H2',
  bulb: 'M9 18h6m-5 3h4M12 3a6 6 0 00-4 10c1 1 1 2 1 3h6c0-1 0-2 1-3a6 6 0 00-4-10z', user: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0',
  home: 'M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z', list: 'M4 6h16M4 12h16M4 18h10',
  target: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 5a4 4 0 100 8 4 4 0 000-8z', sliders: 'M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6',
  bell: 'M6 16v-5a6 6 0 1112 0v5l2 2H4zM10 21h4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10-3a3 3 0 100 6 3 3 0 000-6z',
}
const Ic = ({ n }) => (
  <svg viewBox="0 0 24 24" className="ic" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[n]} /></svg>
)
const TABS = [['inicio', 'Início', 'home'], ['gastos', 'Gastos', 'list'], ['meta', 'Metas', 'target'], ['relatorio', 'Relatório', 'chart'], ['plano', 'Plano', 'sliders'], ['dicas', 'Dicas', 'bulb'], ['conta', 'Conta', 'user']]
const SUBTABS = ['indique', 'chat', 'visual']

const Num = ({ value, onChange, ...p }) => (
  <input type="number" inputMode="decimal" min="0" step="0.01" value={value || ''}
    onChange={e => onChange(parseFloat(e.target.value) || 0)} {...p} />
)

function useCount(v) {
  const [x, setX] = useState(0)
  useEffect(() => {
    let f, t0; const a = x
    const run = t => { t0 ??= t; const p = Math.min(1, (t - t0) / 800); setX(a + (v - a) * (1 - Math.pow(1 - p, 3))); if (p < 1) f = requestAnimationFrame(run) }
    f = requestAnimationFrame(run)
    return () => cancelAnimationFrame(f)
  }, [v])
  return x
}

function Main() {
  const cloud = useCloud()
  const ok = cloud.status === 'in'
  const tier = tierOf(cloud.profile)
  const locked = ok && tier === 'free' // logado, sem plano e sem trial
  const [tab, setTab] = useState('inicio')
  const [sub, setSub] = useState('conta')
  const [bell, setBell] = useState(false)
  const [toast, setToast] = useState('')
  const say = (t, ms = 3200) => { setToast(t); setTimeout(() => setToast(''), ms) }

  // Os dados moram no banco: cada ação grava na tabela e só então a tela muda.
  const store = useStore(cloud.user?.id, ok, e => say(`Não foi possível salvar: ${e?.message || e}`, 7000))
  const { act, phase } = store
  const s = useMemo(() => ({ ...store.s, cfg: CFG }), [store.s])
  const P = useMemo(() => plan(s, tier), [s, tier])
  const A = useMemo(() => alerts(s, P), [s, P])
    usePushState(cloud.user?.id, phase === 'ready', s, P)
  const m = n => (s.hide ? 'R$ •••••' : brl(n))
  const go = t => {
    if (SUBTABS.includes(t)) { setSub(t); t = 'conta' }
    setTab(t); setBell(false); window.scrollTo({ top: 0 })
  }

  // Na primeira vez que os dados chegam, quem ainda não tem plano começa pela aba Plano.
  const opened = useRef(false)
  useEffect(() => {
    if (phase === 'ready' && !opened.current) {
      opened.current = true
      if (!store.s.salary) setTab('plano')
    }
    if (!ok) opened.current = false
  }, [phase, ok])

  
   // Aviso do dia (navegador), no máximo uma vez por dia (o dia fica salvo no banco)
  useEffect(() => {
    if (phase !== 'ready' || !A[0] || !('Notification' in window) || Notification.permission !== 'granted') return
    const day = toISO(P.today)
    if (s.notifDay === day) return
    new Notification('Meu bolso', { body: A[0].title })
    act.saveSettings({ notifDay: day })
  }, [phase])

  const cls = `app ${s.mode}`, sty = { '--h': s.hue }
  if (!ok || locked) {
    return (
      <div className={cls} style={sty}>
       {cloud.status === 'loading' ? <div className="boot" role="status" aria-label="Carregando"><i /><span>Meu bolso</span></div>
          : cloud.status === 'out' ? <Auth />
          : <Paywall cloud={cloud} />}
      </div>
    )
  }
  if (phase !== 'ready') {
    return (
      <div className={cls} style={sty}>
        {phase === 'error' ? (
          <main className="paywall">
            <div>
              <div className="logo"><i />Meu bolso</div>
              <h1 style={{ marginTop: 12 }}>Não consegui carregar seus dados</h1>
              <p className="err" role="alert">{store.err}</p>
              <button className="cta" onClick={store.reload}>Tentar de novo</button>
              <button className="ghost" onClick={cloud.logout}>Sair</button>
            </div>
          </main>
        ) : <div className="boot" role="status" aria-label="Carregando"><i /><span>Meu bolso</span></div>}
      </div>
    )
  }

  const first = (cloud.profile?.name || 'Você').split(' ')[0], hr = new Date().getHours()
  const props = { s, act, P, A, m, go, say }
  return (
    <div className={cls} style={sty}>
      <aside>
        <div className="logo"><i />Meu bolso</div>
        {TABS.map(([k, l, i]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => go(k)}><Ic n={i} />{l}</button>)}
      </aside>
      <div className="main">
        <header>
          <div><small>{hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite'},</small><h1>{first}</h1></div>
          <div className="acts">
            <button aria-label={s.hide ? 'Mostrar valores' : 'Ocultar valores'} className={s.hide ? 'on' : ''} onClick={() => act.saveSettings({ hide: !s.hide })}><Ic n="eye" /></button>
            <button aria-label="Avisos" onClick={() => setBell(!bell)}><Ic n="bell" />{A.length > 0 && <b className="dot">{A.length}</b>}</button>
            <span className="av">{first[0].toUpperCase()}</span>
          </div>
          {bell && (
            <div className="pop">
              <h3>Avisos</h3>
              {A.length === 0 && <p className="muted">Nada por agora. Tudo em dia.</p>}
              {A.map(a => <button key={a.id} className={`note ${a.tone}`} onClick={() => go(a.tab)}><b>{a.title}</b><span>{a.text}</span></button>)}
            </div>
          )}
        </header>
        {tab === 'inicio' && <Inicio {...props} />}
        {tab === 'gastos' && <Gastos {...props} />}
        {tab === 'meta' && <Meta {...props} />}
        {tab === 'plano' && <Plano {...props} />}
        {tab === 'relatorio' && <Relatorio {...props} />}
        {tab === 'dicas' && <Dicas {...props} />}
        {tab === 'conta' && <Conta {...props} cloud={cloud} sub={sub} setSub={setSub} />}
      </div>
      <nav className="tabs">
        {TABS.map(([k, l, i]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => go(k)}><Ic n={i} />{l}</button>)}
      </nav>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

function Banners({ A, s, go }) {
  const cb = s.cfg.banners.filter(b => b.on).map(b => ({ ...b, id: 'cfg' + b.id }))
  const L = cb.length + A.length ? [...cb, ...A].slice(0, 5) : [s.salary
    ? { id: 'ok', tone: 'good', title: 'Tudo em dia', text: 'Nenhum vencimento ou limite por perto. Continue assim.' }
    : { id: 'new', tone: 'good', title: 'Monte seu plano em 2 minutos', text: 'Informe salário e gastos fixos para ver quanto pode gastar por dia.', tab: 'plano' }]
  const [i, setI] = useState(0)
  useEffect(() => { if (L.length < 2) return; const t = setInterval(() => setI(v => (v + 1) % L.length), 5500); return () => clearInterval(t) }, [L.length])
  const b = L[i % L.length]
  return (
    <section className={`ban ${b.tone}`} aria-live="polite">
      <div key={b.id} className="slide">
        <h2>{b.title}</h2><p>{b.text}</p>
        {b.tab && <button className="ghost" onClick={() => go(b.tab)}>Ver detalhes</button>}
      </div>
      {L.length > 1 && <div className="dots">{L.map((x, k) => <button key={x.id} aria-label={`Aviso ${k + 1}`} className={k === i % L.length ? 'on' : ''} onClick={() => setI(k)} />)}</div>}
    </section>
  )
}

function Inicio({ s, P, A, m, go }) {
  const [on, setOn] = useState(false)
  useEffect(() => { const t = setTimeout(() => setOn(true), 80); return () => clearTimeout(t) }, [])
  const total = s.varEss + Math.max(0, P.livreVar)
  const pct = total > 0 ? Math.max(0, Math.min(1, P.daily / total)) : 0
  const C = 2 * Math.PI * 54
  const day = useCount(P.todayLeft)
  const gp = P.goals.reduce((a, g) => Math.max(a, g.pct), 0)
  const badges = [['Plano criado', s.salary > 0], ['Primeiro gasto', s.spends.length > 0], ['No orçamento', s.salary > 0 && P.rem.livre >= 0 && P.rem.essencial >= 0], ['Meta 25%', gp >= 25], ['Meta 50%', gp >= 50], ['Meta batida', gp >= 100]]
  return (
    <div className="grid">
      <div className="wide"><Banners A={A} s={s} go={go} /></div>
      <section className="hero-card">
        <div className="ring">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="54" className="t" />
            <circle cx="60" cy="60" r="54" className="p" style={{ strokeDasharray: C, strokeDashoffset: on ? C * (1 - pct) : C }} />
          </svg>
          <div><small>Hoje você pode gastar</small><p className="big">{s.hide ? 'R$ •••' : brl(day)}</p></div>
        </div>
        <p className="muted">{P.daysLeft} {P.daysLeft === 1 ? 'dia' : 'dias'} até o salário ({P.end.toLocaleDateString('pt-BR')}). Limite por dia: {m(P.perDay)}. Disponível no ciclo: {m(P.daily)}.</p>
      </section>
      <section>
        <h2>Para onde vai seu salário</h2>
        <div className="bar">{Object.entries(LEVELS).map(([k, l]) => P.split[k] > 0 && <i key={k} style={{ flex: P.split[k], background: l.color }} title={l.label} />)}</div>
        <ul className="legend">{Object.entries(LEVELS).map(([k, l]) => <li key={k}><b style={{ background: l.color }} />{l.label} <span>{m(P.split[k])}</span></li>)}</ul>
        {s.salary > 0 && P.livreVar < 0 && (
          <p className="warn">O plano não fecha: faltam {m(-P.livreVar)} por mês. {P.eta ? `Com o que sobra (${m(P.free)}/mês), você chega nos objetivos em ${P.eta.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}.` : 'Reduza gastos ou a reserva para abrir espaço.'}</p>
        )}
      </section>
      <Ciclo s={s} P={P} m={m} />
      <section className="wide">
        <h2>Conquistas</h2>
        <ul className="badges">{badges.map(([l, got]) => <li key={l} className={got ? 'got' : ''}>{got ? '✓' : '○'} {l}</li>)}</ul>
      </section>
    </div>
  )
}

function Gastos({ s, act, P, m, say }) {
  const [f, setF] = useState({ desc: '', value: 0, bucket: 'essencial' })
  const [busy, setBusy] = useState(false)
  // "Ganho do dia" só aparece se a pessoa marcou renda variável no Plano (e o plano permite).
  const varOn = s.variable && P.canVar
  const add = async e => {
    e.preventDefault()
    if (!f.value || busy) return
    setBusy(true)
    const saved = await act.addSpend({ ...f, date: toISO(new Date()) })
    setBusy(false)
    if (saved) { setF({ desc: '', value: 0, bucket: f.bucket }); say('Gasto salvo') }
  }
  return (
    <div className="grid">
      <section>
        <h2>Registrar gasto</h2>
        <form onSubmit={add} className="form">
          <div className="seg">{['essencial', 'imprevisto', 'livre'].map(k => <button type="button" key={k} className={f.bucket === k ? 'on' : ''} onClick={() => setF({ ...f, bucket: k })}><b style={{ background: LEVELS[k].color }} />{LEVELS[k].label}</button>)}</div>
          <input placeholder="O que foi?" value={f.desc} onChange={e => setF({ ...f, desc: e.target.value })} />
          <Num placeholder="Valor" value={f.value} onChange={v => setF({ ...f, value: v })} />
          <button className="cta" disabled={busy}>{busy ? 'Salvando…' : 'Registrar'}</button>
        </form>
      </section>
      {varOn && <Ganhos s={s} act={act} P={P} m={m} say={say} />}
      <section>
        <h2>Neste ciclo</h2>
        <ul className="list">
          {P.cyc.length === 0 && <li className="muted">Nenhum gasto neste ciclo ainda.</li>}
          {P.cyc.map(x => (
            <li key={x.id}>
              <b style={{ background: LEVELS[x.bucket].color }} />
              <span>{x.desc || LEVELS[x.bucket].label}<small>{x.date.slice(8)}/{x.date.slice(5, 7)}</small></span>
              <em>{m(x.value)}</em>
              <button className="x" aria-label="Remover" onClick={() => act.removeSpend(x.id)}>×</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function GoalCard({ g, act, m, say }) {
  const [v, setV] = useState(0)
  const [busy, setBusy] = useState(false)
  const dep = async e => {
    e.preventDefault()
    if (!v || busy) return
    const after = Math.min(100, ((g.saved + v) / g.target) * 100)
    const hit = [100, 75, 50, 25].find(x => g.pct < x && after >= x)
    setBusy(true)
    const saved = await act.deposit(g.id, v)
    setBusy(false)
    if (!saved) return
    setV(0)
    say(hit ? `🎉 Você chegou a ${hit}% de ${g.name || 'sua meta'}!` : 'Depósito registrado')
  }
  const delay = async () => {
    // Sem data não há o que adiar
    if (!g.date) return say('Defina uma data antes de adiar a meta.')
    if (await act.saveGoal({ ...g, date: addMonth(g.date), delays: (g.delays || 0) + 1 })) say('Meta adiada em 1 mês')
  }
  const monthly = g.left === 0
    ? 'Meta batida! Parabéns.'
    : g.months
      ? `Guarde ${m(g.need)} por mês (${g.months} ${g.months === 1 ? 'mês' : 'meses'}) para chegar no prazo. ${g.todo > 0 ? `Neste ciclo ainda faltam ${m(g.todo)}.` : 'Neste ciclo você já guardou o combinado.'}`
      : 'Defina uma data em "Meus objetivos" para ver quanto guardar por mês.'
  return (
    <section className="hero-card">
      <h2>{g.name || 'Objetivo'}</h2>
      <p className="big">{g.pct.toFixed(0)}%</p>
      <div className="track tall"><i style={{ width: `${g.pct}%`, background: 'var(--obj)' }} />{[25, 50, 75].map(x => <u key={x} style={{ left: `${x}%` }} />)}</div>
      <div className="marks">{[25, 50, 75, 100].map(x => <span key={x} className={g.pct >= x ? 'got' : ''}>{x}%</span>)}</div>
      <p className="muted">{m(g.saved)} de {m(g.target)} · meta para {g.date ? new Date(g.date + 'T00:00').toLocaleDateString('pt-BR') : 'sem data'}.</p>
      <p className="muted">{monthly}</p>
      <form className="form" onSubmit={dep}>
        <Num placeholder={g.todo > 0 ? `Sugestão: ${g.todo.toFixed(2)}` : 'Valor a guardar'} value={v} onChange={setV} />
        <button className="cta" disabled={busy}>{busy ? 'Salvando…' : 'Guardar'}</button>
      </form>
      <button className="ghost" type="button" onClick={delay}>Adiar meta em 1 mês</button>
    </section>
  )
}

// Formulário de um objetivo: edita um rascunho e só grava no banco ao apertar "Salvar objetivo".
function GoalForm({ g, isNew, act, say, onDone }) {
  const from = x => ({ name: x.name, target: x.target, date: x.date, saved: x.saved })
  const [d, setD] = useState(from(g))
  const [busy, setBusy] = useState(false)
  // Se o objetivo mudou no banco (ex.: depósito), o rascunho acompanha
  useEffect(() => { setD(from(g)) }, [g.name, g.target, g.date, g.saved])
  const dirty = isNew || d.name !== g.name || d.target !== g.target || d.date !== g.date || d.saved !== g.saved
  const save = async e => {
    e.preventDefault()
    if (busy) return
    if (!(d.target > 0)) return say('Informe quanto custa o objetivo.')
    setBusy(true)
    const saved = await act.saveGoal({ ...g, ...d })
    setBusy(false)
    if (saved) { say('Objetivo salvo'); onDone?.() }
  }
  const del = async () => {
    if (isNew) return onDone?.()
    if (await act.removeGoal(g.id)) say('Objetivo removido')
  }
  return (
    <form className="form" onSubmit={save}>
      <input value={d.name} placeholder="O que quero (ex.: Viagem)" aria-label="Nome do objetivo" onChange={e => setD({ ...d, name: e.target.value })} />
      <Num placeholder="Quanto custa" aria-label="Quanto custa" value={d.target} onChange={v => setD({ ...d, target: v })} />
      <input type="date" aria-label="Até quando" value={d.date} onChange={e => setD({ ...d, date: e.target.value })} />
      <Num placeholder="Já guardei" aria-label="Já guardei" value={d.saved} onChange={v => setD({ ...d, saved: v })} />
      <button className="cta" disabled={busy || !dirty}>{busy ? 'Salvando…' : 'Salvar objetivo'}</button>
      <button type="button" className="ghost" onClick={del}>Remover objetivo</button>
    </form>
  )
}

function Meta({ s, act, P, m, say }) {
  const [novo, setNovo] = useState(null)
  const list = P.goals.filter(g => g.target > 0)
  const atLimit = s.goals.length + (novo ? 1 : 0) >= P.limit
  const add = () => { if (!atLimit) setNovo({ id: 0, name: '', target: 0, date: '', saved: 0, delays: 0 }) }
  return (
    <div className="grid">
      <section className="wide">
        <h2>Meus objetivos</h2>
        {s.goals.length === 0 && !novo && <p className="muted">Diga o que quer conquistar, quanto custa e até quando.</p>}
        <div className="form">
          {s.goals.map(g => <GoalForm key={g.id} g={g} act={act} say={say} />)}
          {novo && <GoalForm key="novo" g={novo} isNew act={act} say={say} onDone={() => setNovo(null)} />}
          <button type="button" className="ghost" disabled={atLimit} onClick={add}>Adicionar objetivo</button>
          {atLimit && <p className="tiny">Seu plano permite até {P.limit} {P.limit === 1 ? 'objetivo' : 'objetivos'}.</p>}
        </div>
      </section>
      {list.map(g => <GoalCard key={g.id} g={g} act={act} m={m} say={say} />)}
      {P.eta && <section className="wide"><p className="muted">O plano não fecha no prazo dos objetivos. Guardando tudo o que sobra ({m(P.free)} por mês), você chega lá em {P.eta.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}.</p></section>}
    </div>
  )
}

function Plano({ s, act, P, say }) {
  const [n, setN] = useState({ name: '', value: 0, level: 'essencial', day: 0 })
  // Salário e limites são rascunhos: só vão para o banco ao apertar "Salvar"
  const [a, setA] = useState({ salary: s.salary, payDay: s.payDay, variable: s.variable })
  const [b, setB] = useState({ varEss: s.varEss, reservePct: s.reservePct })
  const [busy, setBusy] = useState('')
  useEffect(() => { setA({ salary: s.salary, payDay: s.payDay, variable: s.variable }) }, [s.salary, s.payDay, s.variable])
  useEffect(() => { setB({ varEss: s.varEss, reservePct: s.reservePct }) }, [s.varEss, s.reservePct])

  const saveSettings = (key, draft, msg) => async e => {
    e.preventDefault()
    if (busy) return
    setBusy(key)
    const saved = await act.saveSettings(draft)
    setBusy('')
    if (saved) say(msg)
  }
  const add = async e => {
    e.preventDefault()
    if (!n.name || !n.value || busy) return
    setBusy('fixed')
    const saved = await act.addFixed(n)
    setBusy('')
    if (saved) { setN({ name: '', value: 0, level: n.level, day: 0 }); say('Gasto fixo salvo') }
  }
  const varOn = a.variable && P.canVar
  return (
    <div className="grid">
      <section>
        <h2>Salário</h2>
        <form className="form" onSubmit={saveSettings('a', a, 'Salário salvo')}>
          <label className="chk"><input type="checkbox" checked={varOn} disabled={!P.canVar} onChange={e => setA({ ...a, variable: e.target.checked })} />Minha renda varia (diarista, autônomo, apps)</label>
          {!P.canVar && <p className="tiny">Renda variável faz parte do Premium e do Plus.</p>}
          <label>{varOn ? 'Estimativa mínima do mês' : 'Valor líquido'}<Num value={a.salary} onChange={v => setA({ ...a, salary: v })} /></label>
          <label>Dia que recebo<input type="number" min="1" max="31" value={a.payDay} onChange={e => setA({ ...a, payDay: Math.min(31, Math.max(1, +e.target.value || 1)) })} /></label>
          <button className="cta" disabled={busy === 'a'}>{busy === 'a' ? 'Salvando…' : 'Salvar salário'}</button>
        </form>
      </section>
      <section className="wide">
        <h2>Gastos fixos</h2>
        <form onSubmit={add} className="form row4">
          <input placeholder="Ex.: Aluguel" value={n.name} onChange={e => setN({ ...n, name: e.target.value })} />
          <Num placeholder="Valor" value={n.value} onChange={v => setN({ ...n, value: v })} />
          <input type="number" min="1" max="31" placeholder="Dia do vencimento" value={n.day || ''} onChange={e => setN({ ...n, day: Math.min(31, +e.target.value || 0) })} />
          <select value={n.level} onChange={e => setN({ ...n, level: e.target.value })}>
            <option value="essencial">Essencial</option>
            <option value="livre">Livre (assinaturas, lazer)</option>
          </select>
          <button className="cta" disabled={busy === 'fixed'}>{busy === 'fixed' ? 'Salvando…' : 'Adicionar'}</button>
        </form>
        <ul className="list">
          {s.fixed.map(x => (
            <li key={x.id}>
              <b style={{ background: LEVELS[x.level].color }} /><span>{x.name}{x.day ? <small>vence dia {x.day}</small> : null}</span><em>{brl(x.value)}</em>
              <button className="x" aria-label="Remover" onClick={() => act.removeFixed(x.id)}>×</button>
            </li>
          ))}
        </ul>
        <form className="form" onSubmit={saveSettings('b', b, 'Limites salvos')}>
          <label>Essenciais variáveis por mês (mercado, transporte)<Num value={b.varEss} onChange={v => setB({ ...b, varEss: v })} /></label>
          <label>Reserva de imprevistos ({b.reservePct}% do salário)
            <input type="range" min="0" max="30" value={b.reservePct} onChange={e => setB({ ...b, reservePct: +e.target.value })} />
          </label>
          <button className="cta" disabled={busy === 'b'}>{busy === 'b' ? 'Salvando…' : 'Salvar limites'}</button>
        </form>
      </section>
    </div>
  )
}

export default function App() {
  return location.pathname.replace(/\/$/, '') === '/meubolsinho' ? <AdminPage /> : <Main />
}