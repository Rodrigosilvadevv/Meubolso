import { useEffect, useState } from 'react'

// Campo para ver e mudar o nome mostrado no app (saudação e "Minha conta")
export default function NomeEditor({ cloud, say }) {
  const atual = cloud.profile?.name || ''
  const [nome, setNome] = useState(atual)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setNome(atual) }, [atual])

  const mudou = nome.trim() && nome.trim() !== atual

  const salvar = async e => {
    e.preventDefault()
    if (busy || !mudou) return
    setBusy(true)
    const r = await cloud.saveName(nome)
    setBusy(false)
    say(r.error ? `Não foi possível salvar: ${r.error}` : 'Nome atualizado')
  }

  return (
    <form className="form" onSubmit={salvar}>
      <label>Seu nome
        <input value={nome} maxLength={60} autoComplete="name" placeholder="Como devemos te chamar?" onChange={e => setNome(e.target.value)} />
      </label>
      <button className="cta" disabled={busy || !mudou}>{busy ? 'Salvando…' : 'Salvar nome'}</button>
    </form>
  )
}