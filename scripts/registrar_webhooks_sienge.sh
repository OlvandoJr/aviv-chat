#!/bin/bash
# Registra os webhooks de cobrança no Sienge apontando para o receptor n8n
# Rodar quando a quota REST do Sienge estiver disponível
CRED="avivconstrutora-olvando:9l3iHjuk5JdqSl3QmSFdH5S4EYjMQ5CS"
BASE="https://api.sienge.com.br/avivconstrutora/public/api/v1/hooks"
URL="https://bot-evo-n8n.8s2tnz.easypanel.host/webhook/sienge-eventos"

register() {
  echo "→ Registrando evento: $1"
  curl -s -X POST "$BASE" -u "$CRED" -H "Content-Type: application/json" \
    -d "{\"url\":\"$URL\",\"events\":[\"$1\"]}" -w " [HTTP:%{http_code}]\n"
}

# 1. Cobrança escritural confirmada — boleto DISPONÍVEL (hipótese principal p/ Aviv)
register "BOOK_COLLECTION_CONFIRMED"
# 2. Registro de boleto processado — caso usem boleto registrado
register "PAYMENT_SLIP_REGISTERED"
# 3. Pagamento processado — BAIXA do boleto (encerra a régua)
register "RECEIPT_PROCESSED"

echo ""
echo "Webhooks registrados. Listando todos:"
curl -s "$BASE" -u "$CRED" -H "Accept: application/json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for h in d.get('results',[]):
    print(f\"  {h['events']} -> {h['url']}\")
"
