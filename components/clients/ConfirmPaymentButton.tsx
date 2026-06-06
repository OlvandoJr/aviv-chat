'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  source:  'sienge' | 'sgl'
  id:      string | number
  /** 'icon' = só o ✓ compacto (painel da conversa); 'full' = botão com texto (Central) */
  variant?: 'icon' | 'full'
  className?: string
}

export default function ConfirmPaymentButton({ source, id, variant = 'full', className }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function confirm(e: React.MouseEvent) {
    e.stopPropagation()
    if (loading) return
    if (!window.confirm('Confirmar o pagamento desta parcela? Ela será marcada como paga.')) return
    setLoading(true)
    try {
      const resp = await fetch('/api/boletos/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, id }),
      })
      if (!resp.ok) {
        const { error } = await resp.json().catch(() => ({ error: 'falha' }))
        alert(`Não foi possível dar baixa: ${error || resp.status}`)
        return
      }
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  if (variant === 'icon') {
    return (
      <button
        onClick={confirm}
        disabled={loading}
        title="Confirmar pagamento (dar baixa)"
        className={cn('shrink-0 text-gray-300 hover:text-emerald-600 transition-colors', className)}
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
      </button>
    )
  }

  return (
    <button
      onClick={confirm}
      disabled={loading}
      className={cn(
        'flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors',
        'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-60',
        className,
      )}
    >
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
      Confirmar pagamento
    </button>
  )
}
