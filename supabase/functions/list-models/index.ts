const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || ''

// Prefixos de modelos de chat da OpenAI (exclui embeddings, tts, whisper, etc.)
const CHAT_PREFIXES = ['gpt-', 'o1', 'o3', 'o4', 'chatgpt-', 'o2']

Deno.serve(async (req) => {
  // CORS para chamadas do frontend
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers })
  }

  if (!OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: 'OPENAI_API_KEY not configured' }), { status: 500, headers })
  }

  try {
    const resp = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    })

    if (!resp.ok) {
      const err = await resp.text()
      console.error('OpenAI models error:', resp.status, err)
      return new Response(JSON.stringify({ error: 'OpenAI API error', status: resp.status }), { status: 502, headers })
    }

    const data = await resp.json()

    // Filtrar apenas modelos de chat e ordenar
    const models: string[] = (data.data || [])
      .map((m: any) => m.id as string)
      .filter((id: string) => CHAT_PREFIXES.some(p => id.startsWith(p)))
      .sort((a: string, b: string) => {
        // Modelos sem data de versão (aliases como "gpt-4o") ficam primeiro
        const aHasDate = /\d{4}/.test(a)
        const bHasDate = /\d{4}/.test(b)
        if (!aHasDate && bHasDate) return -1
        if (aHasDate && !bHasDate) return 1
        return b.localeCompare(a) // mais recente primeiro
      })

    return new Response(JSON.stringify({ models }), { headers })
  } catch (err) {
    console.error('list-models error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers })
  }
})
