const STYLES: Record<string, string> = {
  GET:    'bg-green-100  text-green-700  border-green-200',
  POST:   'bg-orange-100 text-orange-700 border-orange-200',
  PUT:    'bg-blue-100   text-blue-700   border-blue-200',
  PATCH:  'bg-yellow-100 text-yellow-700 border-yellow-200',
  DELETE: 'bg-red-100    text-red-700    border-red-200',
}

export default function MethodBadge({ method }: { method: string }) {
  const s = STYLES[method] ?? 'bg-gray-100 text-gray-600 border-gray-200'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold font-mono border ${s}`}>
      {method}
    </span>
  )
}
