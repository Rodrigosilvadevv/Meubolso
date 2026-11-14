// Camada de dados do Meu bolso.
// O banco (Supabase) é a fonte da verdade:
//  - ao entrar, o app lê tudo das tabelas;
//  - cada ação (registrar gasto, salvar objetivo...) grava na tabela e SÓ DEPOIS a tela muda;
//  - se a gravação falhar, a tela não muda e a pessoa vê o erro.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sb } from './cloud'

const num = n => (Number.isFinite(Number(n)) ? Number(n) : 0)
const money = n => Math.round(num(n) * 100) / 100
const okDate = d => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null)
const intOrNull = n => { const v = Math.round(Number(n)); return Number.isFinite(v) && v > 0 ? v : null }
const clamp = (n, a, b) => Math.min(b, Math.max(a, n))
const stamp = () => new Date().toISOString()
const isoNow = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
let lastId = 0
const newId = () => (lastId = Math.max(Date.now(), lastId + 1))

export const EMPTY = {
  salary: 0, payDay: 5, fixed: [], varEss: 0, reservePct: 10,
  goals: [], deposits: [], spends: [], variable: false, earns: [],
  refs: 0, hue: 172, mode: 'dark', hide: false,
}

const lsGet = k => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k) } catch {} }

// Só a aparência (cor e tema) fica no aparelho, para a primeira tela não piscar. Não são dados da pessoa.
const readLook = () => {
  try {
    const l = JSON.parse(lsGet('bolso:look') || 'null')
    return l && typeof l === 'object' ? { hue: num(l.hue ?? 172), mode: l.mode === 'light' ? 'light' : 'dark' } : {}
  } catch { return {} }
}
const writeLook = s => lsSet('bolso:look', JSON.stringify({ hue: s.hue, mode: s.mode }))

// ---------- Tabelas: app <-> banco ----------
const COLL = {
  fixed: {
    table: 'bolso_fixed',
    to: r => ({ name: String(r.name ?? ''), value: money(r.value), level: r.level === 'livre' ? 'livre' : 'essencial', day: intOrNull(r.day) }),
    from: d => ({ id: Number(d.id), name: d.name, value: Number(d.value), level: d.level, day: d.day || 0 }),
  },
  goals: {
    table: 'bolso_goals',
    to: r => ({ name: String(r.name ?? ''), target: money(r.target), saved: money(r.saved), date: okDate(r.date), delays: Math.max(0, Math.round(num(r.delays))) }),
    from: d => ({ id: Number(d.id), name: d.name, target: Number(d.target), saved: Number(d.saved), date: d.date || '', delays: d.delays || 0 }),
  },
  deposits: {
    table: 'bolso_deposits',
    to: r => ({ goal_id: r.goalId != null && Number.isFinite(Number(r.goalId)) ? Number(r.goalId) : null, value: money(r.value), date: okDate(r.date) || isoNow() }),
    from: d => ({ id: Number(d.id), goalId: d.goal_id == null ? null : Number(d.goal_id), value: Number(d.value), date: d.date }),
  },
  spends: {
    table: 'bolso_spends', newestFirst: true,
    to: r => ({ descr: String(r.desc ?? ''), value: money(r.value), bucket: String(r.bucket || 'essencial'), date: okDate(r.date) || isoNow() }),
    from: d => ({ id: Number(d.id), desc: d.descr, value: Number(d.value), bucket: d.bucket, date: d.date }),
  },
  earns: {
    table: 'bolso_earns', newestFirst: true,
    to: r => ({ descr: String(r.desc ?? ''), value: money(r.value), date: okDate(r.date) || isoNow() }),
    from: d => ({ id: Number(d.id), desc: d.descr, value: Number(d.value), date: d.date }),
  },
}
const NAMES = Object.keys(COLL)

const settingsRow = s => ({
  salary: money(s.salary),
  pay_day: clamp(Math.round(num(s.payDay)) || 5, 1, 31),
  var_ess: money(s.varEss),
  reserve_pct: clamp(Math.round(num(s.reservePct)), 0, 100),
  variable: !!s.variable,
  hue: clamp(Math.round(num(s.hue ?? 172)), 0, 360),
  mode: s.mode === 'light' ? 'light' : 'dark',
  hide: !!s.hide,
})
const fromSettings = d => ({
  salary: Number(d.salary), payDay: d.pay_day, varEss: Number(d.var_ess), reservePct: d.reserve_pct,
  variable: !!d.variable, hue: d.hue, mode: d.mode, hide: !!d.hide,
})

