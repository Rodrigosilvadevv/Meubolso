import { useEffect, useMemo, useRef, useState } from 'react'
import './ImportOfx.css'
import parseOfxFile from './parseOfxFile'
import { CATEGORIES, CAT_BY_ID, PILLARS, categorizeTransaction, merchantKey, normalizeText } from './categorize'
import { loadMerchantRules, saveMerchantRules, deleteMerchantRule, findImported } from './db'
import { isNative } from './nativeAuth.js'

const ORDER = ['essential', 'unforeseen', 'free']
const dmy = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`
const sum = (list, f) => list.reduce((a, x) => a + f(x), 0)

// Cartão da aba Gastos: botão para quem é Premium Plus, aviso de plano para os demais.
export function ImportCard({ canImport, go, ...rest }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="wide">
      <h2>Importar extrato (.OFX)</h2>
      {canImport ? (
        <>
          <p className="muted">Envie o arquivo OFX do seu banco. O app sugere a categoria de cada gasto e você confere tudo antes de salvar.</p>
          <button className="cta" onClick={() => setOpen(true)}>Importar arquivo .OFX</button>
        </>
      ) : (
        <div className="locked">
          <p className="muted">A importação de extrato bancário faz parte do Premium Plus.</p>
          <button className="cta" onClick={() => go('conta')}>Ver planos</button>
        </div>
      )}
      {open && canImport && <ImportOfx {...rest} onClose={() => setOpen(false)} />}
    </section>
  )
}

function ImportOfx({ uid, m, act, say, onClose }) {
  const [rules, setRules] = useState([])
  const [rulesErr, setRulesErr] = useState('')
  const [stage, setStage] = useState('pick') // pick | preview
  const [rows, setRows] = useState([])
  const [fileName, setFileName] = useState('')
  const [sel, setSel] = useState({})       // k -> entra na importação?
  const [pick, setPick] = useState({})     // k -> categoria escolhida pela pessoa (mudou à mão)
  const [ruleOn, setRuleOn] = useState({}) // k -> { on, kw } salvar regra?
  const [onlyOthers, setOnlyOthers] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const fileRef = useRef(null)

  useEffect(() => {
    let dead = false
    loadMerchantRules(uid).then(r => { if (!dead) setRules(r || []) }).catch(e => { if (!dead) setRulesErr(e.message) })
    return () => { dead = true }
  }, [uid])

  // Regras novas marcadas nesta tela: já valem para as outras linhas do mesmo estabelecimento
  const pending = useMemo(() => Object.entries(ruleOn)
    .filter(([k, v]) => v.on && pick[k] && normalizeText(v.kw))
    .map(([k, v]) => ({ k, keyword: normalizeText(v.kw), category_id: pick[k], pillar: CAT_BY_ID[pick[k]]?.pillar })), [ruleOn, pick])

  const view = useMemo(() => rows.map(r => {
    const others = [...pending.filter(p => p.k !== r.k), ...rules]
    const auto = categorizeTransaction(r.description, others, r.type)
    const cat = CAT_BY_ID[pick[r.k]] || CAT_BY_ID[auto.category_id]
    return { ...r, auto, cat, manual: !!pick[r.k] }
  }), [rows, rules, pending, pick])

  const onFile = async e => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setErr('')
    setBusy('read')
    try {
      const list = await parseOfxFile(f)
      const have = await findImported(uid, list.map(x => x.fitid))
      const rs = list.map((x, i) => ({ ...x, k: String(i), dup: have.has(x.fitid) }))
      // Conta fixa (moradia) já costuma estar em Gastos fixos no Plano: começa desmarcada para não contar duas vezes.
      const first = {}
      rs.forEach(r => {
        const a = categorizeTransaction(r.description, rules, r.type)
        r.fixedHint = a.category_id === 'housing'
        first[r.k] = !r.dup && r.type === 'DEBIT' && !r.fixedHint
      })
      setRows(rs); setSel(first); setPick({}); setRuleOn({}); setFileName(f.name); setStage('preview')
    } catch (ex) {
      setErr(/column|fitid|does not exist|schema/i.test(ex.message)
        ? 'O banco ainda não está pronto para importação. Rode o SQL importacao_ofx.sql no Supabase e tente de novo.'
        : ex.message || 'Não consegui ler este arquivo.')
    }
    setBusy('')
  }

  const change = (r, id) => setPick(p => {
    const n = { ...p }
    if (id === r.auto.category_id) delete n[r.k]; else n[r.k] = id
    return n
  })
  const rule = r => ruleOn[r.k] || { on: false, kw: merchantKey(r.description) }
  const setRule = (r, patch) => setRuleOn(o => ({ ...o, [r.k]: { ...rule(r), ...patch } }))

  const shown = onlyOthers ? view.filter(r => r.type === 'DEBIT' && r.cat.id.startsWith('others')) : view
  const chosen = view.filter(r => sel[r.k])
  const outTotal = sum(chosen.filter(r => r.type === 'DEBIT'), r => -r.amount)
  const inTotal = sum(chosen.filter(r => r.type === 'CREDIT'), r => r.amount)
  const dups = rows.filter(r => r.dup).length
  const allOn = shown.length > 0 && shown.every(r => sel[r.k])
  const toggleAll = () => setSel(o => { const n = { ...o }; shown.forEach(r => { n[r.k] = !allOn }); return n })

  const save = async () => {
    if (!chosen.length || busy) return
    setBusy('save'); setErr('')
    const spends = [], earns = []
    for (const r of chosen) {
      const base = { desc: r.description, date: r.date, fitid: r.fitid, raw: r.raw }
      if (r.type === 'CREDIT') earns.push({ ...base, value: r.amount, category: 'income' })
      else spends.push({ ...base, value: Math.abs(r.amount), category: r.cat.id, bucket: PILLARS[r.cat.pillar]?.bucket || 'livre' })
    }
    const res = await act.importOfx({ spends, earns }) // se falhar, o app já mostra o erro e nada muda na tela
    if (!res) { setBusy(''); setErr('Não foi possível salvar. Nada foi importado, pode tentar de novo.'); return }
    let note = ''
    if (pending.length) {
      try { await saveMerchantRules(uid, pending) } catch { note = ' (as regras não foram salvas)' }
    }
    const added = res.spends + res.earns
    const skipped = chosen.length - added
    say(`${added} ${added === 1 ? 'transação importada' : 'transações importadas'}${skipped > 0 ? `, ${skipped} já existiam` : ''}${note}`, 5000)
    onClose()
  }

  const removeRule = async id => {
    try { await deleteMerchantRule(uid, id); setRules(l => l.filter(x => x.id !== id)) }
    catch (ex) { setErr(ex.message) }
  }

  const rulesBox = rules.length > 0 && (
    <details className="ox-rules">
      <summary>Minhas regras ({rules.length})</summary>
      <ul>
        {rules.map(r => (
          <li key={r.id}>
            <span><strong>{r.keyword}</strong> → {CAT_BY_ID[r.category_id]?.label || r.category_id}</span>
            <button className="x" aria-label={`Apagar regra ${r.keyword}`} onClick={() => removeRule(r.id)}>×</button>
          </li>
        ))}
      </ul>
    </details>
  )

  return (
    <div className="ox-back" role="dialog" aria-modal="true" aria-label="Importar extrato OFX">
      <div className="ox">
        <div className="ox-head">
          <h2>{stage === 'pick' ? 'Importar extrato' : 'Confira antes de salvar'}</h2>
          <button className="x" aria-label="Fechar" disabled={busy === 'save'} onClick={onClose}>×</button>
        </div>

        <div className="ox-body">
          {stage === 'pick' && (
            <>
              <p className="muted">No app ou site do seu banco, baixe o extrato em formato <strong>OFX</strong> e escolha o arquivo aqui. Nada é enviado antes de você confirmar.</p>
              <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} {...(isNative ? {} : { accept: '.ofx,.OFX,.qfx,.txt' })} />
              <button className="cta" disabled={!!busy} onClick={() => fileRef.current?.click()}>{busy === 'read' ? 'Lendo arquivo…' : 'Escolher arquivo .OFX'}</button>
              {rulesErr && <p className="err">Não consegui carregar suas regras: {rulesErr}</p>}
              {rulesBox}
            </>
          )}

          {stage === 'preview' && (
            <>
              <p className="muted">{fileName} · {rows.length} transações{dups > 0 ? ` · ${dups} já importadas antes` : ''}</p>
              <div className="ox-bar">
                <label className="chk"><input type="checkbox" checked={allOn} onChange={toggleAll} />Marcar todas</label>
                <label className="chk"><input type="checkbox" checked={onlyOthers} onChange={e => setOnlyOthers(e.target.checked)} />Só "Outros"</label>
              </div>
              <ul className="ox-list">
                {shown.map(r => (
                  <li key={r.k} className={`ox-row${sel[r.k] ? '' : ' off'}`}>
                    <input type="checkbox" aria-label="Importar esta transação" checked={!!sel[r.k]} onChange={e => setSel(o => ({ ...o, [r.k]: e.target.checked }))} />
                    <span className="ox-date">{dmy(r.date)}</span>
                    <span className="ox-desc">{r.description}
                      {r.dup && <small>Já importada antes</small>}
                      {!r.dup && r.fixedHint && <small>Conta fixa: normalmente já está em Gastos fixos no Plano</small>}
                      {!r.dup && !r.fixedHint && r.cat.id.startsWith('others') && !r.manual && <small>Sem categoria conhecida</small>}
                    </span>
                    <em className={r.type === 'CREDIT' ? 'good' : ''}>{r.type === 'CREDIT' ? '+' : '−'} {m(Math.abs(r.amount))}</em>
                    <select value={r.cat.id} disabled={r.type === 'CREDIT'} aria-label={`Categoria de ${r.description}`} onChange={e => change(r, e.target.value)}>
                      {r.type === 'CREDIT'
                        ? <option value="income">Receitas · {CAT_BY_ID.income.label}</option>
                        : ORDER.map(p => (
                          <optgroup key={p} label={PILLARS[p].label}>
                            {CATEGORIES.filter(c => c.pillar === p).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                          </optgroup>
                        ))}
                    </select>
                    {r.manual && r.type === 'DEBIT' && (
                      <div className="ox-rule">
                        <input type="checkbox" aria-label="Salvar regra" checked={rule(r).on} onChange={e => setRule(r, { on: e.target.checked })} />
                        <span>Salvar regra para futuros arquivos de</span>
                        <input className="ox-kw" value={rule(r).kw} aria-label="Nome do estabelecimento" onChange={e => setRule(r, { kw: e.target.value })} />
                        <span>?</span>
                      </div>
                    )}
                  </li>
                ))}
                {shown.length === 0 && <li className="muted">Nenhuma transação para mostrar.</li>}
              </ul>
              {rulesBox}
            </>
          )}
          {err && <p className="err" role="alert">{err}</p>}
        </div>

        {stage === 'preview' && (
          <div className="ox-foot">
            <p className="muted">{chosen.length} selecionadas · gastos {m(outTotal)}{inTotal > 0 ? ` · entradas ${m(inTotal)}` : ''}</p>
            <div>
              <button className="ghost" disabled={busy === 'save'} onClick={() => { setStage('pick'); setRows([]); setErr('') }}>Trocar arquivo</button>
              <button className="cta" disabled={!chosen.length || busy === 'save'} onClick={save}>{busy === 'save' ? 'Salvando…' : `Salvar ${chosen.length} ${chosen.length === 1 ? 'transação' : 'transações'}`}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}