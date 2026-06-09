import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Resolve a URL de exibição de uma mídia do chat. O bucket `chat-media` é PRIVADO:
 * URLs antigas (`/object/public/chat-media/...`) e novas são roteadas pelo proxy
 * autenticado `/api/media`, que devolve uma signed URL fresca. URLs externas passam direto.
 */
export function mediaSrc(url?: string | null): string {
  if (!url) return ''
  const m = url.match(/\/object\/(?:public|sign)\/chat-media\/(.+?)(?:\?|$)/)
  if (m) return `/api/media?path=${encodeURIComponent(m[1])}`
  return url
}

export function formatTime(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now   = new Date()
  const diff  = now.getTime() - date.getTime()
  const days  = Math.floor(diff / 86400000)

  if (days === 0) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  } else if (days === 1) {
    return 'Ontem'
  } else if (days < 7) {
    return date.toLocaleDateString('pt-BR', { weekday: 'short' })
  } else {
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  }
}

// Sempre o horário HH:MM — usado dentro do balão da mensagem
export function formatHour(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

// Separador de dia ao estilo WhatsApp: Hoje | Ontem | segunda-feira | 22 de maio
export function formatDaySeparator(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now  = new Date()
  const d0 = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const n0 = new Date(now.getFullYear(),  now.getMonth(),  now.getDate())
  const days = Math.round((n0.getTime() - d0.getTime()) / 86400000)

  if (days === 0) return 'Hoje'
  if (days === 1) return 'Ontem'
  if (days > 1 && days < 7) {
    const wd = date.toLocaleDateString('pt-BR', { weekday: 'long' })
    return wd.charAt(0).toUpperCase() + wd.slice(1)   // "Segunda-feira"
  }
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString('pt-BR', {
    day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }),
  })
}

// Chave de dia (YYYY-M-D em horário local) para agrupar mensagens
export function dayKey(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function formatCurrency(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('pt-BR')
}

export function getInitials(name: string | null): string {
  if (!name) return '?'
  return name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase()
}
