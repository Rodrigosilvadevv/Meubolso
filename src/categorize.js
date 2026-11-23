// Motor de categorização do Meu bolso (importação de extrato OFX).
// Baseado no "Dicionário Completo e Motor de Regras": 3 pilares + receitas.
//
//  Camada 1: regras da própria pessoa (tabela bolso_merchant_rules)
//  Camada 2: dicionário padrão de palavras-chave
//  Camada 3: "Outros" (pilar Livre)

// Pilar -> bucket usado pelo app em bolso_spends.bucket
export const PILLARS = {
  essential: { label: 'Essenciais', bucket: 'essencial' },
  unforeseen: { label: 'Imprevisto', bucket: 'imprevisto' },
  free: { label: 'Livre', bucket: 'livre' },
  income: { label: 'Receitas', bucket: null },
}

// keywords: lista separada por vírgula (será normalizada: sem acento, minúsculo, só letras e números)
export const CATEGORIES = [
  { id: 'food_essential', label: 'Alimentação Básica', pillar: 'essential',
    keywords: 'supermercado, super, hipermercado, pao de acucar, carrefour, assai, atacadao, makro, extra, sendas, guanabara, savegnago, dia, st. marche, hortifruti, acougue, feira, mercado municipal, sacolao, padaria, mini mercado' },
  { id: 'housing', label: 'Moradia & Contas', pillar: 'essential',
    keywords: 'aluguel, condominio, iptu, enel, light, sabesp, copasa, comgas, eletropaulo, cpfl, sanepar, cedae, claro, vivo, tim, oi, brisa net, algar, internet, gas, taxa condominial' },
  { id: 'health_essential', label: 'Saúde & Farmácia', pillar: 'essential',
    // No dicionário original era "sao paulo" solto (pegaria qualquer endereço em São Paulo); aqui vira "drogaria sao paulo".
    keywords: 'farmacia, drogasil, raia, pacheco, ultrafarma, drogaria, drogaria sao paulo, panvel, nissei, unimed, hapvida, amil, sulamerica, bradesco saude, medsenior, laboratorio, fleury, a+ dante pazzanese, consulta medica, dentista' },
  { id: 'transport_essential', label: 'Transporte Fixo', pillar: 'essential',
    keywords: 'posto, ipiranga, shell, petrobras, ale, br mania, sem parar, conectcar, veloe, cetip, pedagio, auto expresso, metro, cptm, onibus, bilhete unico, recarga transporte, uber transit' },
  { id: 'education', label: 'Educação & Trabalho', pillar: 'essential',
    keywords: 'pucpr, faculdade, universidade, escola, curso, udemy, alura, senai, senac, livro, livraria, estacio, unip, fgv, coursera, material escolar' },
  { id: 'others_essential', label: 'Outros (Essenciais)', pillar: 'essential', keywords: '' },

  { id: 'emergency_health', label: 'Emergência Médica', pillar: 'unforeseen',
    keywords: 'pronto socorro, hospital, emergencia, clinica particular, exame urgencia, ambulancia, farmacia de emergencia, remedio urgencia' },
  { id: 'emergency_maintenance', label: 'Manutenção Corretiva', pillar: 'unforeseen',
    keywords: 'mecanica, oficina mecanica, auto mecanica, eletricista, encanador, chaveiro, conserto, reparo, pecas auto, borracharia, guincho' },
  { id: 'emergency_fines', label: 'Multas e Taxas', pillar: 'unforeseen',
    keywords: 'detran, multa, multa de transito, taxa estadual, cartorio, protesto, ipva atrasado, licenciamento' },
  { id: 'others_unforeseen', label: 'Outros (Imprevisto)', pillar: 'unforeseen', keywords: '' },

  { id: 'dining_free', label: 'Restaurantes & Delivery', pillar: 'free',
    // "uber eats" / "ubereats" foram acrescentados (senão cairiam em Transporte por causa de "uber").
    keywords: 'ifood, rappi, 99food, uber eats, ubereats, mcdonalds, burger king, bk, subway, starbucks, pizzaria, restaurante, churrascaria, lanchonete, bar, pub, cafeteria, sorveteria, acai' },
  { id: 'transport_free', label: 'Transporte (Lazer)', pillar: 'free',
    keywords: 'uber, 99, 99app, cabify, 99 pop, 99 moto, aluguel de carro, localiza, movida, uber trip' },
  { id: 'entertainment', label: 'Lazer & Assinaturas', pillar: 'free',
    keywords: 'netflix, spotify, apple.com, google play, steam, playstation, xbox, prime video, disney, hbo max, paramount, crunchyroll, youtube premium, cinemark, cinepolis, teatro, ingresso, show' },
  { id: 'shopping_free', label: 'Compras & E-commerce', pillar: 'free',
    keywords: 'mercadolivre, mercado livre, amazon, shopee, shein, aliexpress, magalu, magazine luiza, americanas, casas bahia, centauro, zattini, renner, riachuelo, c&a' },
  { id: 'travel', label: 'Viagens & Passeios', pillar: 'free',
    keywords: 'hotel, airbnb, booking, latam, gol, azul, decolar, 123milhas, cvs, passagens aereas, hostel, resort, albergue' },
  { id: 'others', label: 'Outros', pillar: 'free', keywords: '' }, // fallback padrão

  { id: 'income', label: 'Entradas / Salário', pillar: 'income',
    keywords: 'pix recebido, ted recebido, doc recebido, salario, pagamento de salario, pro-labore, rendimento, resgate, dividendos, cash back, estorno, reembolso' },
]

