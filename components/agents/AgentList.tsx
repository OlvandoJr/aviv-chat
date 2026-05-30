'use client'

import { useRouter } from 'next/navigation'
import { Bot, Plus, Star, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Agent } from '@/lib/types'

export default function AgentList({ agents }: { agents: Agent[] }) {
  const router = useRouter()

  return (
    <div className="max-w-4xl mx-auto p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agentes</h1>
          <p className="text-sm text-gray-500 mt-1">
            Configure os bots de IA que atendem suas conversas
          </p>
        </div>
        <button
          onClick={() => router.push('/agents/new')}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Novo Agente
        </button>
      </div>

      {/* Lista */}
      {agents.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <Bot className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p className="font-medium">Nenhum agente configurado</p>
          <p className="text-sm mt-1">Crie um agente para começar a automatizar seus atendimentos</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onClick={() => router.push(`/agents/${agent.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function AgentCard({ agent, onClick }: { agent: Agent; onClick: () => void }) {
  const modelLabel: Record<string, string> = {
    'gpt-4o-mini': 'GPT-4o Mini',
    'gpt-4o':      'GPT-4o',
    'gpt-3.5-turbo': 'GPT-3.5',
  }

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-white border border-gray-200 rounded-xl p-5 hover:border-emerald-300 hover:shadow-sm transition-all group"
    >
      <div className="flex items-start gap-4">
        {/* Emoji */}
        <div className={cn(
          'w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0',
          agent.is_active ? 'bg-emerald-50' : 'bg-gray-100'
        )}>
          {agent.avatar_emoji}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900">{agent.name}</span>

            {agent.is_default && (
              <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                <Star className="w-3 h-3" />
                Padrão
              </span>
            )}

            <span className={cn(
              'text-[10px] font-semibold px-2 py-0.5 rounded-full',
              agent.is_active
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-gray-100 text-gray-500'
            )}>
              {agent.is_active ? 'Ativo' : 'Inativo'}
            </span>
          </div>

          {agent.description && (
            <p className="text-sm text-gray-500 mt-0.5 truncate">{agent.description}</p>
          )}

          <div className="flex items-center gap-3 mt-2">
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <Zap className="w-3 h-3" />
              {modelLabel[agent.model] || agent.model}
            </span>
            <span className="text-xs text-gray-400">
              Temp {agent.temperature}
            </span>
            <span className="text-xs text-gray-400">
              {agent.memory_messages} msgs contexto
            </span>
          </div>
        </div>

        {/* Arrow */}
        <span className="text-gray-300 group-hover:text-emerald-500 transition-colors text-lg shrink-0">→</span>
      </div>
    </button>
  )
}
