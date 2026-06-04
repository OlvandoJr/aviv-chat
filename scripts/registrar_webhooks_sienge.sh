#!/bin/bash
# Registra os webhooks de cobrança no Sienge apontando para o receptor n8n.
#
# ⚠️ NÃO coloque credenciais neste arquivo. Use variáveis de ambiente:
#   export SIENGE_USER="avivconstrutora-usuario"
#   export SIENGE_PASSWORD="••••••"
#   bash scripts/registrar_webhooks_sienge.sh
#
# Ou inline:  SIENGE_USER=... SIENGE_PASSWORD=... bash scripts/registrar_webhooks_sienge.sh

set -euo pipefail

: "${SIENGE_USER:?defina SIENGE_USER}"
: "${SIENGE_PASSWORD:?defina SIENGE_PASSWORD}"

CRED="${SIENGE_USER}:${SIENGE_PASSWORD}"
BASE="https://api.sienge.com.br/avivconstrutora/public/api/v1/hooks"
URL="https://bot-evo-n8n.8s2tnz.easypanel.host/webhook/sienge-eventos"

register() {
  echo "→ Registrando evento: $1"
  curl -s -X POST "$BASE" -u "$CRED" -H "Content-Type: application/json" \
    -d "{\"url\":\"$URL\",\"events\":[\"$1\"]}" -w " [HTTP:%{http_code}]\n"
}

register "BOOK_COLLECTION_CONFIRMED"   # cobrança escritural confirmada — boleto disponível
register "PAYMENT_SLIP_REGISTERED"     # registro de boleto processado
register "RECEIPT_PROCESSED"           # pagamento/baixa do boleto

echo ""
echo "Webhooks registrados. Listando todos:"
curl -s "$BASE" -u "$CRED" -H "Accept: application/json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for h in d.get('results',[]):
    print(f\"  {h['events']} -> {h['url']}\")
"
