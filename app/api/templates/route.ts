import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function countVars(text: string) {
  const matches = text.match(/\{\{(\d+)\}\}/g) || []
  return new Set(matches).size
}

async function requireAdminOrManager() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: me } = await supabase.from('chat_attendants').select('role').eq('id', user.id).single()
  if (!me || (me.role !== 'admin' && me.role !== 'manager')) return null
  return user
}

// ── GET — listar templates (opcionalmente sincronizar status) ─────────────────
export async function GET(req: NextRequest) {
  const user = await requireAdminOrManager()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const inboxId = searchParams.get('inboxId')
  const sync    = searchParams.get('sync') === '1'

  // ── Buscar templates do banco ─────────────────────────────────────────────
  let dbQuery = admin
    .from('chat_wa_templates')
    .select('*, inbox:chat_inboxes(id, name, waba_id)')
    .order('created_at', { ascending: false })

  if (inboxId) (dbQuery as any) = (dbQuery as any).eq('inbox_id', inboxId)

  const { data: templates, error } = await dbQuery
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (!sync) return NextResponse.json({ templates: templates ?? [] })

  // ── Sincronizar: buscar inboxes diretamente (não via join) ─────────────────
  const allInboxIds = [...new Set((templates ?? []).map((t: any) => t.inbox_id).filter(Boolean))]
  if (!allInboxIds.length) return NextResponse.json({ templates: templates ?? [], warning: 'Sem templates para sincronizar' })

  const { data: inboxRows } = await admin
    .from('chat_inboxes')
    .select('id, waba_id, access_token')
    .in('id', allInboxIds)

  const validInboxes = (inboxRows ?? []).filter((i: any) => i.waba_id)

  if (!validInboxes.length) {
    return NextResponse.json({ templates: templates ?? [], warning: 'Nenhum inbox com WABA ID. Configure em Caixas de Entrada.' })
  }

  const syncErrors: string[] = []

  for (const inbox of validInboxes as any[]) {
    try {
      const metaResp = await fetch(
        `https://graph.facebook.com/v20.0/${inbox.waba_id}/message_templates?fields=name,status,id&limit=200`,
        { headers: { Authorization: `Bearer ${inbox.access_token}` } }
      )

      if (!metaResp.ok) {
        const errText = await metaResp.text().catch(() => metaResp.status.toString())
        syncErrors.push(`Inbox ${inbox.id}: ${errText}`)
        continue
      }

      const metaJson = await metaResp.json()
      const metaTemplates: { name: string; status: string; id: string }[] = metaJson.data ?? []

      for (const mt of metaTemplates) {
        await admin
          .from('chat_wa_templates')
          .update({ status: mt.status, wa_id: mt.id, updated_at: new Date().toISOString() })
          .eq('name', mt.name)
          .eq('inbox_id', inbox.id)
      }
    } catch (err) {
      syncErrors.push(String(err))
    }
  }

  // ── Re-fetch após sync (fallback: retornar dados originais se falhar) ───────
  let refetchQuery = admin
    .from('chat_wa_templates')
    .select('*, inbox:chat_inboxes(id, name, waba_id)')
    .order('created_at', { ascending: false })

  if (inboxId) (refetchQuery as any) = (refetchQuery as any).eq('inbox_id', inboxId)

  const { data: synced } = await refetchQuery

  return NextResponse.json({
    templates: synced ?? templates ?? [],
    ...(syncErrors.length ? { syncErrors } : {}),
  })
}

// ── POST — criar template e enviar para Meta ──────────────────────────────────
export async function POST(req: NextRequest) {
  const user = await requireAdminOrManager()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const body = await req.json()
  const {
    inbox_id, name, category, language,
    header_type, header_text,
    body_text, footer_text,
    buttons = [],
    header_examples = [] as string[],
    body_examples   = [] as string[],
  } = body

  if (!inbox_id || !name || !category || !body_text) {
    return NextResponse.json({ error: 'inbox_id, name, category e body_text são obrigatórios' }, { status: 400 })
  }

  // Validar nome (minúsculo, underscores, números)
  if (!/^[a-z0-9_]{1,512}$/.test(name)) {
    return NextResponse.json({ error: 'Nome deve ter apenas letras minúsculas, números e underscores' }, { status: 400 })
  }

  // Buscar inbox com waba_id
  const { data: inbox } = await admin
    .from('chat_inboxes')
    .select('waba_id, access_token')
    .eq('id', inbox_id)
    .single()

  if (!inbox?.waba_id) {
    return NextResponse.json({ error: 'WABA ID não configurado neste inbox. Edite o inbox e adicione o WABA ID.' }, { status: 422 })
  }

  // Montar componentes para Meta API
  const components: any[] = []

  if (header_type && (header_text || header_type !== 'TEXT')) {
    const headerComp: any = { type: 'HEADER', format: header_type }
    if (header_type === 'TEXT') {
      headerComp.text = header_text
      if (header_examples.length) headerComp.example = { header_text: header_examples }
    }
    components.push(headerComp)
  }

  const bodyComp: any = { type: 'BODY', text: body_text }
  if (body_examples.length) {
    bodyComp.example = { body_text: [body_examples] }
  }
  components.push(bodyComp)

  if (footer_text) components.push({ type: 'FOOTER', text: footer_text })

  if (buttons.length) {
    components.push({ type: 'BUTTONS', buttons })
  }

  // Enviar para Meta API
  const metaResp = await fetch(
    `https://graph.facebook.com/v20.0/${inbox.waba_id}/message_templates`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${inbox.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, category, language, components }),
    }
  )

  const metaData = await metaResp.json()

  if (!metaResp.ok) {
    return NextResponse.json(
      { error: metaData?.error?.message || 'Erro ao enviar template para a Meta', meta: metaData },
      { status: 502 }
    )
  }

  // Salvar no banco
  const { data: template, error: dbErr } = await admin
    .from('chat_wa_templates')
    .insert({
      inbox_id,
      name,
      category,
      language,
      status:           metaData.status || 'PENDING',
      wa_id:            metaData.id     || null,
      header_type:      header_type     || null,
      header_text:      header_type === 'TEXT' ? header_text : null,
      body_text,
      footer_text:      footer_text     || null,
      buttons,
      body_var_count:   countVars(body_text),
      header_var_count: header_type === 'TEXT' ? countVars(header_text || '') : 0,
    })
    .select()
    .single()

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })

  return NextResponse.json({ template }, { status: 201 })
}

// ── DELETE — remover template da Meta + banco ─────────────────────────────────
export async function DELETE(req: NextRequest) {
  const user = await requireAdminOrManager()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const { data: tpl } = await admin
    .from('chat_wa_templates')
    .select('name, inbox:chat_inboxes(waba_id, access_token)')
    .eq('id', id)
    .single()

  if (tpl) {
    const inbox = tpl.inbox as any
    if (inbox?.waba_id) {
      // Remover da Meta (não bloqueia se falhar)
      await fetch(
        `https://graph.facebook.com/v20.0/${inbox.waba_id}/message_templates?name=${tpl.name}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${inbox.access_token}` } }
      ).catch(() => {})
    }
  }

  await admin.from('chat_wa_templates').delete().eq('id', id)
  return NextResponse.json({ ok: true })
}
