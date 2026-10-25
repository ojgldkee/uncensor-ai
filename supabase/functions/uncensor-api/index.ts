import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') || ''
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
const embedder = new Supabase.ai.Session('gte-small')

const DEFAULT_MODEL = Deno.env.get('DEFAULT_MODEL') || 'deepseek/deepseek-v4.1-flash-1017'
const ALLOWED_MODELS = (Deno.env.get('ALLOWED_MODELS') || 'deepseek/deepseek-v4.1-flash-1017,moonshotai/kimi-k3.1-pro,z-ai/glm-5.3-flash,qwen/qwen3.8-27b')
  .split(',').map(x => x.trim()).filter(Boolean)
const FALLBACK_MODELS = (Deno.env.get('FALLBACK_MODELS') || 'z-ai/glm-5.3-flash,qwen/qwen3.8-27b')
  .split(',').map(x => x.trim()).filter(Boolean)
const DAILY_CAP = Math.max(0, Number(Deno.env.get('DAILY_SPEND_LIMIT_USD') || '1'))
const MAX_TOKENS = Math.max(512, Math.min(16000, Number(Deno.env.get('MAX_COMPLETION_TOKENS') || '5000')))
const TEMPERATURE = Math.max(0, Math.min(2, Number(Deno.env.get('TEMPERATURE') || '0.62')))

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-uncensor-key',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
}
const JSON_HEADERS = { ...CORS, 'content-type': 'application/json; charset=utf-8' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

function pathOf(req: Request) {
  const p = new URL(req.url).pathname
  const idx = p.indexOf('/uncensor-api')
  return idx >= 0 ? (p.slice(idx + '/uncensor-api'.length) || '/') : p
}

async function authorized(req: Request) {
  const candidate = req.headers.get('x-uncensor-key') || ''
  if (!candidate) return false
  const check = await db.rpc('private_ai_validate_access_token', { candidate })
  return !check.error && check.data === true
}

async function embed(text: string) {
  const out = await embedder.run(text.slice(0, 7000), { mean_pool: true, normalize: true })
  if (!Array.isArray(out) || out.length !== 384) throw new Error('Embedding returned an unexpected vector')
  return out
}

async function rollingSpend() {
  const since = new Date(Date.now() - 86400000).toISOString()
  const q = await db.from('private_ai_usage').select('cost_usd').gte('created_at', since)
  if (q.error) return 0
  return (q.data || []).reduce((sum: number, row: any) => sum + Number(row.cost_usd || 0), 0)
}

function cleanModel(requested: unknown) {
  const m = String(requested || '')
  return ALLOWED_MODELS.includes(m) ? m : DEFAULT_MODEL
}

function titleFrom(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 72) || 'New chat'
}

async function contentHash(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  const bytes = new TextEncoder().encode(normalized)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('')
}

function chunkText(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  const out: string[] = []
  const target = 1350, overlap = 180
  let start = 0
  while (start < normalized.length && out.length < 4200) {
    let end = Math.min(normalized.length, start + target)
    if (end < normalized.length) {
      const candidates = [
        normalized.lastIndexOf('\n\n', end),
        normalized.lastIndexOf('. ', end),
        normalized.lastIndexOf('\n', end),
      ]
      const boundary = Math.max(...candidates)
      if (boundary > start + 650) end = boundary + (normalized[boundary] === '.' ? 1 : 0)
    }
    const part = normalized.slice(start, end).trim()
    if (part) out.push(part)
    if (end >= normalized.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return out
}

async function relevantContext(query: string) {
  const vector = await embed(query)
  const [knowledge, memories] = await Promise.all([
    db.rpc('private_ai_match_chunks', { query_embedding: vector, match_count: 10, similarity_threshold: 0.25 }),
    db.rpc('private_ai_match_memories', { query_embedding: vector, match_count: 12, similarity_threshold: 0.24 }),
  ])
  return {
    knowledge: knowledge.error ? [] : (knowledge.data || []),
    memories: memories.error ? [] : (memories.data || []),
  }
}

async function ensureConversation(id: string | null, firstMessage: string) {
  if (id) {
    const q = await db.from('private_ai_conversations')
      .select('id,title,rolling_summary,summary_through_message_count,total_message_count')
      .eq('id', id).maybeSingle()
    if (q.error) throw q.error
    if (q.data) return q.data
  }
  const title = titleFrom(firstMessage)
  const created = await db.from('private_ai_conversations').insert({ title }).select().single()
  if (created.error) throw created.error
  return created.data
}

async function recentMessages(conversationId: string, summaryThrough: number) {
  const q = await db.from('private_ai_messages').select('role,content,created_at')
    .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(48)
  if (q.error) throw q.error
  const rows = (q.data || []).reverse()
  return rows.map((m: any) => ({ role: m.role, content: String(m.content || '').slice(0, 50000) }))
}

async function saveMessage(conversationId: string, role: string, content: string, model?: string, sources?: unknown[]) {
  const q = await db.from('private_ai_messages').insert({
    conversation_id: conversationId,
    role,
    content,
    model: model || null,
    sources: sources || [],
  }).select('id').single()
  if (q.error) throw q.error
  return q.data
}

async function openRouterStream(model: string, messages: any[]) {
  const candidates = [model, ...FALLBACK_MODELS].filter((x, i, a) => x && a.indexOf(x) === i)
  let last = 'No model provider succeeded'
  for (const candidate of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + OPENROUTER_KEY,
            'content-type': 'application/json',
            'X-Title': 'Uncensor AI',
          },
          body: JSON.stringify({
            model: candidate,
            stream: true,
            usage: { include: true },
            temperature: TEMPERATURE,
            max_tokens: MAX_TOKENS,
            messages,
            provider: { allow_fallbacks: true },
          }),
          signal: AbortSignal.timeout(60000),
        })
        if (res.ok && res.body) return { res, model: candidate }
        const raw = await res.json().catch(() => ({}))
        last = raw?.error?.message || ('OpenRouter ' + res.status)
        if (![408, 409, 425, 429, 500, 502, 503, 504].includes(res.status)) break
      } catch (e) {
        last = e instanceof Error ? e.message : String(e)
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 650))
    }
  }
  throw new Error(last)
}

