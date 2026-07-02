// boleto-link — link PÚBLICO do boleto (legado). Mantido para os links já
// enviados (?t=<public_token>). A lógica vive em ../_shared/boleto-resolve.ts
// e também atende ?c=<short_code>. Deploy: --no-verify-jwt (público).
import { resolveBoletoLink } from '../_shared/boleto-resolve.ts'

Deno.serve(resolveBoletoLink)
