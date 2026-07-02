// b — link PÚBLICO curto do boleto: /functions/v1/b?c=<short_code>.
// Mesma lógica do boleto-link (aceita ?c e ?t). Deploy: --no-verify-jwt (público).
import { resolveBoletoLink } from '../_shared/boleto-resolve.ts'

Deno.serve(resolveBoletoLink)
