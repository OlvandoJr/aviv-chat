'use client'

import { useState }                 from 'react'
import { Plus, UserCheck, UserX, Pencil, X, Check, Trash2, KeyRound, Copy, Loader2, AlertTriangle } from 'lucide-react'
import { Button }                   from '@/components/ui/button'
import { Input }                    from '@/components/ui/input'
import { Badge }                    from '@/components/ui/badge'
import { Avatar, AvatarFallback }   from '@/components/ui/avatar'
import { getInitials, formatDate }  from '@/lib/utils'
import { ATTENDANT_SECTORS }        from '@/lib/types'
import type { Attendant, AttendantRole } from '@/lib/types'

const SECTORS = ATTENDANT_SECTORS

const ROLE_LABELS: Record<AttendantRole, string> = {
  admin:   'Administrador',
  manager: 'Gerente',
  agent:   'Atendente',
}

const ROLE_BADGE: Record<AttendantRole, string> = {
  admin:   'bg-violet-100 text-violet-700',
  manager: 'bg-blue-100  text-blue-700',
  agent:   'bg-gray-100  text-gray-600',
}

interface Props {
  initialAttendants: Attendant[]
  currentUserRole:   AttendantRole
  currentUserId:     string
}

type TeamOption = { id: string; name: string; sector: string | null }
type DeleteState = {
  attendant: Attendant
  openCount: number
  team: TeamOption[]
  mode: 'transfer' | 'archive'
  transferTo: string
  loading: boolean
  error: string | null
}

type CreateForm = {
  name: string; email: string; password: string
  role: AttendantRole; sector: string
}

type EditForm = {
  name: string; sector: string; role: AttendantRole; is_active: boolean
}

