import React from 'react'

// Renderiza a formatação do WhatsApp como JSX (negrito/itálico/tachado/mono).
// O WhatsApp usa: *negrito*, _itálico_, ~tachado~, ```monoespaçado```.
// Só exibição no painel (o texto cru é mantido no banco e no envio). Seguro:
// devolve nós React (texto escapado), sem dangerouslySetInnerHTML.
const TOKEN = /(```[\s\S]+?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g

export function renderWhatsApp(text: string | null | undefined): React.ReactNode {
  if (!text) return text ?? ''
  const out: React.ReactNode[] = []
  let last = 0, key = 0, m: RegExpExecArray | null
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('```'))     out.push(<code key={key++} className="font-mono text-[0.95em]">{t.slice(3, -3)}</code>)
    else if (t[0] === '*')       out.push(<strong key={key++}>{t.slice(1, -1)}</strong>)
    else if (t[0] === '_')       out.push(<em key={key++}>{t.slice(1, -1)}</em>)
    else                          out.push(<s key={key++}>{t.slice(1, -1)}</s>)
    last = TOKEN.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
