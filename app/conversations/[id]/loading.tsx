// Skeleton instantâneo da área do chat (Suspense boundary da rota [id]).
// A lista de conversas e a sidebar ficam no layout, então só esta área pisca.
export default function ConversationLoading() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 bg-white shrink-0">
        <div className="w-9 h-9 rounded-full bg-gray-100 animate-pulse" />
        <div className="space-y-1.5">
          <div className="h-3 w-32 bg-gray-100 rounded animate-pulse" />
          <div className="h-2.5 w-24 bg-gray-100 rounded animate-pulse" />
        </div>
      </div>

      {/* Bolhas */}
      <div className="flex-1 overflow-hidden p-4 space-y-3 bg-[#f0f2f5]">
        {[
          { me: false, w: 'w-48' },
          { me: true,  w: 'w-56' },
          { me: false, w: 'w-40' },
          { me: true,  w: 'w-64' },
          { me: false, w: 'w-52' },
        ].map((b, i) => (
          <div key={i} className={b.me ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`${b.w} h-10 rounded-lg animate-pulse ${b.me ? 'bg-emerald-100' : 'bg-white border border-gray-100'}`} />
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 bg-white px-4 py-3 shrink-0">
        <div className="h-10 bg-gray-100 rounded-lg animate-pulse" />
      </div>
    </div>
  )
}
