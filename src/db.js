// Camada de dados do Meu bolso.
// O banco (Supabase) é a fonte da verdade:
//  - ao entrar, o app lê tudo das tabelas;
//  - cada ação grava na tabela e SÓ DEPOIS a tela muda;
//  - se a gravação falhar, a tela não muda e a pessoa vê o erro.
// Nada é guardado no aparelho (localStorage).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sb } from './cloud'
import { isNative } from './nativeAuth.js'

const num = n => (Number.isFinite(Number(n)) ? Number(n) : 0)
const money = n => Math.round(num(n) * 100) / 100
const okDate = d => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null)
const intOrNull = n => { const v = Math.round(Number(n)); return Number.isFinite(v) && v > 0 ? v : null }
const clamp = (n, a, b) => Math.min(b, Math.max(a, n))
const stamp = () => new Date().toISOString()
const iso = d => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null)
const isoNow = () => iso(new Date())
let lastId = 0
const newId = () => (lastId = Math.max(Date.now(), lastId + 1))

export const EMPTY = {
  salary: 0, payDay: 5, fixed: [], varEss: 0, reservePct: 10,
  goals: [], deposits: [], spends: [], variable: false, earns: [],
  refs: 0, hue: 172, mode: 'dark', hide: false, notifDay: '',
}

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
  notif_day: okDate(s.notifDay) || null,
})
const fromSettings = d => ({
  salary: Number(d.salary), payDay: d.pay_day, varEss: Number(d.var_ess), reservePct: d.reserve_pct,
  variable: !!d.variable, hue: d.hue, mode: d.mode, hide: !!d.hide, notifDay: d.notif_day || '',
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

const countRefs = async () => {
  try {
    const { count, error } = await sb.from('bolso_referrals').select('id', { count: 'exact', head: true })
    return error || count == null ? 0 : count
  } catch { return 0 }
}

// Lê tudo do banco. Quem ainda não tem linha em bolso_settings começa com o estado em branco.
export const bootstrap = async uid => {
  const st = await db(sb.from('bolso_settings').select('*').eq('user_id', uid).maybeSingle(), 'bolso_settings')
  const lists = await Promise.all(NAMES.map(n => fetchAll(COLL[n].table, uid)))
  const data = { ...EMPTY, ...(st ? fromSettings(st) : {}) }
  NAMES.forEach((n, i) => {
    const rows = lists[i].map(COLL[n].from)
    data[n] = COLL[n].newestFirst ? rows.reverse() : rows
  })
  data.refs = await countRefs()
  return data
}

// ---------- Ações: cada uma grava na tabela e só depois muda a tela ----------
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
    // salário, dia de receber, essenciais, reserva, renda variável, cor, tema, ocultar valores, aviso do dia
    saveSettings: guard(async patch => {
      const next = { ...get(), ...patch }
      const d = await db(sb.from('bolso_settings').upsert({ user_id: me(), ...settingsRow(next), updated_at: stamp() }, { onConflict: 'user_id' }).select().single(), 'bolso_settings')
      set(v => ({ ...v, ...fromSettings(d) }))
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

// ---------- Resumo para os avisos programados (só no iPhone) ----------
// Vai para a tabela bolso_push_state; a Edge Function bolso-scheduled-push lê de lá.
const buildSnapshot = (s, P) => {
  const dates = (s.spends || []).map(x => okDate(x?.date)).filter(Boolean).sort()
  return {
    v: 1,
    cycleStart: iso(P.start),
    cycleEnd: iso(P.end),
    lastSpend: dates.length ? dates[dates.length - 1] : null,
    bills: (s.fixed || [])
      .filter(f => f && Number(f.day) >= 1 && Number(f.day) <= 31)
      .map(f => ({ id: String(f.id), name: String(f.name || 'Conta'), value: num(f.value), day: Number(f.day) })),
    goals: (P.goals || [])
      .filter(g => g && num(g.target) > 0)
      .map(g => ({ id: String(g.id), name: String(g.name || 'Objetivo'), target: num(g.target), saved: num(g.saved) })),
    budget: {
      essencial: { used: num(P.spent('essencial')), limit: num(s.varEss) },
      livre: { used: num(P.spent('livre')), limit: num(P.livreVar) },
    },
  }
}

export function usePushState(uid, ready, s, P) {
  const last = useRef('')
  useEffect(() => { last.current = '' }, [uid])
  useEffect(() => {
    if (!uid || !ready || !isNative || !P) return
    const t = setTimeout(async () => {
      try {
        const snapshot = buildSnapshot(s, P)
        const key = JSON.stringify(snapshot)
        if (key === last.current) return
        await db(sb.from('bolso_push_state').upsert({ user_id: uid, snapshot, updated_at: stamp() }, { onConflict: 'user_id' }), 'bolso_push_state')
        last.current = key
      } catch (e) { console.warn('push_state:', e?.message) }
    }, 2500)
    return () => clearTimeout(t)
  }, [s, P, uid, ready])
}

// ---------- Hook usado pelo App ----------
// Devolve { s, phase, err, act, reload }. phase: loading | ready | error
export function useStore(uid, enabled, onError) {
  const [s, setS] = useState(EMPTY)
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
      setS(EMPTY) // saiu: não deixa dados de uma pessoa na tela da outra
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