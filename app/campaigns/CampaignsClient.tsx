'use client'

import Link from 'next/link'
import { Megaphone, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho', scheduled: 'Agendada', running: 'Enviando',
  paused: 'Pausada', done: 'Concluída', failed: 'Falhou',
}
const STATUS_COLOR: Record<string, string> = {
  draft:     'bg-gray-100 text-gray-600',
  scheduled: 'bg-blue-100 text-blue-700',
  running:   'bg-amber-100 text-amber-700',
  paused:    'bg-orange-100 text-orange-700',
  done:      'bg-emerald-100 text-emerald-700',
  failed:    'bg-red-100 text-red-700',
}

export default function CampaignsClient({ initial }: { initial: any[] }) {
  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-emerald-600" /> Campanhas
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Dispare templates aprovados para vários clientes de uma vez.
          </p>
        </div>
        <Link
          href="/campaigns/new"
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 rounded-xl transition-colors"
        >
          <Plus className="w-4 h-4" /> Nova campanha
        </Link>
      </div>

      {initial.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <Megaphone className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">Nenhuma campanha ainda.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {initial.map((c) => {
            const pct = c.total ? Math.round(((c.sent + c.failed) / c.total) * 100) : 0
            return (
              <Link
                key={c.id}
                href={`/campaigns/${c.id}`}
                className="block bg-white border border-gray-100 rounded-xl px-5 py-4 hover:border-emerald-200 hover:shadow-sm transition-all"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900 truncate">{c.name}</span>
                      <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full uppercase', STATUS_COLOR[c.status])}>
                        {STATUS_LABEL[c.status] || c.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                      {c.template?.name || '—'} · {c.inbox?.name || '—'}{c.owner?.name ? <> · <span className="text-emerald-600">👤 {c.owner.name}</span></> : ''}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm text-gray-700">{c.sent}/{c.total} enviados</p>
                    {c.failed > 0 && <p className="text-xs text-red-500">{c.failed} falhas</p>}
                  </div>
                </div>
                {c.total > 0 && (
                  <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </>
  )
}
