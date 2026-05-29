import { MessageSquare } from 'lucide-react'
import ConversationList from '@/components/conversations/ConversationList'

export default function ConversationsPage() {
  return (
    <>
      <ConversationList />
      {/* Placeholder quando nenhuma conversa selecionada */}
      <div className="flex-1 hidden md:flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <MessageSquare className="w-8 h-8 text-emerald-600" />
          </div>
          <h2 className="text-lg font-semibold text-gray-700">Selecione uma conversa</h2>
          <p className="text-sm text-gray-400 mt-1">Escolha uma conversa na lista ao lado</p>
        </div>
      </div>
    </>
  )
}
