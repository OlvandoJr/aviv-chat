/**
 * Telefone — os dois formatos que o sistema usa, num lugar só.
 *
 * O projeto tem DOIS formatos canônicos e eles NÃO são intercambiáveis:
 *  • `wa_id`      = 55 + DDD + 9 + 8 dígitos  → chave de `chat_contacts` (WhatsApp)
 *  • `phone_norm` = DDD + 8 dígitos (sem DDI, sem o 9) → chave do ERP/SGL e da
 *    `vw_central_clientes` (função SQL `normalize_phone`)
 *
 * Estas funções espelham, respectivamente, `normalizeWaId` de
 * supabase/functions/_shared/whatsapp.ts e a `normalize_phone` do banco. Se um dia
 * divergirem, o cliente do WhatsApp deixa de casar com o cadastro do Sienge — por
 * isso a bateria de comparação no teste vale mais do que parece.
 */

/** 55 + DDD + 9 + 8 dígitos. Formato de `chat_contacts.wa_id`. */
export function normalizeWaId(raw: string): string {
  let d = String(raw || '').replace(/\D/g, '')
  if (!d) return ''
  // Tronco à esquerda ANTES do resto. A versão Deno só tira o 0 depois do 55, o
  // que basta para números vindos da Meta/ERP; aqui o número é DIGITADO À MÃO e
  // "0 43 9..." é comum — sem isto viraria um wa_id inválido e um contato órfão.
  if (d.startsWith('0')) d = d.replace(/^0+/, '')
  if (d.length === 10 || d.length === 11) d = '55' + d                        // veio sem DDI
  if (d.startsWith('55') && d.length >= 3 && d[2] === '0') d = '55' + d.slice(3)  // 0 de tronco
  if (d.startsWith('55') && d.length === 12) {
    const ddd = d.slice(2, 4)
    const num = d.slice(4)                                                    // 8 dígitos
    if (/^[6-9]/.test(num)) d = '55' + ddd + '9' + num                        // celular sem o 9
  }
  return d
}

/** DDD + 8 dígitos, sem DDI e sem o 9. Chave da Central e do ERP. */
export function phoneNorm(raw: string): string {
  let d = String(raw || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  if (d.length >= 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3)          // tira o 9
  return d.slice(-10)
}

/**
 * Celular brasileiro plausível. Não tenta adivinhar se a linha existe — só evita
 * que um número obviamente truncado vire contato e some no meio da lista.
 */
export function telefoneValido(raw: string): boolean {
  const wa = normalizeWaId(raw)
  // Aceita celular (55+DDD+9+8) e fixo (55+DDD+8) — WhatsApp Business existe em
  // linha fixa, e barrar um número legítimo é pior do que deixar a Meta recusar
  // no envio, que agora aparece com motivo na tela.
  if (!/^55\d{10,11}$/.test(wa)) return false
  const ddd = Number(wa.slice(2, 4))
  return ddd >= 11 && ddd <= 99
}

/** Exibição: (43) 99999-9999 */
export function formatBrPhone(raw: string): string {
  const d = String(raw || '').replace(/\D/g, '')
  const local = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`
  return raw || ''
}

/** Máscara progressiva enquanto o usuário digita. */
export function mascaraTelefone(raw: string): string {
  const d = String(raw || '').replace(/\D/g, '').slice(0, 11)
  if (d.length <= 2) return d
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
}
