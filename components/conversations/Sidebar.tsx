'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { MessageSquare, Settings, LogOut, Users, Bot, Inbox, Plug } from 'lucide-react'
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

  return (
    <aside className="w-14 flex flex-col items-center py-4 bg-gray-900 text-white shrink-0 border-r border-gray-800">
      {/* Logo */}
      <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center mb-6">
        <MessageSquare className="w-4 h-4 text-white" />
      </div>

      {/* Nav */}
      <nav className="flex flex-col items-center gap-2 flex-1">
        <NavItem
          href="/conversations"
          icon={<MessageSquare className="w-5 h-5" />}
          label="Conversas"
          active={pathname.startsWith('/conversations')}
        />
        {attendant?.role === 'admin' && (
          <>
            <NavItem
              href="/inboxes"
              icon={<Inbox className="w-5 h-5" />}
              label="Caixas de Entrada"
              active={pathname.startsWith('/inboxes')}
            />
            <NavItem
              href="/agents"
              icon={<Bot className="w-5 h-5" />}
              label="Agentes"
              active={pathname.startsWith('/agents')}
            />
            <NavItem
              href="/apis"
              icon={<Plug className="w-5 h-5" />}
              label="APIs"
              active={pathname.startsWith('/apis')}
            />
            <NavItem
              href="/settings/attendants"
              icon={<Users className="w-5 h-5" />}
              label="Atendentes"
              active={pathname.startsWith('/settings')}
            />
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="flex flex-col items-center gap-3">
        <button
          onClick={handleLogout}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          title="Sair"
        >
          <LogOut className="w-4 h-4" />
        </button>

        <Avatar className="w-8 h-8">
          <AvatarImage src={attendant?.avatar_url || ''} />
          <AvatarFallback className="text-[10px] bg-gray-600 text-white">
            {getInitials(attendant?.name || attendant?.email || '?')}
          </AvatarFallback>
        </Avatar>
      </div>
    </aside>
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
      className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
        active
          ? 'bg-emerald-600 text-white'
          : 'text-gray-400 hover:text-white hover:bg-gray-700'
      }`}
      title={label}
    >
      {icon}
    </Link>
  )
}
