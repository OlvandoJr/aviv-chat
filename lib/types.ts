export type ConversationStatus = 'open' | 'resolved' | 'archived'

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
