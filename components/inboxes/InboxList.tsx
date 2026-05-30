'use client'

import { useRouter } from 'next/navigation'
import { Inbox as InboxIcon, Plus, Phone, Hash } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Inbox } from '@/lib/types'

export default function InboxList({ inboxes }: { inboxes: Inbox[] }) {
  const router = useRouter()

  return (
    <div className="max-w-4xl mx-auto p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Caixas de Entrada</h1>
          <p className="text-sm text-gray-500 mt-1">
            Gerencie os números de WhatsApp conectados ao sistema
          </p>
        </div>
        <button
          onClick={() => router.push('/inboxes/new')}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nova Caixa
        </button>
      </div>

      {/* Lista */}
      {inboxes.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <InboxIcon className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p className="font-medium">Nenhuma caixa de entrada configurada</p>
          <p className="text-sm mt-1">Adicione um número de WhatsApp para começar</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {inboxes.map((inbox) => (
            <InboxCard
              key={inbox.id}
              inbox={inbox}
              onClick={() => router.push(`/inboxes/${inbox.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function InboxCard({ inbox, onClick }: { inbox: Inbox; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-white border border-gray-200 rounded-xl p-5 hover:border-emerald-300 hover:shadow-sm transition-all group"
    >
      <div className="flex items-start gap-4">
        {/* Ícone */}
        <div className={cn(
          'w-12 h-12 rounded-xl flex items-center justify-center shrink-0',
          inbox.is_active ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'
        )}>
          <InboxIcon className="w-6 h-6" />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900">{inbox.name}</span>
            <span className={cn(
              'text-[10px] font-semibold px-2 py-0.5 rounded-full',
              inbox.is_active
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-gray-100 text-gray-500'
            )}>
              {inbox.is_active ? 'Ativo' : 'Inativo'}
            </span>
          </div>

          {inbox.description && (
            <p className="text-sm text-gray-500 mt-0.5 truncate">{inbox.description}</p>
          )}

          <div className="flex items-center gap-4 mt-2">
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <Phone className="w-3 h-3" />
              +{inbox.phone_number}
            </span>
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <Hash className="w-3 h-3" />
              ID: {inbox.phone_number_id}
            </span>
          </div>
        </div>

        {/* Arrow */}
        <span className="text-gray-300 group-hover:text-emerald-500 transition-colors text-lg shrink-0">→</span>
      </div>
    </button>
  )
}