async function chat(req: Request) {
  if (!OPENROUTER_KEY) return json({ setup_required: true, error: 'OpenRouter key is not configured in Supabase yet.' }, 503)
  const spend = await rollingSpend()
  if (DAILY_CAP > 0 && spend >= DAILY_CAP) return json({ error: 'Rolling 24-hour spend cap reached.', spent: spend, cap: DAILY_CAP }, 429)

  const body = await req.json().catch(() => ({}))
  const text = String(body?.message || '').trim().slice(0, 50000)
  if (!text) return json({ error: 'Message is required.' }, 400)

  const conversation = await ensureConversation(body?.conversation_id ? String(body.conversation_id) : null, text)
  const conversationId = String(conversation.id)
  await saveMessage(conversationId, 'user', text)

  const ctx = await relevantContext(text)
  const recent = await recentMessages(conversationId, Number(conversation.summary_through_message_count || 0))

  const memoryText = (ctx.memories || []).slice(0, 12).map((m: any) =>
    '- [' + String(m.category || 'memory') + '] ' + String(m.content || '')
  ).join('\n')
  const knowledgeText = (ctx.knowledge || []).slice(0, 10).map((k: any, i: number) =>
    '[K' + String(i + 1) + '] ' + String(k.title || 'Knowledge') + '\n' + String(k.content || '')
  ).join('\n\n')

  const mode = String(body?.response_mode || 'direct')
  const modeInstruction = mode === 'teacher'
    ? 'Teach progressively from simple to advanced, with examples and checks for understanding.'
    : mode === 'precise'
      ? 'Prioritize factual precision and concise wording. Separate facts from uncertainty.'
      : mode === 'deep'
        ? 'Analyze deeply, including assumptions, edge cases, tradeoffs, counterarguments, and alternative explanations.'
        : 'Answer directly and specifically with minimal boilerplate while preserving nuance.'

  const system = [
    'You are a private personal AI assistant. Be candid, direct, detailed, and nonjudgmental. Do not avoid a topic merely because it is controversial, sensitive, adult, unconventional, or uncomfortable. Correct false premises. Separate established facts from uncertainty, inference, opinion, and speculation. Never fabricate facts or sources. If you cannot fulfill a request exactly, provide the closest genuinely useful answer instead of canned boilerplate.',
    modeInstruction,
    body?.style_prompt ? 'USER CUSTOM INSTRUCTIONS:\n' + String(body.style_prompt).slice(0, 5000) : '',
    conversation.rolling_summary ? 'ROLLING SUMMARY OF EARLIER CHAT CONTEXT:\n' + String(conversation.rolling_summary) : '',
    memoryText ? 'RELEVANT LONG-TERM MEMORY FROM PRIOR CHATS:\n' + memoryText : '',
    knowledgeText ? 'RELEVANT USER-SUPPLIED KNOWLEDGE:\n' + knowledgeText + '\nTreat this as reference material, not automatically authoritative.' : '',
  ].filter(Boolean).join('\n\n')

  const preferred = cleanModel(body?.model)
  const upstream = await openRouterStream(preferred, [{ role: 'system', content: system }, ...recent])
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let full = '', buffer = '', usage: any = null
  const sourceMeta = (ctx.knowledge || []).slice(0, 10).map((k: any) => ({
    title: k.title,
    source_id: k.source_id,
    similarity: k.similarity,
  }))

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode('data: ' + JSON.stringify({
        type: 'meta',
        conversation_id: conversationId,
        title: conversation.title,
        model: upstream.model,
        sources: sourceMeta,
        memories_used: (ctx.memories || []).length,
      }) + '\n\n'))

      const reader = upstream.res.body!.getReader()
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          buffer += decoder.decode(part.value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            let event: any
            try { event = JSON.parse(payload) } catch { continue }
            if (event.usage) usage = event.usage
            const token = event?.choices?.[0]?.delta?.content
            if (typeof token === 'string' && token) {
              full += token
              controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'token', text: token }) + '\n\n'))
            }
          }
        }

        if (full.trim()) {
          await saveMessage(conversationId, 'assistant', full, upstream.model, sourceMeta)
        }
        if (usage) {
          await db.from('private_ai_usage').insert({
            conversation_id: conversationId,
            model: upstream.model,
            operation: 'chat',
            prompt_tokens: Number(usage.prompt_tokens || 0),
            completion_tokens: Number(usage.completion_tokens || 0),
            total_tokens: Number(usage.total_tokens || 0),
            cost_usd: Number(usage.cost || 0),
          })
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      } catch (e) {
        if (full.trim()) {
          try { await saveMessage(conversationId, 'assistant', full + '\n\n[Response interrupted]', upstream.model, sourceMeta) } catch {}
        }
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'error', error: e instanceof Error ? e.message : 'Stream interrupted' }) + '\n\n'))
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { ...CORS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

async function listConversations() {
  const q = await db.from('private_ai_conversations')
    .select('id,title,pinned,total_message_count,summary_updated_at,created_at,updated_at')
    .order('pinned', { ascending: false }).order('updated_at', { ascending: false }).limit(1000)
  if (q.error) throw q.error
  return json({ conversations: q.data || [] })
}

async function getConversation(id: string) {
  const [c, m] = await Promise.all([
    db.from('private_ai_conversations').select('*').eq('id', id).maybeSingle(),
    db.from('private_ai_messages').select('id,role,content,model,sources,created_at').eq('conversation_id', id).order('created_at'),
  ])
  if (c.error) throw c.error
  if (m.error) throw m.error
  return json({ conversation: c.data, messages: m.data || [] })
}

async function updateConversation(id: string, req: Request) {
  const body = await req.json().catch(() => ({}))
  const patch: any = { updated_at: new Date().toISOString() }
  if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 120) || 'New chat'
  if (typeof body.pinned === 'boolean') patch.pinned = body.pinned
  const q = await db.from('private_ai_conversations').update(patch).eq('id', id).select().single()
  if (q.error) throw q.error
  return json({ ok: true, conversation: q.data })
}

