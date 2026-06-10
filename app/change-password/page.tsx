'use client'

import { useEffect, useState } from 'react'
import { useRouter }           from 'next/navigation'
import { createClient }        from '@/lib/supabase/client'
import { KeyRound, Loader2 }   from 'lucide-react'
import { Button }              from '@/components/ui/button'
import { Input }               from '@/components/ui/input'

export default function ChangePasswordPage() {
  const router   = useRouter()
  const supabase = createClient()

  const [checking, setChecking] = useState(true)
  const [pwd, setPwd]           = useState('')
  const [confirm, setConfirm]   = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  // Precisa estar logado para trocar a própria senha.
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.replace('/login'); return }
      setChecking(false)
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (pwd.length < 8) { setError('A senha deve ter ao menos 8 caracteres.'); return }
    if (pwd !== confirm) { setError('As senhas não coincidem.'); return }
    setLoading(true)

    // Atualiza a senha e LIMPA a flag de troca obrigatória (metadata do Auth).
    const { error: upErr } = await supabase.auth.updateUser({
      password: pwd,
      data: { must_change_password: false },
    })
    if (upErr) { setError(upErr.message); setLoading(false); return }

    // Recarrega a sessão para o middleware enxergar o metadata atualizado.
    await supabase.auth.refreshSession()
    router.replace('/conversations')
    router.refresh()
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-full bg-emerald-50 flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-emerald-600" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-gray-900">Defina sua senha</h1>
            <p className="text-xs text-gray-500">Primeiro acesso — crie uma senha pessoal para continuar.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Nova senha</label>
            <Input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="Mín. 8 caracteres" minLength={8} required autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Confirmar senha</label>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repita a senha" minLength={8} required />
          </div>
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Salvando...' : 'Salvar e continuar'}
          </Button>
        </form>
      </div>
    </div>
  )
}
