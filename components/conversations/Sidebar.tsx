'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { MessageSquare, LogOut, Users, Bot, Inbox, Plug, Puzzle, CalendarDays, LayoutTemplate, Megaphone, CalendarClock, UsersRound, Receipt } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { getInitials } from '@/lib/utils'
import type { Attendant } from '@/lib/types'

interface SidebarProps {
  attendant: Attendant | null
}

export default function Sidebar({ attendant }: SidebarProps) {
  const pathname = usePathname()
  const router   = useRouter()
  const supabase = createClient()

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const isAdmin   = attendant?.role === 'admin'
  const isManager = attendant?.role === 'admin' || attendant?.role === 'manager'

  return (
    // Placeholder de 56px mantém o layout estável; o menu real flutua por cima e expande no hover.
    <div className="w-14 shrink-0 relative z-40">
      <aside className="group absolute inset-y-0 left-0 w-14 hover:w-56 overflow-hidden bg-gray-900 text-white border-r border-gray-800 flex flex-col py-4 transition-[width] duration-200 ease-out hover:shadow-2xl">
        {/* Logo */}
        <div className="flex items-center gap-3 px-3 mb-6 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center shrink-0">
            <MessageSquare className="w-4 h-4 text-white" />
          </div>
          <span className="text-sm font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200">Aviv Chat</span>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-1 flex-1 px-2 overflow-y-auto overflow-x-hidden">
          <NavItem href="/conversations" icon={<MessageSquare className="w-5 h-5" />} label="Conversas" active={pathname.startsWith('/conversations')} />
          <NavItem href="/calendar"      icon={<CalendarDays  className="w-5 h-5" />} label="Calendário" active={pathname.startsWith('/calendar')} />
          <NavItem href="/boletos"       icon={<Receipt       className="w-5 h-5" />} label="Carregar Boletos" active={pathname.startsWith('/boletos')} />

          {isAdmin && (
            <>
              <NavItem href="/inboxes"      icon={<Inbox  className="w-5 h-5" />} label="Caixas de Entrada" active={pathname.startsWith('/inboxes')} />
              <NavItem href="/apis"         icon={<Plug   className="w-5 h-5" />} label="APIs"              active={pathname.startsWith('/apis')} />
              <NavItem href="/integrations" icon={<Puzzle className="w-5 h-5" />} label="Integrações"       active={pathname.startsWith('/integrations')} />
            </>
          )}
          {isManager && (
            <>
              <NavItem href="/clients"             icon={<UsersRound     className="w-5 h-5" />} label="Central de Clientes" active={pathname.startsWith('/clients')} />
              <NavItem href="/agents"              icon={<Bot            className="w-5 h-5" />} label="Agentes IA"          active={pathname.startsWith('/agents')} />
              <NavItem href="/templates"           icon={<LayoutTemplate className="w-5 h-5" />} label="Templates"           active={pathname.startsWith('/templates')} />
              <NavItem href="/campaigns"           icon={<Megaphone      className="w-5 h-5" />} label="Campanhas"           active={pathname.startsWith('/campaigns')} />
              <NavItem href="/regua"               icon={<CalendarClock  className="w-5 h-5" />} label="Régua de Cobrança"   active={pathname.startsWith('/regua')} />
              <NavItem href="/settings/attendants" icon={<Users          className="w-5 h-5" />} label="Usuários"            active={pathname.startsWith('/settings')} />
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="flex flex-col gap-1 px-2 shrink-0 mt-2">
          <button
            onClick={handleLogout}
            className="flex items-center h-9 rounded-lg px-2 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
            title="Sair"
          >
            <span className="w-5 h-5 flex items-center justify-center shrink-0"><LogOut className="w-4 h-4" /></span>
            <span className="ml-3 text-sm whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200">Sair</span>
          </button>

          <div className="flex items-center h-9 px-2">
            <Avatar className="w-7 h-7 shrink-0">
              <AvatarImage src={attendant?.avatar_url || ''} />
              <AvatarFallback className="text-[10px] bg-gray-600 text-white">
                {getInitials(attendant?.name || attendant?.email || '?')}
              </AvatarFallback>
            </Avatar>
            <span className="ml-2.5 text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 truncate">
              {attendant?.name || attendant?.email || ''}
            </span>
          </div>
        </div>
      </aside>
    </div>
  )
}

function NavItem({
  href, icon, label, active,
}: {
  href: string; icon: React.ReactNode; label: string; active: boolean
}) {
  return (
    <Link
      href={href}
      title={label}
      className={`flex items-center h-9 rounded-lg px-2 transition-colors ${
        active ? 'bg-emerald-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
      }`}
    >
      <span className="w-5 h-5 flex items-center justify-center shrink-0">{icon}</span>
      <span className="ml-3 text-sm whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200">{label}</span>
    </Link>
  )
}