// Toda chamada ao banco passa por aqui: se der erro, vira exceção com o nome da tabela.
const db = async (query, label) => {
  const { data, error } = await query
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

// ---------- Leitura ----------
const fetchAll = async (table, uid) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    const data = await db(sb.from(table).select('*').eq('user_id', uid).order('id').range(from, from + 999), table)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

const loadAll = async uid => {
  const st = await db(sb.from('bolso_settings').select('*').eq('user_id', uid).maybeSingle(), 'bolso_settings')
  const lists = await Promise.all(NAMES.map(n => fetchAll(COLL[n].table, uid)))
  const data = { ...EMPTY, ...readLook(), ...(st ? fromSettings(st) : {}) }
  NAMES.forEach((n, i) => {
    const rows = lists[i].map(COLL[n].from)
    data[n] = COLL[n].newestFirst ? rows.reverse() : rows
  })
  return { data, exists: !!st }
}

const countRefs = async () => {
  try {
    const { count, error } = await sb.from('bolso_referrals').select('id', { count: 'exact', head: true })
    return error || count == null ? 0 : count
  } catch { return 0 }
}

// ---------- Dados antigos que só existiam neste aparelho (versão anterior do app) ----------
// Sobem uma única vez para o banco. Se o banco já tem dados da pessoa, o banco vale.
const LEGACY = 'bolso:v1'
const readLegacy = uid => {
  const owner = lsGet('bolso:owner')
  if (owner && owner !== uid) return null
  if (lsGet('bolso:imported:' + uid)) return null
  let raw
  try { raw = JSON.parse(lsGet(LEGACY) || 'null') } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const list = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [])
  const goals = list(raw.goals).length ? raw.goals : raw.goal && raw.goal.target > 0 ? [{ id: 1, delays: 0, ...raw.goal }] : []
  const d = {
    ...EMPTY,
    salary: num(raw.salary), payDay: raw.payDay || 5, varEss: num(raw.varEss), reservePct: raw.reservePct ?? 10,
    variable: !!raw.variable, hue: raw.hue ?? 172, mode: raw.mode, hide: !!raw.hide,
    fixed: list(raw.fixed), goals: list(goals), deposits: list(raw.deposits), spends: list(raw.spends), earns: list(raw.earns),
  }
  return d.salary > 0 || NAMES.some(n => d[n].length) ? d : null
}

const importLegacy = async (uid, d) => {
  for (const n of NAMES) {
    const c = COLL[n]
    const rows = d[n].map((r, i) => ({
      user_id: uid, id: Number.isFinite(Number(r.id)) ? Number(r.id) : Date.now() + i, ...c.to(r), updated_at: stamp(),
    }))
    for (let i = 0; i < rows.length; i += 400) {
      await db(sb.from(c.table).upsert(rows.slice(i, i + 400), { onConflict: 'user_id,id' }), c.table)
    }
  }
  await db(sb.from('bolso_settings').upsert({ user_id: uid, ...settingsRow(d), updated_at: stamp() }, { onConflict: 'user_id' }), 'bolso_settings')
}

// Lê tudo do banco (importando os dados antigos do aparelho, se for o caso).
export const bootstrap = async uid => {
  let r = await loadAll(uid)
  const legacy = readLegacy(uid)
  if (legacy) {
    if (!r.exists || lsGet('bolso:dirty') === '1') {
      await importLegacy(uid, legacy)
      r = await loadAll(uid)
    }
    lsSet('bolso:imported:' + uid, '1')
    lsSet('bolso:dirty', '')
  }
  lsSet('bolso:owner', uid)
  r.data.refs = await countRefs()
  return r.data
}

