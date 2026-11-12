import { useState } from 'react'

const brl = n => (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const pad = n => String(n).padStart(2, '0')
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const at = (y, m, d) => new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()))
const diff = (a, b) => Math.round((b - a) / 864e5)
const BK = { essencial: 'Essencial', imprevisto: 'Imprevistos', livre: 'Livre' }
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const Num = ({ value, onChange, ...p }) => (
  <input type="number" inputMode="decimal" min="0" step="0.01" value={value || ''} onChange={e => onChange(parseFloat(e.target.value) || 0)} {...p} />
)

export const addMonth = d => { if (!d) return d; const x = new Date(d + 'T00:00'); return toISO(at(x.getFullYear(), x.getMonth() + 1, x.getDate())) }

export const TIPS0 = [
  { id: 1, tight: true, title: 'Pague primeiro o que tem juros altos', text: 'Rotativo do cartão e cheque especial são as dívidas mais caras. Peça renegociação ao banco antes de atrasar.' },
  { id: 2, tight: true, title: 'Veja se você tem direito a benefícios', text: 'Quem tem renda baixa pode ter direito a tarifa social de energia e outros programas. Procure o CRAS da sua cidade e confirme as regras atuais.' },
  { id: 3, tight: true, title: 'Vá ao mercado com lista', text: 'Compare preços no atacarejo, vá depois de comer e leve só o que anotou.' },
  { id: 4, tight: true, title: 'Desconfie de crédito fácil', text: 'Oferta que cobra taxa antes de liberar o dinheiro é golpe. Compare o custo total antes de assinar qualquer empréstimo.' },
  { id: 5, tight: false, title: 'Guarde um pouco, mesmo que seja pouco', text: 'R$ 10 por semana já formam uma reserva e evitam o empréstimo caro no próximo imprevisto.' },
]

export function controlAlerts(s, P) {
  const a = [], today = toISO(P.today)
  if (P.canVar && s.variable && !s.earns.some(x => x.date === today) && !s.spends.some(x => x.date === today))
    a.push({ id: 'chk', tone: 'info', title: 'Como foi seu dia?', text: 'Anote o que ganhou e gastou hoje para o plano ficar certo.', tab: 'gastos' })
  const total = s.varEss + Math.max(0, P.livreVar), used = P.spent('essencial') + P.spent('livre')
  const t = (diff(P.start, P.today) + 1) / Math.max(1, diff(P.start, P.end))
  if (total > 0 && used / total > t + 0.2)
    a.push({ id: 'ctl', tone: 'bad', title: 'Ei, se controle: você está perdendo o ritmo', text: `Já usou ${Math.round((used / total) * 100)}% do limite com ${Math.round(t * 100)}% do ciclo.`, tab: 'gastos' })
  const late = (s.goals || []).find(g => (g.delays || 0) >= 2)
  if (late)
    a.push({ id: 'dly' + late.id, tone: 'warn', title: `Você adiou "${late.name || 'a meta'}" ${late.delays} vezes`, text: 'Que tal guardar um valor menor, mas todo mês, para não perder o objetivo?', tab: 'meta' })
  return a
}

export function Ganhos({ s, set, P, m }) {
  const [f, setF] = useState({ date: toISO(new Date()), value: 0, desc: '' })
  const add = e => { e.preventDefault(); if (!f.value) return; set({ earns: [{ id: Date.now(), ...f }, ...s.earns] }); setF({ ...f, value: 0, desc: '' }) }
  const cyc = s.earns.filter(x => x.date >= toISO(P.start) && x.date < toISO(P.end))
  return (
    <section className="wide">
      <h2>Ganhos por dia</h2>
      <p className="muted">{s.variable ? `Recebido neste ciclo: ${m(P.earned)}. O plano se ajusta ao que entra.` : 'Sua renda varia? Ative a opção no Plano para o orçamento seguir o que você recebe.'}</p>
      <form onSubmit={add} className="form" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))' }}>
        <input type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} aria-label="Dia" />
        <Num placeholder="Valor do dia" value={f.value} onChange={v => setF({ ...f, value: v })} />
        <input placeholder="De onde veio?" value={f.desc} onChange={e => setF({ ...f, desc: e.target.value })} />
        <button className="cta">Registrar ganho</button>
      </form>
      <ul className="list">
        {cyc.map(x => (
          <li key={x.id}><b style={{ background: 'var(--obj)' }} /><span>{x.desc || 'Ganho'}<small>{x.date.slice(8)}/{x.date.slice(5, 7)}</small></span><em>{m(x.value)}</em>
            <button className="x" aria-label="Remover" onClick={() => set({ earns: s.earns.filter(y => y.id !== x.id) })}>×</button></li>
        ))}
      </ul>
    </section>
  )
}

