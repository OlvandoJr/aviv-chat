// Cálculo do PRÓXIMO disparo de uma régua para um cliente — espelha a lógica da
// edge `cobranca-regua` e da view `vw_cobranca_boletos.load_dispatch_date` (migration 043).
// Usado na Central de Clientes para mostrar inscrição + próximo disparo.

export interface ReguaStep {
  offset_days: number
  send_time: string        // 'HH:MM[:SS]'
  on_load: boolean
}
export interface CobrancaBoleto {
  source: string | null
  empreendimento: string | null
  due_date: string | null            // 'YYYY-MM-DD'
  load_dispatch_date: string | null  // 'YYYY-MM-DD' (já aplica regra 18h/fim de semana)
}
export interface ReguaLogRow {
  regua_id: string | null
  offset_days: number
  due_date: string | null
}
export interface AudienceFilter { source?: string; empreendimento?: string }

// "agora" em BRT (mesma conversão usada no resto do projeto)
export function brtNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
}

// Próximo dia útil: sábado → segunda (+2), domingo → segunda (+1). Mesma regra do
// catch-up de segunda da régua (a data-alvo que cai no fim de semana sai na segunda).
function proxDiaUtil(d: Date): Date {
  const out = new Date(d)
  const dow = out.getDay()
  if (dow === 6) out.setDate(out.getDate() + 2)
  else if (dow === 0) out.setDate(out.getDate() + 1)
  return out
}

// Monta um Date (BRT, sem fuso) a partir de 'YYYY-MM-DD' + 'HH:MM[:SS]'
function at(dateISO: string, sendTime: string): Date {
  const [y, m, dd] = dateISO.slice(0, 10).split('-').map(Number)
  const [hh, mi] = String(sendTime || '09:00').split(':').map(Number)
  return new Date(y, (m - 1), dd, hh || 0, mi || 0, 0, 0)
}

function norm(s: string | null | undefined): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** O cliente se enquadra na audiência da régua? (mesmo critério da edge cobranca-regua) */
export function matchAudiencia(boletos: CobrancaBoleto[], filter: AudienceFilter): CobrancaBoleto[] {
  const src = filter?.source
  const emp = norm(filter?.empreendimento)
  return boletos.filter((b) => {
    if (src && src !== 'both' && b.source !== src) return false
    if (emp && !norm(b.empreendimento).includes(emp)) return false
    return true
  })
}

/**
 * Próximo disparo (ISO string) da régua para o cliente, considerando carga +
 * offsets de vencimento, pulando o que já foi enviado (log). null se não houver
 * disparo futuro previsto.
 */
export function proximoDisparo(
  boletos: CobrancaBoleto[],
  steps: ReguaStep[],
  reguaId: string,
  log: ReguaLogRow[],
  agora: Date = brtNow(),
): string | null {
  // chave do que já saiu: `${offset_days}|${due_date}` (carga usa sentinela 999)
  const enviados = new Set(
    log.filter((l) => l.regua_id === reguaId).map((l) => `${l.offset_days}|${(l.due_date || '').slice(0, 10)}`),
  )

  const hojeISO = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`

  let melhor: Date | null = null
  for (const b of boletos) {
    for (const s of steps) {
      let alvo: Date | null = null
      let offsetKey = s.offset_days
      if (s.on_load) {
        if (!b.load_dispatch_date) continue
        offsetKey = 999
        const dia = b.load_dispatch_date.slice(0, 10)
        // Carga dispara "a partir de send_time" e fica pendente o dia todo (cron horário).
        // Se a data de carga é hoje e o horário já passou, é IMINENTE (próxima rodada),
        // não algo passado → usa "agora". Datas futuras usam o horário configurado.
        if (dia < hojeISO) alvo = agora                                  // atrasada → próxima rodada
        else { alvo = at(dia, s.send_time); if (dia === hojeISO && alvo.getTime() < agora.getTime()) alvo = agora }
      } else {
        if (!b.due_date) continue
        // disparo = vencimento + offset_days (offset −3 = 3 dias ANTES do venc); mesma
        // convenção da edge cobranca-regua (targetDue = hoje − offset ⇒ dia = venc + offset).
        const base = at(b.due_date, s.send_time)
        base.setDate(base.getDate() + (s.offset_days || 0))
        alvo = proxDiaUtil(base)
        if (alvo.getTime() < agora.getTime()) continue                   // offset passado não é re-enviado
      }
      if (!alvo) continue
      if (enviados.has(`${offsetKey}|${(b.due_date || '').slice(0, 10)}`)) continue  // já enviado
      if (!melhor || alvo.getTime() < melhor.getTime()) melhor = alvo
    }
  }
  // Formata pelos getters LOCAIS (os Date foram montados com números BRT em tz local):
  // evita o deslocamento de fuso que toISOString/toLocaleString causaria em prod (UTC).
  if (!melhor) return null
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(melhor.getDate())}/${p2(melhor.getMonth() + 1)}/${melhor.getFullYear()} ${p2(melhor.getHours())}:${p2(melhor.getMinutes())}`
}
