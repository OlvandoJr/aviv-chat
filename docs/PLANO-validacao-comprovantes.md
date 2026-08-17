# Plano — Validação de comprovantes em três etapas (Ler → Casar → Decidir)

**Status:** aguardando aprovação. Nada deste plano foi implementado.
**Autor:** Claude, com Olvando · **Data:** 17/08/2026

---

## 1. Por que mudar

Quatro casos reais em duas semanas, cada um expondo uma fraqueza diferente do
pipeline atual (`supabase/functions/process-media/index.ts`):

| Caso | O que aconteceu | Fraqueza exposta |
|---|---|---|
| **Geovana** (05/08) | PDF de imagem → modelo inventou campos → comprovante legítimo recusado 3× | leitura (já corrigido, PR #118) |
| **Dirceu** (06/08) | foto deitada → R$ 598,26 em vez de 599,26 → validação manual por R$ 1 | leitura (já corrigido, PR #120) |
| **Ryan** (07/08) | perguntou "já foi pago?" → bot afirmou "sim, baixa confirmada" com o contexto dizendo "em aberto" | bot afirma o que não sabe (já corrigido, PR #129) |
| **Andréia** (17/08) | mandou agendamento → "isso é o boleto"; mandou comprovante de **julho** → casou com boleto de **agosto**, "valor divergente", boleto de agosto saiu da régua; perguntou a parcela → bot **inventou "003/005"** (era 004) | classificação binária + casamento errado + bot inventa |

As correções até aqui foram pontuais. O plano abaixo ataca a **estrutura**.

### As três fraquezas estruturais

**(A) Classificação binária.** Só existia "comprovante" ou "boleto"; agendamento
não cabia. Já criei a terceira categoria, mas o problema de fundo permanece: o
extrator *decide* a categoria e o código confia. Categoria nova (outro banco,
outro formato) sempre vai cair errado até alguém perceber.

**(B) O documento é casado com "algum boleto do telefone", não com o boleto
certo.** Hoje (`getBoletoEmitido`, L489-524):
- busca por telefone, desempata por valor;
- **o vencimento do comprovante nunca entra** — o próprio prompt instrui o modelo
  a ignorá-lo (`buildSiengeContext`, L654-678);
- **boletos já pagos são excluídos** pela `vw_boleto_chat` (069, L29-30).

Resultado no caso Andréia: comprovante de 20/07 (R$ 591,47, parcela **já paga**)
casou com o único boleto aberto — 20/08 (R$ 603,49) — e o veredito saiu "valor
divergente", quando a verdade era "este comprovante é de outra parcela, que já
consta paga". Pior: `updateBoletoDB` roda **antes do veredito** (L930/L1141) e
marcou o boleto de agosto como `comprovante_recebido`, tirando-o da régua.

**(C) Ler e julgar no mesmo passo.** O modelo extrai os campos *e* dá o veredito
em texto livre; `valueGuardVerdict` (L1012-1042) depois **descarta** esse texto e
substitui por uma de duas frases fixas (100% ou 50%); `receiptNeedsHuman`
(L998-1006) re-parseia a frase por regex; e o `ai-responder` monta a mensagem ao
cliente a partir dessa frase (`analysis.verdict`, L947). Três camadas
interpretando um texto que nem foi escrito para ser interpretado.

Bônus encontrado no mapeamento: `analyzeImage` e `analyzePdf` são **~70%
duplicadas** (gate, lookup, updateBoletoDB, veredito, guard, save, needsHuman,
writeOps — tudo repetido). Qualquer correção hoje tem de ser feita duas vezes.

---

## 2. A estrutura proposta

Três etapas, cada uma com **uma** responsabilidade, sendo que **só a primeira
usa modelo**:

```
 LER (modelo)  ──►  CASAR (código)  ──►  DECIDIR (código)  ──►  ai_analysis estruturado
 extrai campos      acha O boleto        regra × mensagem        (o ai-responder só lê)
```

### 2.1 LER — `extrairDocumento(media) → Extracao`

Já está quase pronto (PDF via `/v1/responses`, foto com rotação, categoria
agendamento). Muda o **contrato de saída**: o modelo devolve fatos, não
julgamento.

```ts
type Extracao = {
  tipo: 'comprovante' | 'agendamento' | 'boleto' | 'outro' | 'ilegivel'
  valor: number | null            // valor PAGO (ou do documento)
  vencimento: string | null       // AAAA-MM-DD, "Data de Vencimento" do papel
  data_pagamento: string | null   // AAAA-MM-DD, data do débito/efetivação
  pagador: string | null
  pagador_doc: string | null      // CPF/CNPJ do pagador (dígitos)
  beneficiario: string | null
  beneficiario_doc: string | null // CNPJ do beneficiário (dígitos)
  autenticacao: string | null     // protocolo / autenticação / E2E
  confianca: 'alta' | 'media' | 'baixa'   // dígito verificador do CPF confere? data plausível?
  bruto: Record<string, unknown>  // o JSON cru, para auditoria
}
```

Uma função só, chamada tanto para imagem quanto para PDF — a diferença fica
**dentro** dela (rotação vs Files API). Fim da duplicação.

### 2.2 CASAR — `casarBoleto(extracao, waId) → Casamento`

**Código, sem modelo.** Procura *todos* os boletos do cliente — **abertos E
pagos** dos últimos 180 dias — e pontua cada um:

| Critério | Peso | Observação |
|---|---|---|
| vencimento igual | 4 | é a chave mais forte: "Data de Vencimento" está em todo comprovante de boleto |
| valor igual (±R$ 0,01) | 3 | |
| CNPJ do beneficiário igual ao do empreendimento | 2 | evita casar com boleto de outro credor |
| valor "próximo" (±5%, juros/multa) | 1 | só desempate |

```ts
type Casamento =
  | { tipo: 'aberto',   boleto: Boleto, score: number }   // achou o boleto e ele está em aberto
  | { tipo: 'ja_pago',  boleto: Boleto, score: number }   // achou, mas já consta pago  ← caso Andréia
  | { tipo: 'ambiguo',  candidatos: Boleto[] }            // 2+ com o mesmo score alto
  | { tipo: 'nenhum' }
```

Regra de aceite: score ≥ 4 (vencimento **ou** valor+CNPJ). Abaixo disso é
`nenhum` — o sistema **não chuta**.

Fontes, na ordem de hoje (emitidos → Sienge → SGL), mas **sem excluir pagos**:
para isso a busca em emitidos deixa de usar `vw_boleto_chat` e consulta
`boletos_emitidos` direto (a view continua existindo para a 2ª via do bot).

### 2.3 DECIDIR — `decidir(extracao, casamento) → Decisao`

Tabela de regras fixa. Cada linha tem: **o que grava**, **se chama humano**, e
**a mensagem** que o bot vai dar (texto pronto, não frase para o modelo
interpretar):

| # | tipo | casamento | baixa | humano | mensagem ao cliente |
|---|---|---|---|---|---|
| 1 | comprovante | aberto, valor exato | ✅ `comprovante_recebido` | não | "Recebi o comprovante da parcela de {venc}, no valor de {valor}. A baixa é confirmada pelo sistema; se precisar de algo mais, estou à disposição." |
| 2 | comprovante | aberto, valor diferente | ❌ | **sim** | "Recebi o comprovante da parcela de {venc}. O valor pago ({pago}) é diferente do valor do boleto ({boleto}) — vou pedir para um atendente conferir." |
| 3 | comprovante | **ja_pago** | ❌ | não | "Esse comprovante é da parcela de {venc}, que **já consta paga** no sistema. A cobrança que enviamos é da parcela de {venc_aberto}, no valor de {valor_aberto}." |
| 4 | comprovante | ambiguo | ❌ | **sim** | "Recebi o comprovante. Você tem mais de um boleto compatível — vou pedir para um atendente identificar." |
| 5 | comprovante | nenhum | ❌ | **sim** | "Recebi o comprovante, mas não localizei o boleto correspondente no seu cadastro. Um atendente vai conferir." |
| 6 | agendamento | qualquer | ❌ | não | "Vi que você agendou o pagamento para {data}. A baixa acontece quando o banco efetivar o débito nessa data — depois disso, se puder me enviar o comprovante definitivo, eu confirmo." |
| 7 | boleto | qualquer | ❌ | não | "Esse arquivo é o boleto (a cobrança), não o comprovante. Se já pagou, me envie o comprovante do pagamento efetivado." |
| 8 | outro / ilegivel | — | ❌ | **sim** | "Não consegui identificar esse documento como comprovante. Um atendente vai dar uma olhada." |
| 9 | comprovante com `confianca: baixa` | qualquer | ❌ | **sim** | mesma da 5, sem afirmar nada sobre o boleto |

O item **3 é o que resolveria a Andréia**. O **9** é a rede para o que a leitura
não conseguiu garantir (o modelo pode ter inventado — não afirmamos nada).

**Baixa só na regra 1** — e só *depois* de decidir. Acaba a marcação prematura.

### 2.4 O que o `ai_analysis` passa a guardar

```ts
{
  extracao:  Extracao,
  casamento: { tipo, boleto_id?, vencimento?, valor?, score? },
  decisao:   { regra: 1..9, baixa: boolean, humano: boolean, mensagem: string },
  versao: 2,
  validated_at
}
```

Estruturado. O `ai-responder` passa a ler `decisao.mensagem` e **entrega esse
texto** (ou parafraseia levemente mantendo os fatos) — não interpreta mais uma
frase de veredito. A view `vw_comprovantes` e o card "Análise do comprovante" no
painel leem os mesmos campos.

Compatibilidade: manter por um período os campos antigos (`verdict`,
`nao_comprovante`, `doc_kind`, `sienge_boleto`) preenchidos a partir da nova
estrutura, para o painel e o `ai-responder` atuais não quebrarem durante a
transição. Remover numa segunda passada.

---

## 3. A parcela ("004/005")

Fato: **o número da parcela que o cliente vê não existe em lugar nenhum da
nossa base.** O boleto da Caixa não o imprime; `boletos_emitidos` guarda só o
`installment_id` interno do Sienge (5, que não é "004"); a `vw_boleto_chat`
entrega "Boleto venc. 20/08/2026". Quando a Andréia perguntou, o bot **inventou**.

Duas partes:

**3.1 Bot não inventa parcela** (imediato, mesmo mecanismo do PR #129): a regra
"só afirme o que está no contexto" já cobre pagamento; estender explicitamente
para número de parcela — se o contexto não traz, o bot diz que vai confirmar.

**3.2 Trazer o número real do Sienge** (dentro deste plano): no
`sienge-webhook` (`PAYMENT_SLIP_REGISTERED`, que já grava `installment_id`) e no
`import-boletos`, buscar `GET /receivable-bills/{id}/installments` **uma vez por
título** e gravar em `boletos_emitidos.parcela_numero` = posição da parcela
ordenada por vencimento entre as **mensais** (excluindo balões/finais por
`conditionTypeId`), e `parcela_total` = quantidade de mensais. Para a Andréia:
título 341 → mensais 1,2,3,4,**5** → "005/005"? — **atenção**: a Beatriz disse
"004/005", então o total pode ser outro. Este é o único ponto do plano que exige
**confirmar com o financeiro** como o Sienge numera (a partir do
`conditionTypeId` das parcelas do título 341 dá para saber). Custo: 1 req por
título novo, ~10-20/mês, dentro da cota.

---

## 4. Ordem de execução

| Passo | Entrega | Risco |
|---|---|---|
| 1 | `_shared/comprovante.ts` com os três tipos + `casarBoleto` + `decidir`, **cobertos por testes** com os 4 casos reais como fixtures (JSON de extração de cada um) | nenhum em produção |
| 2 | Bot não inventa parcela (regra no contexto + trava textual como a de pagamento) | baixo |
| 3 | `process-media` passa a chamar as três etapas; `analyzeImage`/`analyzePdf` viram só a etapa LER; grava `ai_analysis` v2 **+** campos legados | médio — deploy vigiado |
| 4 | `ai-responder` lê `decisao.mensagem` | baixo |
| 5 | `parcela_numero/total` no import + webhook + contexto do bot | baixo, depende do item 3.2 |
| 6 | Limpar campos legados de `ai_analysis`, `vw_comprovantes` e card do painel | baixo |

Passos 1-2 podem sair no mesmo dia. 3-4 no dia seguinte, com verificação. 5-6
depois de estabilizar.

---

## 5. Verificação (antes de considerar pronto)

- **Fixtures dos 4 casos reais** (extração salva em JSON) passam pela tabela de
  regras e caem na linha certa: Geovana → 1; Dirceu → 1 (com rotação); Andréia
  imagem → 6, Andréia PDF → **3**; e um "Ryan" sintético (pergunta, sem
  documento) → nada muda.
- **Nenhuma marcação prematura**: rodar as fixtures e conferir que só a regra 1
  altera `boletos_emitidos.status`.
- **Regressão da leitura**: os PDFs/imagens reais dos 4 casos re-extraídos com o
  contrato novo devolvem os mesmos campos que hoje (valor, vencimento, pagador).
- **Casamento com pago**: comprovante de parcela já paga → `ja_pago`, e o boleto
  aberto **não** é tocado (é exatamente o dano que revertemos hoje).
- Deploy do `process-media` com **um dia de observação** dos `ai_analysis.decisao.regra`
  antes de mexer no `ai-responder`.

---

## 6. O que NÃO está neste plano

- Mudar o critério de valor (exato = 100%, diferente = humano) — mantido.
- Baixa automática no Sienge a partir do comprovante — continua não existindo;
  baixa real vem do `RECEIPT_PROCESSED`.
- Reprocessar comprovantes antigos — só a partir do deploy.