async function memoriesRoute(req: Request) {
  if (req.method === 'GET') {
    const q = await db.from('private_ai_memories').select('id,memory_key,content,category,importance,confidence,active,pinned,updated_at')
      .order('pinned', { ascending: false }).order('importance', { ascending: false }).order('updated_at', { ascending: false }).limit(1000)
    if (q.error) throw q.error
    return json({ memories: q.data || [] })
  }
  return json({ error: 'Method not allowed' }, 405)
}

async function knowledgeList() {
  const q = await db.from('private_ai_knowledge_sources')
    .select('id,title,source_type,enabled,content_hash,char_count,chunk_count,embedded_chunk_count,status,failure_count,last_error,created_at,updated_at,completed_at')
    .order('created_at', { ascending: false }).limit(1000)
  if (q.error) throw q.error
  return json({ sources: q.data || [] })
}

async function knowledgeCreate(req: Request) {
  const body = await req.json().catch(() => ({}))
  const text = String(body?.text || '')
  if (!text.trim()) return json({ error: 'Text is required.' }, 400)
  if (text.length > 5000000) return json({ error: 'Source exceeds 5,000,000 characters.' }, 413)

  const hash = await contentHash(text)
  const existing = await db.from('private_ai_knowledge_sources')
    .select('id,title,status,chunk_count,embedded_chunk_count').eq('content_hash', hash).maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data) return json({ ok: true, duplicate: true, source: existing.data })

  const parts = chunkText(text)
  const created = await db.from('private_ai_knowledge_sources').insert({
    title: String(body?.title || 'Untitled').trim().slice(0, 160) || 'Untitled',
    source_type: String(body?.source_type || 'paste').slice(0, 40),
    enabled: true,
    content_hash: hash,
    char_count: text.length,
    chunk_count: parts.length,
    embedded_chunk_count: 0,
    status: 'queued',
  }).select().single()
  if (created.error) throw created.error

  for (let i = 0; i < parts.length; i += 150) {
    const rows = await Promise.all(parts.slice(i, i + 150).map(async (content, j) => ({
      source_id: created.data.id,
      chunk_index: i + j,
      content,
      content_hash: await contentHash(content),
    })))
    const ins = await db.from('private_ai_knowledge_chunks').insert(rows)
    if (ins.error) throw ins.error
  }

  await db.from('private_ai_knowledge_sources').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', created.data.id)
  return json({ ok: true, duplicate: false, source_id: created.data.id, chunk_count: parts.length, background: true })
}