export default function AttendantsClient({ initialAttendants, currentUserRole, currentUserId }: Props) {
  const [attendants, setAttendants] = useState(initialAttendants)
  const [showForm,   setShowForm]   = useState(false)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [editingId,  setEditingId]  = useState<string | null>(null)
  const [editForm,   setEditForm]   = useState<EditForm | null>(null)
  const [del,        setDel]        = useState<DeleteState | null>(null)
  const [resetInfo,  setResetInfo]  = useState<{ name: string; password: string } | null>(null)
  const [busyId,     setBusyId]     = useState<string | null>(null)

  // Quem pode excluir/resetar este usuário: nunca a si mesmo; gerente só mexe em agentes.
  function canManage(a: Attendant): boolean {
    if (a.id === currentUserId) return false
    if (currentUserRole === 'manager') return a.role === 'agent'
    return currentUserRole === 'admin'
  }

  // ── Reset de senha ───────────────────────────────────────────────────────────
  async function handleReset(a: Attendant) {
    if (!window.confirm(`Gerar uma nova senha para ${a.name}? A senha atual deixará de funcionar.`)) return
    setBusyId(a.id); setError(null)
    try {
      const resp = await fetch('/api/attendants', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: a.id, action: 'reset_password' }),
      })
      const result = await resp.json()
      if (!resp.ok) { setError(result.error || 'Erro ao resetar senha'); return }
      setResetInfo({ name: a.name || a.email, password: result.password })
    } finally { setBusyId(null) }
  }

  // ── Excluir: 1ª chamada sem ação → se houver conversas abertas, abre o modal ──
  async function startDelete(a: Attendant) {
    if (!window.confirm(`Excluir ${a.name}? O acesso será revogado. O histórico de mensagens é preservado.`)) return
    setBusyId(a.id); setError(null)
    try {
      const resp = await fetch('/api/attendants', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: a.id }),
      })
      const result = await resp.json()
      if (resp.ok && result.needsAction) {
        setDel({ attendant: a, openCount: result.openCount, team: result.team || [], mode: 'transfer', transferTo: result.team?.[0]?.id || '', loading: false, error: null })
        return
      }
      if (!resp.ok) { setError(result.error || 'Erro ao excluir'); return }
      setAttendants((prev) => prev.filter((x) => x.id !== a.id))
    } finally { setBusyId(null) }
  }

  async function confirmDelete() {
    if (!del) return
    setDel({ ...del, loading: true, error: null })
    const payload: any = { id: del.attendant.id, action: del.mode }
    if (del.mode === 'transfer') {
      if (!del.transferTo) { setDel({ ...del, loading: false, error: 'Selecione para quem transferir.' }); return }
      payload.transferTo = del.transferTo
    }
    const resp = await fetch('/api/attendants', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    const result = await resp.json()
    if (!resp.ok) { setDel({ ...del, loading: false, error: result.error || 'Erro ao excluir' }); return }
    setAttendants((prev) => prev.filter((x) => x.id !== del.attendant.id))
    setDel(null)
  }

  const [form, setForm] = useState<CreateForm>({
    name: '', email: '', password: '', role: 'agent', sector: '',
  })

  // ── Criar ──────────────────────────────────────────────────────────────────
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const resp   = await fetch('/api/attendants', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(form),
    })
    const result = await resp.json()

    if (!resp.ok) {
      setError(result.error || 'Erro ao criar usuário')
      setLoading(false)
      return
    }

    setAttendants((prev) => [result.attendant, ...prev])
    setShowForm(false)
    setForm({ name: '', email: '', password: '', role: 'agent', sector: '' })
    setLoading(false)
  }

  // ── Editar ─────────────────────────────────────────────────────────────────
  function startEdit(a: Attendant) {
    setEditingId(a.id)
    setEditForm({ name: a.name || '', sector: a.sector || '', role: a.role, is_active: a.is_active })
  }

  function cancelEdit() { setEditingId(null); setEditForm(null) }

  async function saveEdit(a: Attendant) {
    if (!editForm) return
    setLoading(true)
    setError(null)

    const resp   = await fetch('/api/attendants', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: a.id, ...editForm }),
    })
    const result = await resp.json()

    if (!resp.ok) {
      setError(result.error || 'Erro ao salvar')
      setLoading(false)
      return
    }

    setAttendants((prev) => prev.map((x) => x.id === result.attendant.id ? result.attendant : x))
    cancelEdit()
    setLoading(false)
  }

  async function toggleActive(a: Attendant) {
    const resp   = await fetch('/api/attendants', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: a.id, is_active: !a.is_active }),
    })
    const result = await resp.json()
    if (resp.ok) setAttendants((prev) => prev.map((x) => x.id === result.attendant.id ? result.attendant : x))
  }

  // Roles disponíveis para criação conforme quem está logado
  const creatableRoles: AttendantRole[] =
    currentUserRole === 'admin' ? ['agent', 'manager', 'admin'] : ['agent']

  return (
    <div className="space-y-4">
      {/* ── Modal: excluir com conversas abertas ─────────────────────────────── */}
      {del && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !del.loading && setDel(null)}>
          <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Excluir {del.attendant.name}</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Este usuário tem <strong>{del.openCount}</strong> conversa(s) em aberto. Escolha o que fazer com elas antes de excluir.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <label className={`flex items-start gap-2 rounded-xl border p-3 cursor-pointer ${del.mode === 'transfer' ? 'border-emerald-300 bg-emerald-50/50' : 'border-gray-200'}`}>
                <input type="radio" checked={del.mode === 'transfer'} onChange={() => setDel({ ...del, mode: 'transfer' })} className="mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">Transferir para outro usuário</p>
                  {del.team.length === 0 ? (
                    <p className="text-[11px] text-amber-600 mt-1">Nenhum usuário disponível para transferência.</p>
                  ) : (
                    <select
                      value={del.transferTo}
                      onChange={(e) => setDel({ ...del, transferTo: e.target.value })}
                      disabled={del.mode !== 'transfer'}
                      className="mt-2 w-full h-8 rounded-md border border-gray-200 bg-white px-2 text-sm disabled:opacity-50"
                    >
                      {del.team.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}{t.sector ? ` · ${t.sector}` : ''}</option>
                      ))}
                    </select>
                  )}
                </div>
              </label>

              <label className={`flex items-start gap-2 rounded-xl border p-3 cursor-pointer ${del.mode === 'archive' ? 'border-emerald-300 bg-emerald-50/50' : 'border-gray-200'}`}>
                <input type="radio" checked={del.mode === 'archive'} onChange={() => setDel({ ...del, mode: 'archive' })} className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-gray-800">Arquivar as conversas</p>
                  <p className="text-[11px] text-gray-500">As conversas em aberto serão arquivadas.</p>
                </div>
              </label>
            </div>

            {del.error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{del.error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDel(null)} disabled={del.loading}>Cancelar</Button>
              <Button
                size="sm"
                onClick={confirmDelete}
                disabled={del.loading || (del.mode === 'transfer' && !del.transferTo)}
                className="bg-red-600 hover:bg-red-700"
              >
                {del.loading ? 'Excluindo...' : 'Excluir usuário'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: nova senha gerada ─────────────────────────────────────────── */}
      {resetInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setResetInfo(null)}>
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-amber-500" />
              <h3 className="text-sm font-semibold text-gray-900">Nova senha de {resetInfo.name}</h3>
            </div>
            <p className="text-xs text-gray-500">Copie e envie ao usuário agora — ela <strong>não será exibida novamente</strong>.</p>
            <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              <code className="flex-1 text-sm font-mono text-gray-900 select-all">{resetInfo.password}</code>
              <button
                onClick={() => navigator.clipboard?.writeText(resetInfo.password)}
                className="p-1 rounded text-gray-400 hover:text-gray-700" title="Copiar"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setResetInfo(null)}>Fechar</Button>
            </div>
          </div>
        </div>
      )}

      {/* Botão adicionar */}
      <div className="flex justify-end">
        <Button onClick={() => setShowForm(!showForm)} size="sm">
          <Plus className="w-4 h-4 mr-1" />
          Novo usuário
        </Button>
      </div>

      {/* Formulário de criação */}
      {showForm && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Criar usuário</h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nome</label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nome completo" required />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@empresa.com" required />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Senha inicial</label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Mín. 6 caracteres" minLength={6} required />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Setor</label>
                <select
                  value={form.sector}
                  onChange={(e) => setForm({ ...form, sector: e.target.value })}
                  className="w-full h-9 rounded-md border border-gray-200 bg-transparent px-3 text-sm"
                >
                  <option value="">— Selecione —</option>
                  {SECTORS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Perfil</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as AttendantRole })}
                  className="w-full h-9 rounded-md border border-gray-200 bg-transparent px-3 text-sm"
                >
                  {creatableRoles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              </div>
            </div>
            {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <div className="flex gap-2 pt-1">
              <Button type="submit" size="sm" disabled={loading}>
                {loading ? 'Criando...' : 'Criar usuário'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => { setShowForm(false); setError(null) }}>
                Cancelar
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Erro de edição */}
      {error && !showForm && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
      )}

      {/* Lista */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {attendants.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">Nenhum usuário cadastrado ainda.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {attendants.map((a) =>
              editingId === a.id && editForm ? (
                /* ── Linha de edição inline ─────────────────────────────── */
                <div key={a.id} className="px-4 py-3 bg-blue-50/40 space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-gray-500 mb-1">Nome</label>
                      <Input
                        value={editForm.name}
                        onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-gray-500 mb-1">Setor</label>
                      <select
                        value={editForm.sector}
                        onChange={(e) => setEditForm({ ...editForm, sector: e.target.value })}
                        className="w-full h-8 rounded-md border border-gray-200 bg-white px-2 text-sm"
                      >
                        <option value="">— Sem setor —</option>
                        {SECTORS.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-gray-500 mb-1">Perfil</label>
                      <select
                        value={editForm.role}
                        onChange={(e) => setEditForm({ ...editForm, role: e.target.value as AttendantRole })}
                        disabled={currentUserRole === 'manager'}
                        className="w-full h-8 rounded-md border border-gray-200 bg-white px-2 text-sm disabled:opacity-50"
                      >
                        {creatableRoles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" disabled={loading} onClick={() => saveEdit(a)}>
                      <Check className="w-3.5 h-3.5 mr-1" />
                      {loading ? 'Salvando...' : 'Salvar'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={cancelEdit}>
                      <X className="w-3.5 h-3.5 mr-1" />
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : (
                /* ── Linha normal ───────────────────────────────────────── */
                <div key={a.id} className="flex items-center gap-4 px-4 py-3">
                  <Avatar className="w-9 h-9 shrink-0">
                    <AvatarFallback>{getInitials(a.name)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{a.name}</p>
                    <p className="text-xs text-gray-400">{a.email}{a.sector ? ` · ${a.sector}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${ROLE_BADGE[a.role]}`}>
                      {ROLE_LABELS[a.role]}
                    </span>
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${a.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-400'}`}>
                      {a.is_active ? 'Ativo' : 'Inativo'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => startEdit(a)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                      title="Editar"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => toggleActive(a)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                      title={a.is_active ? 'Desativar' : 'Ativar'}
                    >
                      {a.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                    </button>
                    {canManage(a) && (
                      <>
                        <button
                          onClick={() => handleReset(a)}
                          disabled={busyId === a.id}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors disabled:opacity-50"
                          title="Resetar senha"
                        >
                          {busyId === a.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          onClick={() => startDelete(a)}
                          disabled={busyId === a.id}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                          title="Excluir usuário"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}