export function Relatorio({ s, P, m, go }) {
  const y = P.start.getFullYear(), mo = P.start.getMonth()
  const cyc = [3, 2, 1, 0].map(i => {
    const st = i === 0 ? P.start : at(y, mo - i, s.payDay), en = i === 0 ? P.end : at(y, mo - i + 1, s.payDay)
    const a = toISO(st), b = toISO(en), sp = s.spends.filter(x => x.date >= a && x.date < b)
    const g = k => sp.filter(x => x.bucket === k).reduce((t, x) => t + x.value, 0)
    return { label: st.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }), b: { essencial: g('essencial'), imprevisto: g('imprevisto'), livre: g('livre') }, total: sp.reduce((t, x) => t + x.value, 0), earn: s.earns.filter(x => x.date >= a && x.date < b).reduce((t, x) => t + x.value, 0) }
  })
  const cur = cyc[3], prev = cyc[2], max = Math.max(1, ...cyc.map(c => c.total))
  const all = s.spends.filter(x => x.date >= toISO(at(y, mo - 3, s.payDay)))
  const top = Object.entries(all.reduce((o, x) => { const k = (x.desc || 'Sem descrição').trim().toLowerCase(); o[k] = (o[k] || 0) + x.value; return o }, {})).sort((p, q) => q[1] - p[1]).slice(0, 3)
  const wd = [0, 0, 0, 0, 0, 0, 0]; all.forEach(x => { wd[new Date(x.date + 'T00:00').getDay()] += x.value })
  return (
    <div className="grid">
      <section className="wide">
        <h2>Como você está indo</h2>
        {prev.total === 0 ? <p className="muted">Ainda não há gastos no ciclo anterior para comparar. Continue registrando.</p> : (
          <>
            <p className={cur.total <= prev.total ? 'good' : 'neg'}>
              {cur.total <= prev.total ? 'Melhorou' : 'Piorou'}: {m(cur.total)} gastos até agora contra {m(prev.total)} no ciclo anterior.
            </p>
            <p className="tiny">O ciclo atual ainda está em andamento.</p>
            {Object.entries(BK).map(([k, l]) => {
              const d = cur.b[k] - prev.b[k]
              return <div key={k} className="rep"><span>{l}</span><span>{m(prev.b[k])} → {m(cur.b[k])}</span><em className={d <= 0 ? 'good' : 'neg'}>{d === 0 ? 'igual' : d < 0 ? 'melhorou' : 'piorou'}</em></div>
            })}
          </>
        )}
      </section>
      <section className="wide">
        <h2>Gastos nos últimos 4 ciclos</h2>
        <div className="bars">{cyc.map(c => <div key={c.label}><i style={{ height: `${(c.total / max) * 100}%` }} /><small>{c.label}</small><span>{m(c.total)}</span></div>)}</div>
        {P.canVar && s.variable && <p className="muted">Ganhos neste ciclo: {m(cur.earn)} · ciclo anterior: {m(prev.earn)}.</p>}
      </section>
      <section className="wide">
        <h2>Relatório personalizado</h2>
        {s.refs < 1 ? (
          <div className="locked"><p className="muted">Veja onde mais gasta e em que dia da semana o dinheiro some. Libere indicando um amigo.</p><button className="cta" onClick={() => go('indique')}>Indicar um amigo</button></div>
        ) : all.length === 0 ? <p className="muted">Registre gastos para gerar seu relatório.</p> : (
          <>
            <p>Seus 3 maiores gastos: {top.map(([k, v]) => `${k} (${m(v)})`).join(', ')}.</p>
            <p>Você gasta mais na {DIAS[wd.indexOf(Math.max(...wd))]}.</p>
          </>
        )}
      </section>
    </div>
  )
}

// O código vem do servidor (profile.ref_code). O link usa o endereço público do site,
// porque dentro do app de iPhone o endereço interno (capacitor://localhost) não abre para ninguém.
export function Indique({ s, say, code }) {
  const base = import.meta.env.VITE_PUBLIC_URL || location.origin
  const link = code ? `${base}/?ref=${code}` : ''
  const share = async () => {
    if (!link) return
    try { if (navigator.share) await navigator.share({ title: 'Meu bolso', text: 'Organize seu dinheiro com o Meu bolso', url: link }); else { await navigator.clipboard.writeText(link); say('Link copiado') } } catch {}
  }
  return (
    <div className="grid">
      <section className="hero-card">
        <h2>Indique um amigo</h2>
        <p className="muted">Quando um amigo criar a conta com seu código, você libera o relatório personalizado.</p>
        {code ? <p className="code">{code}</p> : <p className="muted">Gerando seu código…</p>}
        <button className="cta" onClick={share} disabled={!code}>Compartilhar meu link</button>
      </section>
      <section>
        <h2>Suas indicações</h2>
        <p className="big">{s.refs}</p>
        <p className="muted">{s.refs >= 1 ? 'Relatório personalizado liberado.' : 'Falta 1 amigo para liberar o relatório personalizado.'}</p>
      </section>
    </div>
  )
}

export function Dicas({ s, P }) {
  const tight = s.salary > 0 && P.livreVar < 0
  const L = [...s.cfg.tips].sort((a, b) => (tight ? b.tight - a.tight : 0))
  return (
    <section className="wide">
      <h2>Dicas para o dinheiro render</h2>
      {tight && <p className="warn">Seu plano está apertado. Comece pelas primeiras dicas.</p>}
      <ul className="tips">{L.map(t => <li key={t.id} className={tight && t.tight ? 'hl' : ''}><b>{t.title}</b><span>{t.text}</span></li>)}</ul>
    </section>
  )
}