'use client'

import React from 'react'
import { COLUMN_LABEL } from '@/lib/whatsapp/vars'

type VarSrc = { type: 'static' | 'column'; value: string; format?: string }
type Mapping = Record<string, VarSrc | undefined>

function tokenLabel(m: VarSrc | undefined): { text: string; kind: 'column' | 'static' | 'empty' } {
  if (!m || !m.value) return { text: '', kind: 'empty' }
  if (m.type === 'static') return { text: m.value, kind: 'static' }
  return { text: COLUMN_LABEL[m.value] || m.value, kind: 'column' }
}

function render(text: string, mapping: Mapping): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const regex = /\{\{(\d+)\}\}/g
  let last = 0, m: RegExpExecArray | null, key = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const n = m[1]
    const info = tokenLabel(mapping[n])
    if (info.kind === 'column') {
      parts.push(<span key={key++} className="inline-block bg-emerald-100 text-emerald-700 rounded px-1 text-[0.9em] font-medium">{info.text}</span>)
    } else if (info.kind === 'static') {
      parts.push(<span key={key++} className="font-medium text-gray-900">{info.text}</span>)
    } else {
      parts.push(<span key={key++} className="inline-block bg-amber-100 text-amber-700 rounded px-1 text-[0.9em]">{`{{${n}}}`}</span>)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

interface Props {
  headerText?: string | null
  bodyText: string
  footerText?: string | null
  mapping: Mapping
}

/** Pré-visualização do template com os {{n}} substituídos pelas colunas/valores mapeados. */
export default function MappedPreview({ headerText, bodyText, footerText, mapping }: Props) {
  return (
    <div className="bg-[#f0f2f5] rounded-lg p-3 space-y-1">
      <p className="text-[10px] text-gray-400 uppercase font-semibold tracking-wide mb-1">Pré-visualização</p>
      {headerText && <p className="text-xs font-semibold text-gray-800">{render(headerText, mapping)}</p>}
      <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{render(bodyText, mapping)}</p>
      {footerText && <p className="text-xs text-gray-400">{footerText}</p>}
    </div>
  )
}
