'use client'

import { Plus, Trash2 } from 'lucide-react'
import type { KVItem } from '@/lib/types'

function uid() { return Math.random().toString(36).slice(2, 11) }

interface Props {
  items:            KVItem[]
  onChange:         (items: KVItem[]) => void
  keyPlaceholder?:  string
  valPlaceholder?:  string
  showVariableHint?: boolean
}

export default function KeyValueEditor({
  items,
  onChange,
  keyPlaceholder  = 'Chave',
  valPlaceholder  = 'Valor',
  showVariableHint = true,
}: Props) {
  function update(id: string, field: keyof KVItem, value: any) {
    onChange(items.map(i => i.id === id ? { ...i, [field]: value } : i))
  }
  function add() {
    onChange([...items, { id: uid(), key: '', value: '', enabled: true }])
  }
  function remove(id: string) {
    onChange(items.filter(i => i.id !== id))
  }

  return (
    <div className="space-y-2">
      {items.map(item => (
        <div key={item.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={item.enabled}
            onChange={e => update(item.id, 'enabled', e.target.checked)}
            className="w-4 h-4 accent-emerald-600 flex-shrink-0"
            title={item.enabled ? 'Desabilitar' : 'Habilitar'}
          />
          <input
            type="text"
            value={item.key}
            onChange={e => update(item.id, 'key', e.target.value)}
            placeholder={keyPlaceholder}
            className="w-36 text-sm px-2.5 py-1.5 border border-gray-200 rounded-lg font-mono
                       focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 bg-white"
          />
          <input
            type="text"
            value={item.value}
            onChange={e => update(item.id, 'value', e.target.value)}
            placeholder={showVariableHint ? `${valPlaceholder}  · {{variables.x}}` : valPlaceholder}
            className="flex-1 text-sm px-2.5 py-1.5 border border-gray-200 rounded-lg font-mono
                       focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 bg-white"
          />
          <button
            type="button"
            onClick={() => remove(item.id)}
            className="p-1.5 text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"
            title="Remover"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1.5 text-sm text-emerald-600 hover:text-emerald-700 font-medium transition-colors"
      >
        <Plus className="w-4 h-4" />
        Adicionar linha
      </button>
    </div>
  )
}
