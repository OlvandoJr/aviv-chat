export type ConversationStatus = 'open' | 'resolved' | 'archived'

export interface Inbox {
  id:              string
  name:            string
  description:     string | null
  phone_number:    string
  phone_number_id: string
  access_token:    string
  verify_token:    string
  waba_id:         string | null
  is_active:       boolean
  created_at:      string
}

export type WaTemplateStatus   = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED'
export type WaTemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'
export type WaTemplateHeaderType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'

export interface WaTemplateButton {
  type:         'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'
  text:         string
  url?:         string
  phone_number?: string
}

export interface WaTemplate {
  id:               string
  inbox_id:         string
  name:             string
  category:         WaTemplateCategory
  language:         string
  status:           WaTemplateStatus
  wa_id:            string | null
  header_type:      WaTemplateHeaderType | null
  header_text:      string | null
  body_text:        string
  footer_text:      string | null
  buttons:          WaTemplateButton[]
  body_var_count:   number
  header_var_count: number
  rejection_reason: string | null
  created_at:       string
  updated_at:       string
  // join
  inbox?:           Pick<Inbox, 'id' | 'name' | 'waba_id'>
}

export interface Contact {
  id:                  string
  wa_id:               string
  name:                string | null
  profile_picture_url: string | null
  created_at:          string
  updated_at:          string
}

export type AttendantRole   = 'admin' | 'manager' | 'agent'
export type AttendantSector =
  | 'Financeiro' | 'Contabilidade' | 'Fiscal'
  | 'Comercial/Marketing' | 'Engenharia' | 'Arquitetura'

export const ATTENDANT_SECTORS: AttendantSector[] = [
  'Financeiro', 'Contabilidade', 'Fiscal',
  'Comercial/Marketing', 'Engenharia', 'Arquitetura',
]

export interface Attendant {
  id:         string
  name:       string
  email:      string
  avatar_url: string | null
  role:       AttendantRole
  sector?:    string | null
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

export type MessageType      = 'text' | 'image' | 'audio' | 'voice' | 'document' | 'video' | 'sticker' | 'button' | 'template' | 'reaction' | 'location' | 'contacts' | 'unknown'
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
  escalation_rules:     string | null
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

// ── Agent Tools & Integrations ────────────────────────────────────────────────

export type ToolType = 'payment_scheduler' | 'webhook'

export interface AgentTool {
  id:                string
  agent_id:          string
  name:              string
  description:       string
  tool_type:         ToolType
  config:            Record<string, any>
  api_connection_id: string | null
  is_active:         boolean
  sort_order:        number
  created_at:        string
  // join
  api_connection?:   ApiConnection | null
}

export type ConnectionProvider = 'google_calendar' | 'smtp' | 'webhook' | 'supabase_db'

export interface ApiConnection {
  id:          string
  name:        string
  provider:    ConnectionProvider
  credentials: Record<string, any>   // service account JSON, etc.
  config:      Record<string, any>   // calendar_id, etc.
  is_active:   boolean
  created_at:  string
  updated_at:  string
}

export interface ScheduledPayment {
  id:                       string
  conversation_id:          string | null
  contact_id:               string | null
  contact_name:             string | null
  contact_wa_id:            string | null
  scheduled_date:           string   // YYYY-MM-DD
  boleto_parcela:           string | null
  boleto_valor:             number | null
  google_event_id:          string | null
  status:                   string
  reminder_day_before_sent: boolean
  reminder_1h_before_sent:  boolean
  notes:                    string | null
  created_at:               string
}

// ── Subagentes ────────────────────────────────────────────────────────────────

export type SubagentTrigger = 'image' | 'document' | 'audio' | 'text'

export interface Subagent {
  id:                string
  agent_id:          string
  name:              string
  trigger_type:      SubagentTrigger
  extraction_prompt: string | null
  extraction_model:  string
  instructions:      string
  output_format:     string
  model:             string
  is_active:         boolean
  sort_order:        number
  created_at:        string
  // join
  datasources?:      SubagentDatasource[]
}

export interface SubagentDatasource {
  id:                 string
  subagent_id:        string
  connection_id:      string | null
  name:               string
  table_name:         string
  filter_column:      string | null
  filter_template:    string | null
  columns:            string
  max_rows:           number
  output_placeholder: string
  sort_order:         number
}

// ── Campos de Atualização de Conversa ────────────────────────────────────────

export type UpdateFieldType = 'text' | 'select' | 'number' | 'boolean'

export interface ConversationUpdateDef {
  id:          string
  agent_id:    string
  name:        string
  key:         string
  field_type:  UpdateFieldType
  options:     string[]
  description: string
  sort_order:  number
  created_at:  string
}

// ── SGL (mensagens_cobranca) — sem API, apenas leitura da tabela n8n
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
