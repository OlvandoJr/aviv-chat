'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Plus, MoreVertical, UserCheck, UserX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { getInitials, formatDate } from '@/lib/utils'
import type { Attendant } from '@/lib/types'

interface Props {
  initialAttendants: Attendant[]
}

export default function AttendantsClient({ initialAttendants }: Props) {
  const supabase = createClient()

  const [attendants, setAttendants] = useState(initialAttendants)
  const [showForm,   setShowForm]   = useState(false)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const [form, setForm] = useState({
    name:     '',
    email:    '',
    password: '',
    role:     'agent' as 'admin' | 'agent',
  })

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    // Criar usuário via Supabase Auth Admin (requer API route)
    const resp = await fetch('/api/attendants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(form),
    })

    const result = await resp.json()

    if (!resp.ok) {
      setError(result.error || 'Erro ao criar atendente')
      setLoading(false)
      return
    }

    setAttendants((prev) => [result.attendant, ...prev])
    setShowForm(false)
    setForm({ name: '', email: '', password: '', role: 'agent' })
    setLoading(false)
  }

  async function toggleActive(attendant: Attendant) {
    const { data } = await supabase
      .from('chat_attendants')
      .update({ is_active: !attendant.is_active })
      .eq('id', attendant.id)
      .select()
      .single()

    if (data) {
      setAttendants((prev) => prev.map((a) => a.id === data.id ? { ...a, ...data } : a))
    }
  }

  return (
    <div className="space-y-4">
      {/* Botão adicionar */}
      <div className="flex justify-end">
        <Button onClick={() => setShowForm(!showForm)} size="sm">
          <Plus className="w-4 h-4" />
          Novo atendente
        </Button>
      </div>

      {/* Formulário de criação */}
      {showForm && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Criar atendente</h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nome</label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Nome completo"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="email@empresa.com"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Senha inicial</label>
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="Mínimo 6 caracteres"
                  minLength={6}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Perfil</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'agent' })}
                  className="w-full h-9 rounded-md border border-gray-200 bg-transparent px-3 text-sm"
                >
                  <option value="agent">Atendente</option>
                  <option value="admin">Administrador</option>
                </select>
              </div>
            </div>
            {error && (
              <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
            )}
            <div className="flex gap-2 pt-1">
              <Button type="submit" size="sm" disabled={loading}>
                {loading ? 'Criando...' : 'Criar atendente'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowForm(false)}
              >
                Cancelar
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Lista */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {attendants.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">
            Nenhum atendente cadastrado ainda.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {attendants.map((a) => (
              <div key={a.id} className="flex items-center gap-4 px-4 py-3">
                <Avatar className="w-9 h-9">
                  <AvatarFallback>{getInitials(a.name)}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{a.name}</p>
                  <p className="text-xs text-gray-400">{a.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={a.role === 'admin' ? 'default' : 'secondary'} className="text-[10px]">
                    {a.role === 'admin' ? 'Admin' : 'Atendente'}
                  </Badge>
                  <Badge
                    variant={a.is_active ? 'default' : 'outline'}
                    className="text-[10px]"
                  >
                    {a.is_active ? 'Ativo' : 'Inativo'}
                  </Badge>
                </div>
                <button
                  onClick={() => toggleActive(a)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                  title={a.is_active ? 'Desativar' : 'Ativar'}
                >
                  {a.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