// ---------- Ações: cada uma grava na tabela e só depois muda a tela ----------
// get() devolve o estado atual, set() é o setState, uid() a pessoa logada, fail(e) mostra o erro.
// Todas devolvem true (salvou) ou false (não salvou).
export const makeActions = ({ get, set, uid, fail }) => {
  const me = () => { const id = uid(); if (!id) throw new Error('sem sessão'); return id }
  const list = (name, fn) => set(v => ({ ...v, [name]: fn(v[name]) }))
  const guard = fn => async (...a) => {
    try { await fn(...a); return true } catch (e) { console.warn('save:', e?.message); fail(e); return false }
  }

  const insert = async (name, item) => {
    const c = COLL[name]
    const d = await db(sb.from(c.table).insert({ user_id: me(), id: newId(), ...c.to(item), updated_at: stamp() }).select().single(), c.table)
    const row = c.from(d)
    list(name, l => (c.newestFirst ? [row, ...l] : [...l, row]))
  }
  const remove = async (name, id) => {
    const c = COLL[name]
    await db(sb.from(c.table).delete().eq('user_id', me()).eq('id', id), c.table)
    list(name, l => l.filter(x => x.id !== id))
  }

  return {
    // salário, dia de receber, essenciais, reserva, renda variável, cor, tema, ocultar valores
    saveSettings: guard(async patch => {
      const next = { ...get(), ...patch }
      const d = await db(sb.from('bolso_settings').upsert({ user_id: me(), ...settingsRow(next), updated_at: stamp() }, { onConflict: 'user_id' }).select().single(), 'bolso_settings')
      const st = fromSettings(d)
      set(v => ({ ...v, ...st }))
      writeLook(st)
    }),
    addFixed: guard(item => insert('fixed', item)),
    removeFixed: guard(id => remove('fixed', id)),
    addSpend: guard(item => insert('spends', item)),
    removeSpend: guard(id => remove('spends', id)),
    addEarn: guard(item => insert('earns', item)),
    removeEarn: guard(id => remove('earns', id)),

    // cria (id vazio) ou atualiza um objetivo
    saveGoal: guard(async g => {
      const c = COLL.goals
      const d = await db(sb.from(c.table).upsert({ user_id: me(), id: Number(g.id) || newId(), ...c.to(g), updated_at: stamp() }, { onConflict: 'user_id,id' }).select().single(), c.table)
      const row = c.from(d)
      list('goals', l => (l.some(x => x.id === row.id) ? l.map(x => (x.id === row.id ? row : x)) : [...l, row]))
    }),
    removeGoal: guard(async id => {
      const uidNow = me()
      await db(sb.from('bolso_goals').delete().eq('user_id', uidNow).eq('id', id), 'bolso_goals')
      await db(sb.from('bolso_deposits').delete().eq('user_id', uidNow).eq('goal_id', id), 'bolso_deposits')
      set(v => ({ ...v, goals: v.goals.filter(x => x.id !== id), deposits: v.deposits.filter(x => x.goalId !== id) }))
    }),
    // grava o depósito e soma no objetivo; se a segunda parte falhar, desfaz a primeira
    deposit: guard(async (goalId, value) => {
      const uidNow = me()
      const g = get().goals.find(x => x.id === goalId)
      if (!g) throw new Error('objetivo não encontrado')
      const dc = COLL.deposits, gc = COLL.goals
      const dep = await db(sb.from(dc.table).insert({ user_id: uidNow, id: newId(), ...dc.to({ goalId, value, date: isoNow() }), updated_at: stamp() }).select().single(), dc.table)
      try {
        const gd = await db(sb.from(gc.table).update({ saved: money(g.saved + value), updated_at: stamp() }).eq('user_id', uidNow).eq('id', goalId).select().single(), gc.table)
        set(v => ({ ...v, deposits: [...v.deposits, dc.from(dep)], goals: v.goals.map(x => (x.id === goalId ? gc.from(gd) : x)) }))
      } catch (e) {
        try { await sb.from(dc.table).delete().eq('user_id', uidNow).eq('id', dep.id) } catch {}
        throw e
      }
    }),
  }
}

// ---------- Hook usado pelo App ----------
// Devolve { s, phase, err, act, reload }. phase: loading | ready | error
export function useStore(uid, enabled, onError) {
  const [s, setS] = useState(() => ({ ...EMPTY, ...readLook() }))
  const [phase, setPhase] = useState('loading')
  const [err, setErr] = useState('')
  const sRef = useRef(s)
  const uidRef = useRef(uid)
  const errRef = useRef(onError)
  const req = useRef(0)
  sRef.current = s
  uidRef.current = uid
  errRef.current = onError

  const load = useCallback(async () => {
    if (!uid) return
    const mine = ++req.current
    setPhase('loading')
    setErr('')
    try {
      const data = await bootstrap(uid)
      if (req.current !== mine || uidRef.current !== uid) return
      writeLook(data)
      setS(data)
      setPhase('ready')
    } catch (e) {
      console.warn('load:', e?.message)
      if (req.current !== mine) return
      setErr(e?.message || String(e))
      setPhase('error')
    }
  }, [uid])

  useEffect(() => {
    if (!enabled || !uid) {
      req.current++
      setPhase('loading')
      setS(v => ({ ...EMPTY, hue: v.hue, mode: v.mode })) // saiu: não deixa dados de uma pessoa na tela da outra
      return
    }
    load()
  }, [enabled, uid, load])

  // Quantas pessoas a pessoa indicou (libera o relatório personalizado): atualiza ao voltar para o app
  useEffect(() => {
    if (phase !== 'ready') return
    const vis = () => {
      if (document.visibilityState === 'visible') countRefs().then(n => setS(v => (v.refs === n ? v : { ...v, refs: n })))
    }
    document.addEventListener('visibilitychange', vis)
    return () => document.removeEventListener('visibilitychange', vis)
  }, [phase])

  const act = useMemo(
    () => makeActions({ get: () => sRef.current, set: setS, uid: () => uidRef.current, fail: e => errRef.current?.(e) }),
    [],
  )

  return { s, phase, err, act, reload: load }
}