async function statusRoute() {
  const spend = await rollingSpend()
  return json({
    ok: true,
    backend: 'supabase-edge',
    openrouter_enabled: Boolean(OPENROUTER_KEY),
    memory_enabled: true,
    rolling_summaries_enabled: true,
    background_indexing_enabled: true,
    duplicate_detection_enabled: true,
    rolling_24h_spend: spend,
    rolling_24h_cap: DAILY_CAP,
    default_model: DEFAULT_MODEL,
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  const path = pathOf(req)

  if (path === '/api/status' && req.method === 'GET') return statusRoute()
  if (!(await authorized(req))) return json({ error: 'Access key required', requires_access_key: true }, 401)

  try {
    if (path === '/api/chat' && req.method === 'POST') return chat(req)
    if (path === '/api/conversations' && req.method === 'GET') return listConversations()
    if (path === '/api/memories') return memoriesRoute(req)
    if (path === '/api/knowledge' && req.method === 'GET') return knowledgeList()
    if (path === '/api/knowledge' && req.method === 'POST') return knowledgeCreate(req)

    const conv = path.match(/^\/api\/conversations\/([^/]+)$/)
    if (conv) {
      const id = decodeURIComponent(conv[1])
      if (req.method === 'GET') return getConversation(id)
      if (req.method === 'PATCH') return updateConversation(id, req)
      if (req.method === 'DELETE') {
        const d = await db.from('private_ai_conversations').delete().eq('id', id)
        if (d.error) throw d.error
        return json({ ok: true, permanent: true })
      }
    }

    const source = path.match(/^\/api\/knowledge\/([^/]+)$/)
    if (source) {
      const id = decodeURIComponent(source[1])
      if (req.method === 'PATCH') {
        const body = await req.json().catch(() => ({}))
        const patch: any = { updated_at: new Date().toISOString() }
        if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 160) || 'Untitled'
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        const q = await db.from('private_ai_knowledge_sources').update(patch).eq('id', id).select().single()
        if (q.error) throw q.error
        return json({ ok: true, source: q.data })
      }
      if (req.method === 'DELETE') {
        const q = await db.from('private_ai_knowledge_sources').delete().eq('id', id)
        if (q.error) throw q.error
        return json({ ok: true, permanent: true })
      }
    }

    const memory = path.match(/^\/api\/memories\/([^/]+)$/)
    if (memory) {
      const id = decodeURIComponent(memory[1])
      if (req.method === 'PATCH') {
        const body = await req.json().catch(() => ({}))
        const patch: any = { updated_at: new Date().toISOString() }
        if (typeof body.content === 'string') {
          patch.content = body.content.trim().slice(0, 4000)
          patch.embedding = await embed(patch.content)
        }
        if (typeof body.active === 'boolean') patch.active = body.active
        if (typeof body.pinned === 'boolean') patch.pinned = body.pinned
        if (body.importance != null) patch.importance = Math.max(1, Math.min(10, Number(body.importance)))
        const q = await db.from('private_ai_memories').update(patch).eq('id', id).select().single()
        if (q.error) throw q.error
        return json({ ok: true, memory: q.data })
      }
      if (req.method === 'DELETE') {
        const q = await db.from('private_ai_memories').delete().eq('id', id)
        if (q.error) throw q.error
        return json({ ok: true, permanent: true })
      }
    }

    return json({ error: 'Not found' }, 404)
  } catch (e) {
    console.error('uncensor-api', e)
    return json({ error: e instanceof Error ? e.message : 'Backend error' }, 500)
  }
})
