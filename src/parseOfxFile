// Leitor de extrato .OFX (SGML da maioria dos bancos brasileiros e XML).
// parseOfxFile(file) -> [{ date, amount, description, type, fitid, raw }]
//   date        'AAAA-MM-DD'
//   amount      número com sinal (gasto negativo, entrada positiva)
//   description texto limpo de NAME/MEMO
//   type        'DEBIT' | 'CREDIT' (decidido pelo sinal do valor)
//   fitid       identificador único da transação (evita importar duas vezes)
//   raw         dados originais, para auditoria (vai para raw_ofx_data)

const MAX_BYTES = 5 * 1024 * 1024
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const unescapeXml = s =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    }
    return ENT[e.toLowerCase()] ?? all
  })

const clean = s => unescapeXml(String(s ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()

// Valor da primeira ocorrência de <TAG> no bloco (funciona com e sem </TAG>)
const tag = (block, name) => {
  const m = new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i').exec(block)
  return m ? m[1].trim() : ''
}

// Aceita "-25.90", "-25,90", "1.234,56", "R$ 10,00"
export const parseAmount = raw => {
  let s = String(raw ?? '').replace(/[^\d.,+-]/g, '')
  if (!/\d/.test(s)) return NaN
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.')
  if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  else if (lc > -1) s = s.replace(',', '.')
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '')
  const n = parseFloat(s)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN
}

// "20240105120000[-3:BRT]" -> "2024-01-05" (usa só o dia que o banco informou, sem mexer em fuso)
export const parseOfxDate = raw => {
  const m = /(\d{4})(\d{2})(\d{2})/.exec(String(raw ?? ''))
  if (!m) return null
  const [, y, mo, d] = m
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null
  return `${y}-${mo}-${d}`
}

// Bancos antigos salvam em Windows-1252; os novos em UTF-8. Tenta UTF-8 e cai para 1252.
const decode = buf => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { /* não é UTF-8 */ }
  return new TextDecoder('windows-1252').decode(buf)
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase()

export function parseOfxText(text) {
  if (!/<OFX>|OFXHEADER/i.test(text)) throw new Error('Este arquivo não parece ser um extrato OFX.')

  const stmts = [...text.matchAll(/<(STMTRS|CCSTMTRS)>([\s\S]*?)<\/\1>/gi)].map(m => m[2])
  const parts = stmts.length ? stmts : [text]

  const out = []
  for (const part of parts) {
    const acct = clean(tag(part, 'ACCTID'))
    const blocks = [...part.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|$)/gi)].map(m => m[1])
    for (const b of blocks) {
      const date = parseOfxDate(tag(b, 'DTPOSTED') || tag(b, 'DTUSER') || tag(b, 'TRNDATE'))
      const amount = parseAmount(tag(b, 'TRNAMT'))
      if (!date || !Number.isFinite(amount) || amount === 0) continue

      const name = clean(tag(b, 'NAME')), memo = clean(tag(b, 'MEMO'))
      let description = memo || name
      if (name && memo && !same(name, memo)) {
        if (same(memo, name) || memo.toLowerCase().includes(name.toLowerCase())) description = memo
        else if (name.toLowerCase().includes(memo.toLowerCase())) description = name
        else description = `${name} - ${memo}`
      }

      out.push({
        date,
        amount,
        description: description || 'Sem descrição',
        type: amount < 0 ? 'DEBIT' : 'CREDIT',
        fitid: '',
        raw: { trntype: clean(tag(b, 'TRNTYPE')), fitid: clean(tag(b, 'FITID')), name, memo, acct, dtposted: tag(b, 'DTPOSTED') },
      })
    }
  }
  if (!out.length) throw new Error('Não encontrei nenhuma transação neste arquivo.')

  // Identificador único: "conta:FITID". Se o banco repete o mesmo FITID no arquivo (ou não manda),
  // usa data|valor|texto|n (n = 1ª, 2ª... ocorrência igual), que continua estável em arquivos que se sobrepõem.
  const count = {}
  out.forEach(r => { if (r.raw.fitid) { const k = `${r.raw.acct}:${r.raw.fitid}`; count[k] = (count[k] || 0) + 1 } })
  const seen = {}
  out.forEach(r => {
    const k = `${r.raw.acct}:${r.raw.fitid}`
    if (r.raw.fitid && count[k] === 1) { r.fitid = r.raw.acct ? k : r.raw.fitid; return }
    const h = `${r.date}|${r.amount}|${r.description.toLowerCase()}`
    seen[h] = (seen[h] || 0) + 1
    r.fitid = `h:${r.raw.acct ? r.raw.acct + ':' : ''}${h}|${seen[h]}`
  })

  return out.map((r, i) => [i, r]).sort((a, b) => a[1].date.localeCompare(b[1].date) || a[0] - b[0]).map(x => x[1])
}

export default async function parseOfxFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Escolha um arquivo .OFX.')
  if (file.size > MAX_BYTES) throw new Error('Arquivo muito grande para um extrato OFX (máximo 5 MB).')
  return parseOfxText(decode(await file.arrayBuffer()))
}