export const CAT_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]))
export const FALLBACK_BY_PILLAR = { essential: 'others_essential', unforeseen: 'others_unforeseen', free: 'others' }

// Pilar do banco (essential/unforeseen/free) -> bucket do app
export const bucketOf = categoryId => PILLARS[CAT_BY_ID[categoryId]?.pillar]?.bucket || 'livre'

// "UBER *TRIP", "Uber  Trip" e "uber trip" viram a mesma coisa
export const normalizeText = t =>
  String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Dicionário compilado uma vez. Palavra mais longa primeiro: "aluguel de carro" ganha de "aluguel",
// "uber trip" ganha de "uber", "farmacia de emergencia" ganha de "farmacia".
const DICT = CATEGORIES
  .flatMap(c => c.keywords.split(',').map(normalizeText).filter(Boolean).map(kw => ({ kw, cat: c.id })))
  .sort((a, b) => b.kw.length - a.kw.length)

const result = (id, source, pillarHint) => {
  let cat = CAT_BY_ID[id]
  if (!cat) cat = CAT_BY_ID[FALLBACK_BY_PILLAR[pillarHint] || 'others'] // regra antiga apontando para categoria que não existe mais
  return { category_id: cat.id, pillar: cat.pillar, bucket: PILLARS[cat.pillar].bucket, label: cat.label, source }
}

/**
 * Sugere a categoria de uma transação.
 * @param {string} description  texto da transação (MEMO/NAME do OFX)
 * @param {Array<{keyword:string, category_id:string, pillar?:string}>} customRules  linhas de bolso_merchant_rules
 * @param {'DEBIT'|'CREDIT'} type  entradas sempre são "Entradas / Salário"
 * @returns {{category_id:string, pillar:string, bucket:string|null, label:string, source:'custom'|'default'|'fallback'}}
 */
export function categorizeTransaction(description, customRules = [], type = 'DEBIT') {
  if (type === 'CREDIT') return result('income', 'default')
  const text = normalizeText(description)
  if (!text) return result('others', 'fallback')

  // Passo 1: regras da pessoa (a palavra só precisa estar contida no texto; a mais longa vence)
  const mine = (customRules || [])
    .map(r => ({ ...r, kw: normalizeText(r.keyword) }))
    .filter(r => r.kw)
    .sort((a, b) => b.kw.length - a.kw.length)
  for (const r of mine) if (text.includes(r.kw)) return result(r.category_id, 'custom', r.pillar)

  // Passo 2: dicionário padrão (palavra inteira, para "dia" não pegar "media")
  const padded = ` ${text} `
  for (const d of DICT) {
    if (d.cat === 'income') continue
    if (padded.includes(` ${d.kw} `)) return result(d.cat, 'default')
  }

  // Passo 3: não achou nada
  return result('others', 'fallback')
}

// Sugere o "nome do estabelecimento" para virar regra: tira as palavras genéricas do banco
// ("compra no debito", "pix enviado"...) e fica com as duas primeiras palavras que sobram.
const NOISE = new Set(('compra compras cartao debito credito pix ted doc transferencia transf enviada enviado recebida recebido ' +
  'pagamento pagto pgto pag em de do da dos das no na nos nas a o e com via br brasil parcela parc saque tarifa boleto ' +
  'deb cred aut autorizacao ref conta ltda sa me epp').split(' '))
export function merchantKey(description) {
  const toks = normalizeText(description).split(' ').filter(Boolean)
  const good = toks.filter(t => !NOISE.has(t) && !/^\d+$/.test(t) && t.length > 1)
  return (good.length ? good : toks).slice(0, 2).join(' ')
}