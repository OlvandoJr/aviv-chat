// Resolve o link público do boleto — usado pelas edges `boleto-link` (legado,
// ?t=<public_token>) e `b` (curto, ?c=<short_code>). Ambas aceitam os dois
// formatos, então links antigos continuam funcionando.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const html = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Boleto — Aviv Construtora</title>
<body style="font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f0f2f5;margin:0;padding:24px;color:#111">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
${body}
</div></body>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })

function fmtDate(d: string | null) {
  if (!d) return '—'
  const [y, m, dd] = String(d).slice(0, 10).split('-')
  return `${dd}/${m}/${y}`
}
function fmtBRL(v: number | null) {
  if (v == null) return '—'
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v))
}

export async function resolveBoletoLink(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams
  const code  = params.get('c')   // curto (short_code)
  const token = params.get('t')   // legado (public_token)
  if (!code && !token) return html('<h2>Link inválido</h2><p>Token do boleto ausente.</p>', 400)

  const sel = admin.from('boletos_emitidos')
    .select('customer_name, vencimento, valor, linha_digitavel, pdf_path, status, empreendimento')
  const { data: b } = code
    ? await sel.eq('short_code', code).maybeSingle()
    : await sel.eq('public_token', token).maybeSingle()

  if (!b) return html('<h2>Boleto não encontrado</h2><p>O link pode ter expirado ou ser inválido. Fale com a Aviv Construtora.</p>', 404)

  // PDF disponível → redireciona para a signed URL (1h)
  if (b.pdf_path) {
    const { data: signed } = await admin.storage.from('boletos').createSignedUrl(b.pdf_path, 3600)
    if (signed?.signedUrl) return Response.redirect(signed.signedUrl, 302)
  }

  // Sem PDF → página com os dados que temos (linha digitável copiável)
  const ld = (b.linha_digitavel || '').trim()
  return html(`
    <h2 style="margin:0 0 4px">Seu boleto — Aviv Construtora</h2>
    <p style="color:#6b7280;margin:0 0 16px">${b.empreendimento || ''}</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <tr><td style="color:#6b7280;padding:6px 0">Vencimento</td><td style="text-align:right;font-weight:600">${fmtDate(b.vencimento)}</td></tr>
      <tr><td style="color:#6b7280;padding:6px 0">Valor</td><td style="text-align:right;font-weight:600">${fmtBRL(b.valor)}</td></tr>
    </table>
    ${ld ? `<p style="color:#6b7280;margin:16px 0 4px">Linha digitável</p>
    <div style="background:#f3f4f6;border-radius:8px;padding:12px;font-family:ui-monospace,monospace;font-size:14px;word-break:break-all">${ld}</div>` : ''}
    <p style="color:#9ca3af;font-size:13px;margin-top:20px">PDF indisponível no momento — use a linha digitável acima para pagar no app do seu banco.</p>
  `)
}
