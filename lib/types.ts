export type ConversationStatus = 'open' | 'resolved' | 'archived'

export interface Inbox {
  id:              string
  name:            string
  description:     string | null
  phone_number:    string
  phone_number_id: string
  access_token:    string
  verify_token:    string
  is_active:       boolean
  created_at:      string
}

export interface Contact {
  id:                  string
  wa_id:               string
  name:                string | null
  profile_picture_url: string | null
  created_at:          string
  updated_at:          string
}

export interface Attendant {
  id:         string
  name:       string
  email:      string
  avatar_url: string | null
  role:       'admin' | 'agent'
  is_active:  boolean
  created_at: string
}

export type HandledBy = 'bot' | 'human' | 'pending_human'

export interface Conversation {
  id:                   string
  inbox_id:             string
  contact_id:           string
  assignee_id:          string | null
  status:               ConversationStatus
  handled_by:           HandledBy
  last_message_at:      string | null
  last_message_preview: string | null
  unread_count:         number
  sector:               string | null
  created_at:           string
  updated_at:           string
  // joins
  contact?:             Contact
  assignee?:            Attendant | null
}

export type MessageType      = 'text' | 'image' | 'audio' | 'document' | 'button' | 'template'
export type MessageDirection = 'in' | 'out'
export type MessageStatus    = 'sent' | 'delivered' | 'read' | 'failed'

export interface Message {
  id:              string
  conversation_id: string
  wa_message_id:   string | null
  direction:       MessageDirection
  type:            MessageType
  content:         string | null
  media_url:       string | null
  media_mime_type: string | null
  media_filename:  string | null
  wa_status:       MessageStatus
  ai_analysis:     AiAnalysis | null
  metadata:        Record<string, any> | null
  attendant_id:    string | null
  created_at:      string
  // join
  attendant?:      Attendant | null
}

export interface AiAnalysis {
  beneficiario:   string | null
  valor:          string | null
  vencimento:     string | null
  data_pagamento: string | null
  pagador:        string | null
  cpf_cnpj:       string | null
  sienge_boleto:  {
    id:        string
    parcela:   string
    valor:     number
    vencimento: string
  } | null
  sienge_status:  'pago' | 'pendente' | null
  validated_at:   string
}

export type AgentModel = string   // Qualquer modelo de chat da OpenAI
export type AgentRuleType = 'tag' | 'keyword' | 'inbox'

export interface Agent {
  id:                   string
  name:                 string
  description:          string | null
  avatar_emoji:         string
  is_active:            boolean
  is_default:           boolean
  model:                AgentModel
  temperature:          number
  max_tokens:           number
  memory_messages:      number
  system_prompt:        string
  greeting_message:     string | null
  off_hours_message:    string | null
  include_boletos:      boolean
  include_contact_info: boolean
  custom_context:       string | null
  escalation_keywords:  string[]
  escalation_message:   string | null
  created_at:           string
  updated_at:           string
  // join
  rules?:               AgentRule[]
}

export interface AgentRule {
  id:         string
  agent_id:   string
  rule_type:  AgentRuleType
  rule_value: string
  priority:   number
  created_at: string
}

// ── Contact Attributes ────────────────────────────────────────────────────────

export type AttributeFieldType = 'cpf_cnpj' | 'email' | 'phone' | 'text' | 'number'
export type AttributeAction    = 'save' | 'save_and_lookup_sienge'

export interface ContactAttributeDef {
  id:            string
  agent_id:      string
  name:          string
  key:           string
  field_type:    AttributeFieldType
  action:        AttributeAction
  capture_regex: string | null
  sort_order:    number
  created_at:    string
}

export interface ContactAttribute {
  id:                          string
  contact_id:                  string
  attribute_key:               string
  attribute_value:             string
  attribute_label:             string | null
  captured_at:                 string
  captured_in_conversation_id: string | null
}

// ── API Configs ───────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type AuthType   = 'none' | 'basic' | 'bearer' | 'api_key' | 'custom_header'
export type BodyType   = 'none' | 'json' | 'form_data' | 'urlencoded'

export interface KVItem {
  id:      string
  key:     string
  value:   string
  enabled: boolean
}

export interface ResponseMappingItem {
  id:            string
  variable_name: string
  json_path:     string
  description:   string
  example?:      string
}

export interface ApiConfig {
  id:               string
  name:             string
  description:      string | null
  method:           HttpMethod
  url:              string
  auth_type:        AuthType
  auth_config:      Record<string, string>
  credential_id:    string | null
  headers:          KVItem[]
  query_params:     KVItem[]
  body_type:        BodyType
  body_template:    string | null
  response_mapping: ResponseMappingItem[]
  is_active:        boolean
  last_tested_at:   string | null
  last_test_status: string | null
  created_at:       string
  updated_at:       string
}

// SGL (mensagens_cobranca) — sem API, apenas leitura da tabela n8n
export interface SglBoleto {
  id:                    number
  pessoanomecompleto:    string | null
  unidadeempreendimento: string | null
  unidadequadraandar:    string | null
  unidadeloteapartamento: string | null
  contasreceberparcela:  string | null
  contasrecebervencimento: string | null   // date as string
  contasrecebervalor:    string | null     // "575,74" — texto BR
  linkboleto:            string | null
  status:                string | null
  created_at:            string | null
}

export interface SiengeBoleto {
  id:                  string
  receivable_bill_id:  number
  installment_id:      number
  customer_phone:      string
  status:              string
  due_date:            string
  amount:              number
  parcela_descricao:   string | null
}
