'use client'

import { useState } from 'react'
import { Plus, Check, ChevronRight, ChevronDown } from 'lucide-react'
import type { ResponseMappingItem } from '@/lib/types'

function uid() { return Math.random().toString(36).slice(2, 11) }

interface Props {
  data:       any
  mappings:   ResponseMappingItem[]
  onAdd:      (item: ResponseMappingItem) => void
}

export default function JsonMappingTree({ data, mappings, onAdd }: Props) {
  return (
    <div className="font-mono text-sm leading-6 select-none">
      <JsonNode data={data} path="" depth={0} mappings={mappings} onAdd={onAdd} />
    </div>
  )
}

// ─── Recursive node ──────────────────────────────────────────────────────────
function JsonNode({
  data, path, depth, mappings, onAdd,
}: {
  data:     any
  path:     string
  depth:    number
  mappings: ResponseMappingItem[]
  onAdd:    (item: ResponseMappingItem) => void
}) {
  const [collapsed, setCollapsed]     = useState(depth >= 2)
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [varName, setVarName]         = useState('')

  const pl = depth * 14

  if (data === null || data === undefined) {
    return <span className="text-gray-400 italic">null</span>
  }

  // ── Array ──────────────────────────────────────────────────────────────────
  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-gray-400">{'[]'}</span>
    return (
      <span>
        <CollapseBtn collapsed={collapsed} onClick={() => setCollapsed(v => !v)} />
        {collapsed
          ? <span className="text-gray-400 ml-1 cursor-pointer" onClick={() => setCollapsed(false)}>
              [{data.length} items]
            </span>
          : (
            <span>
              <span className="text-gray-400"> [</span>
              <div style={{ paddingLeft: pl + 14 }}>
                {data.slice(0, 8).map((item, i) => (
                  <div key={i} className="flex items-start gap-1">
                    <span className="text-gray-300 w-4 text-right flex-shrink-0">{i}</span>
                    <span className="text-gray-400 flex-shrink-0">:</span>
                    <JsonNode data={item} path={`${path}[${i}]`} depth={depth + 1} mappings={mappings} onAdd={onAdd} />
                    {i < Math.min(data.length - 1, 7) && <span className="text-gray-400">,</span>}
                  </div>
                ))}
                {data.length > 8 && <div className="text-gray-400 text-xs">…{data.length - 8} mais</div>}
              </div>
              <span className="text-gray-400">]</span>
            </span>
          )
        }
      </span>
    )
  }

  // ── Object ─────────────────────────────────────────────────────────────────
  if (typeof data === 'object') {
    const entries = Object.entries(data)
    if (entries.length === 0) return <span className="text-gray-400">{'{}'}</span>
    return (
      <span>
        <CollapseBtn collapsed={collapsed} onClick={() => setCollapsed(v => !v)} />
        {collapsed
          ? <span className="text-gray-400 ml-1 cursor-pointer" onClick={() => setCollapsed(false)}>
              {'{…}'}
            </span>
          : (
            <span>
              <span className="text-gray-400"> {'{'}</span>
              <div style={{ paddingLeft: pl + 14 }}>
                {entries.map(([key, value], i) => (
                  <div key={key} className="flex items-start gap-1 flex-wrap min-w-0">
                    <span className="text-blue-500 flex-shrink-0">"{key}"</span>
                    <span className="text-gray-400 flex-shrink-0">:</span>
                    <JsonNode
                      data={value}
                      path={path ? `${path}.${key}` : key}
                      depth={depth + 1}
                      mappings={mappings}
                      onAdd={onAdd}
                    />
                    {i < entries.length - 1 && <span className="text-gray-400">,</span>}
                  </div>
                ))}
              </div>
              <span className="text-gray-400">{'}'}</span>
            </span>
          )
        }
      </span>
    )
  }

  // ── Primitive (clickable leaf) ─────────────────────────────────────────────
  const currentPath = path
  const alreadyMapped = mappings.some(m => m.json_path === currentPath)

  const valueStyle =
    typeof data === 'string'  ? 'text-green-600' :
    typeof data === 'number'  ? 'text-blue-500'  :
    typeof data === 'boolean' ? 'text-purple-600' : 'text-gray-500'

  function confirmMap() {
    if (varName.trim()) {
      onAdd({ id: uid(), variable_name: varName.trim(), json_path: currentPath, description: '', example: String(data) })
      setVarName('')
      setPendingPath(null)
    }
  }

  return (
    <span className="inline-flex items-center gap-1 group">
      <span className={valueStyle}>{JSON.stringify(data)}</span>

      {alreadyMapped && (
        <span title="Já mapeado" className="text-emerald-500">
          <Check className="w-3 h-3 inline" />
        </span>
      )}

      {!alreadyMapped && pendingPath !== currentPath && (
        <button
          type="button"
          onClick={() => setPendingPath(currentPath)}
          title="Mapear para variável"
          className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-300 hover:text-emerald-500 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}

      {pendingPath === currentPath && (
        <span className="inline-flex items-center gap-1 ml-1">
          <input
            type="text"
            value={varName}
            onChange={e => setVarName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter')  confirmMap()
              if (e.key === 'Escape') { setPendingPath(null); setVarName('') }
            }}
            placeholder="nome_variavel"
            autoFocus
            className="w-36 text-xs px-2 py-0.5 border border-emerald-400 rounded bg-emerald-50
                       focus:outline-none focus:ring-1 focus:ring-emerald-300"
          />
          <button
            type="button"
            onClick={confirmMap}
            className="p-0.5 text-emerald-600 hover:text-emerald-700"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        </span>
      )}
    </span>
  )
}

function CollapseBtn({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-gray-400 hover:text-gray-600 align-middle inline-flex items-center"
    >
      {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
    </button>
  )
}
