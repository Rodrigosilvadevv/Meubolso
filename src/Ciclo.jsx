import './Ciclo.css'

const pad = n => String(n).padStart(2, '0')
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const at = (y, m, d) => new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()))
// Vencimento de um gasto fixo dentro do ciclo atual
const dueDate = (day, start) => {
  const a = at(start.getFullYear(), start.getMonth(), day)
  return a >= start ? a : at(start.getFullYear(), start.getMonth() + 1, day)
}
const COLORS = { essencial: 'var(--ess)', imprevisto: 'var(--imp)', objetivo: 'var(--obj)', livre: 'var(--liv)' }

// Gasto fixo com dia de vencimento já vencido = "já saiu". Sem dia, ou ainda por vencer = "previsto".
export function cycleBars(s, P) {
  const fixed = level => s.fixed.filter(f => f.level === level).reduce((a, f) => {
    const paid = f.day && dueDate(f.day, P.start) <= P.today
    return { paid: a.paid + (paid ? f.value : 0), next: a.next + (paid ? 0 : f.value) }
  }, { paid: 0, next: 0 })
  const dep = (s.deposits || []).filter(x => x.date >= iso(P.start) && x.date < iso(P.end)).reduce((a, x) => a + x.value, 0)
  const e = fixed('essencial'), l = fixed('livre'), g = P.split.objetivo
  return [
    { k: 'essencial', label: 'Essencial', hint: 'contas fixas, mercado, transporte', total: P.split.essencial, used: e.paid + P.spent('essencial'), soon: e.next },
    { k: 'imprevisto', label: 'Imprevistos', hint: 'reserva para o inesperado', total: P.split.imprevisto, used: P.spent('imprevisto'), soon: 0 },
    { k: 'objetivo', label: 'Objetivo', hint: 'o que guardar neste ciclo', total: g, used: dep, soon: Math.max(0, g - dep) },
    { k: 'livre', label: 'Livre', hint: 'lazer e assinaturas', total: P.split.livre, used: l.paid + P.spent('livre'), soon: l.next },
  ]
}

export function Ciclo({ s, P, m }) {
  const bars = cycleBars(s, P).filter(b => b.total > 0 || b.used > 0)
  return (
    <section className="wide cy">
      <h2>Seu ciclo, barra a barra</h2>
      <p className="muted">Até {P.end.toLocaleDateString('pt-BR')} · faltam {P.daysLeft} {P.daysLeft === 1 ? 'dia' : 'dias'}</p>
      <ul className="cy-leg">
        <li><i className="u" />Já saiu</li>
        <li><i className="p" />Previsto</li>
        <li><i className="f" />Sobra</li>
      </ul>
      {bars.length === 0 && <p className="muted">Preencha o Plano (salário e gastos fixos) para ver as barras.</p>}
      {bars.map(b => {
        const goal = b.k === 'objetivo'
        const left = b.total - b.used - b.soon
        const over = !goal && left < -0.005
        const base = Math.max(b.total, b.used + b.soon, 1)
        const w = v => `${Math.min(100, (v / base) * 100)}%`
        return (
          <div key={b.k} className={`cy-row${over ? ' over' : ''}`}>
            <div className="cy-head">
              <span><b style={{ background: COLORS[b.k] }} />{b.label}<small>{b.hint}</small></span>
              <em className={over ? 'neg' : ''}>{goal ? `${m(b.used)} de ${m(b.total)}` : over ? `passou ${m(-left)}` : `sobram ${m(left)}`}</em>
            </div>
            <div className="cy-track">
              <i className="cy-u" style={{ width: w(b.used), background: over ? 'var(--neg)' : COLORS[b.k] }} />
              <i className="cy-p" style={{ width: w(b.soon), '--c': COLORS[b.k] }} />
            </div>
            <p className="cy-sub">
              {goal ? `Guardado ${m(b.used)} · falta guardar ${m(b.soon)}` : `Já saiu ${m(b.used)} · previsto ${m(b.soon)} · reservado ${m(b.total)}`}
            </p>
          </div>
        )
      })}
    </section>
  )
}