import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') || ''
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
const EMBED_MODEL = Deno.env.get('OPENROUTER_EMBED_MODEL') || 'openai/text-embedding-3-small'
const EMBED_DIMENSIONS = 384
const ATTACHMENT_BUCKET = 'private-ai-attachments'
const MULTIMODAL_MODEL = 'nvidia/nemotron-3.5-super-vl'

const DEFAULT_MODEL = Deno.env.get('DEFAULT_MODEL') || 'deepseek/deepseek-v4.1-flash-1017'
const ALLOWED_MODELS = (Deno.env.get('ALLOWED_MODELS') || 'deepseek/deepseek-v4.1-flash-1017,cognitivecomputations/dolphin-mistral-24b-venice-edition,nvidia/nemotron-3.5-super-vl,moonshotai/kimi-k3.1-pro,z-ai/glm-5.3-flash,qwen/qwen3.8-27b')
  .split(',').map(x => x.trim()).filter(Boolean)
const FALLBACK_MODELS = (Deno.env.get('FALLBACK_MODELS') || 'z-ai/glm-5.3-flash,qwen/qwen3.8-27b')
  .split(',').map(x => x.trim()).filter(Boolean)
const DAILY_CAP = Math.max(0, Number(Deno.env.get('DAILY_SPEND_LIMIT_USD') || '1'))
const MAX_TOKENS = Math.max(512, Math.min(16000, Number(Deno.env.get('MAX_COMPLETION_TOKENS') || '5000')))
const TEMPERATURE = Math.max(0, Math.min(2, Number(Deno.env.get('TEMPERATURE') || '0.62')))

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') || 'https://ojgldkee.github.io'
const CORS = {
  'access-control-allow-origin': APP_ORIGIN,
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
  if (!OPENROUTER_KEY) throw new Error('OpenRouter key is not configured for embeddings')
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + OPENROUTER_KEY,
      'content-type': 'application/json',
      'X-Title': 'Uncensor AI Retrieval',
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: String(text || '').slice(0,7000),
      dimensions: EMBED_DIMENSIONS,
      encoding_format: 'float',
      provider: { allow_fallbacks: true },
    }),
    signal: AbortSignal.timeout(30000),
  })
  const raw = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(raw?.error?.message || ('Embedding API ' + res.status))
  const out = raw?.data?.[0]?.embedding
  if (!Array.isArray(out) || out.length !== EMBED_DIMENSIONS) throw new Error('Embedding API returned an unexpected vector')
  const usage = raw?.usage || null
  if (usage) {
    try {
      await db.from('private_ai_usage').insert({
        conversation_id: null,
        model: EMBED_MODEL,
        operation: 'retrieval_embedding',
        prompt_tokens: Number(usage.prompt_tokens || usage.total_tokens || 0),
        completion_tokens: 0,
        total_tokens: Number(usage.total_tokens || usage.prompt_tokens || 0),
        cost_usd: Number(usage.cost || 0),
      })
    } catch {}
  }
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


async function ensureAttachmentBucket() {
  const got = await db.storage.getBucket(ATTACHMENT_BUCKET)
  if (!got.error && got.data) return
  const created = await db.storage.createBucket(ATTACHMENT_BUCKET, {
    public: false,
    fileSizeLimit: 104857600,
  })
  if (created.error && !String(created.error.message || '').toLowerCase().includes('already')) throw created.error
}

function safeFilename(name: string) {
  return String(name || 'attachment').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-160) || 'attachment'
}

async function signUpload(req: Request) {
  await ensureAttachmentBucket()
  const body = await req.json().catch(() => ({}))
  const name = safeFilename(String(body?.name || 'attachment'))
  const size = Number(body?.size || 0)
  const mime = String(body?.mime || 'application/octet-stream').slice(0, 120).toLowerCase()
  const kind = String(body?.kind || 'file').slice(0, 20)
  const allowed = mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') ||
    mime.startsWith('text/') || ['application/pdf','application/json','application/javascript','application/octet-stream'].includes(mime)
  if (!allowed) return json({ error: 'That file type is not supported yet.' }, 415)
  if (!Number.isFinite(size) || size <= 0) return json({ error: 'File size is required.' }, 400)
  if (size > 104857600) return json({ error: 'Attachment exceeds the 100 MB limit.' }, 413)
  const path = 'uploads/' + new Date().toISOString().slice(0,10) + '/' + crypto.randomUUID() + '/' + name
  const signed = await db.storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(path)
  if (signed.error || !signed.data) throw signed.error || new Error('Could not create upload URL')
  return json({ ok: true, path, signed_url: signed.data.signedUrl, token: signed.data.token, mime, kind, size })
}

async function discardUpload(req: Request) {
  const body = await req.json().catch(() => ({}))
  const path = String(body?.path || '')
  if (!path.startsWith('uploads/')) return json({ error: 'Invalid attachment path.' }, 400)
  const removed = await db.storage.from(ATTACHMENT_BUCKET).remove([path])
  if (removed.error) throw removed.error
  return json({ ok: true })
}

function isUnsafeHost(host: string) {
  const h = host.toLowerCase().replace(/^\[|\]$/g,'')
  if (h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0' || h === '::1') return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a=Number(m[1]),b=Number(m[2])
  return a===10 || a===127 || a===0 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168)
}

function htmlToText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi,' ')
    .replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|tr|br)>/gi,'\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'")
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .replace(/[ \t]{2,}/g,' ')
    .trim()
}

async function fetchReadablePage(rawUrl: string) {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('Invalid website URL') }
  if (!['http:','https:'].includes(url.protocol) || isUnsafeHost(url.hostname)) throw new Error('That website URL is not allowed')
  const res = await fetch(url.toString(), {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 UncensorAI/1.0' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error('Website returned HTTP ' + res.status)
  const type = (res.headers.get('content-type') || '').toLowerCase()
  if (!type.includes('text/') && !type.includes('json') && !type.includes('html')) throw new Error('Website did not return readable text')
  const raw = (await res.text()).slice(0, 1500000)
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? htmlToText(titleMatch[1]).slice(0,160) : url.hostname
  return { url: res.url || url.toString(), title, text: type.includes('html') ? htmlToText(raw) : raw }
}

async function signedReadUrl(path: string, seconds = 900) {
  const signed = await db.storage.from(ATTACHMENT_BUCKET).createSignedUrl(path, seconds)
  if (signed.error || !signed.data?.signedUrl) throw signed.error || new Error('Could not read attachment')
  return signed.data.signedUrl
}

async function attachmentParts(attachments: any[]) {
  const parts: any[] = []
  let forceMultimodal = false
  for (const raw of (attachments || []).slice(0, 8)) {
    const a = raw || {}
    const kind = String(a.kind || '')
    if (kind === 'url' && a.url) {
      const page = await fetchReadablePage(String(a.url))
      parts.push({ type: 'text', text: '\n\nATTACHED WEBSITE: ' + page.url + '\n' + page.text.slice(0,100000) })
      continue
    }
    const path = String(a.path || '')
    if (!path.startsWith('uploads/')) continue
    if (kind === 'image') {
      const url = await signedReadUrl(path)
      parts.push({ type: 'image_url', image_url: { url } })
      forceMultimodal = true
    } else if (kind === 'video') {
      const url = await signedReadUrl(path)
      parts.push({ type: 'video_url', video_url: { url } })
      forceMultimodal = true
    } else if (kind === 'pdf') {
      const url = await signedReadUrl(path)
      parts.push({ type: 'file', file: { filename: safeFilename(String(a.name || 'document.pdf')), file_data: url } })
    } else if (kind === 'text') {
      const dl = await db.storage.from(ATTACHMENT_BUCKET).download(path)
      if (dl.error || !dl.data) throw dl.error || new Error('Could not read text attachment')
      const txt = (await dl.data.text()).slice(0,250000)
      parts.push({ type: 'text', text: '\n\nATTACHED FILE: ' + String(a.name || 'text file') + '\n' + txt })
    } else if (kind === 'audio') {
      const dl = await db.storage.from(ATTACHMENT_BUCKET).download(path)
      if (dl.error || !dl.data) throw dl.error || new Error('Could not read audio attachment')
      const buf = new Uint8Array(await dl.data.arrayBuffer())
      let binary = ''
      for (let i=0;i<buf.length;i+=0x8000) binary += String.fromCharCode(...buf.subarray(i, Math.min(i+0x8000,buf.length)))
      const base64 = btoa(binary)
      const ext = String(a.name || '').split('.').pop()?.toLowerCase() || 'mp3'
      const tr = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
        method:'POST',
        headers:{ authorization:'Bearer '+OPENROUTER_KEY, 'content-type':'application/json', 'X-Title':'Uncensor AI' },
        body:JSON.stringify({ model:'openai/whisper-1', input_audio:{ data:base64, format:ext } }),
        signal:AbortSignal.timeout(90000),
      })
      const td = await tr.json().catch(()=>({}))
      if (!tr.ok) throw new Error(td?.error?.message || 'Audio transcription failed')
      parts.push({ type:'text', text:'\n\nAUDIO TRANSCRIPT — '+String(a.name||'audio')+':\n'+String(td.text||'') })
    }
  }
  return { parts, forceMultimodal }
}

async function relevantContext(query: string, includeKnowledge: boolean) {
  const vector = await embed(query)
  const memoryPromise = db.rpc('private_ai_match_memories', { query_embedding: vector, match_count: 12, similarity_threshold: 0.24 })
  const knowledgePromise = includeKnowledge
    ? db.rpc('private_ai_match_chunks', { query_embedding: vector, match_count: 10, similarity_threshold: 0.25 })
    : Promise.resolve({ data: [], error: null } as any)
  const [knowledge, memories] = await Promise.all([knowledgePromise, memoryPromise])
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
  let query = db.from('private_ai_messages').select('role,content,created_at')
    .eq('conversation_id', conversationId).order('created_at', { ascending: true })
  if (summaryThrough > 0) query = query.range(summaryThrough, summaryThrough + 47)
  else query = query.limit(48)
  const q = await query
  if (q.error) throw q.error
  return (q.data || []).map((m: any) => ({ role: m.role, content: String(m.content || '').slice(0, 50000) }))
}

async function saveMessage(conversationId: string, role: string, content: string, model?: string, sources?: unknown[], attachments?: unknown[]) {
  const q = await db.from('private_ai_messages').insert({
    conversation_id: conversationId,
    role,
    content,
    model: model || null,
    sources: sources || [],
    attachments: attachments || [],
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

async function openRouterOnce(model: string, messages: any[]) {
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
            stream: false,
            usage: { include: true },
            temperature: TEMPERATURE,
            max_tokens: MAX_TOKENS,
            messages,
            provider: { allow_fallbacks: true },
          }),
          signal: AbortSignal.timeout(90000),
        })
        const raw = await res.json().catch(() => ({}))
        if (res.ok) {
          const content = raw?.choices?.[0]?.message?.content
          if (typeof content !== 'string' || !content.trim()) throw new Error('Model returned an empty response')
          return { content, usage: raw?.usage || null, model: candidate }
        }
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
  const rate = await db.rpc('private_ai_take_rate_limit', { minute_limit: 12, day_limit: 400 })
  if (rate.error) return json({ error: 'Rate limiter unavailable.' }, 503)
  if (rate.data !== true) return json({ error: 'Request limit reached. Try again shortly.', rate_limited: true }, 429)
  const spend = await rollingSpend()
  if (DAILY_CAP > 0 && spend >= DAILY_CAP) return json({ error: 'Rolling 24-hour spend cap reached.', spent: spend, cap: DAILY_CAP }, 429)

  const body = await req.json().catch(() => ({}))
  const text = String(body?.message || '').trim().slice(0, 50000)
  const attachments = Array.isArray(body?.attachments) ? body.attachments.slice(0,8) : []
  if (!text && !attachments.length) return json({ error: 'Message or attachment is required.' }, 400)

  const conversation = await ensureConversation(body?.conversation_id ? String(body.conversation_id) : null, text)
  const conversationId = String(conversation.id)
  await saveMessage(conversationId, 'user', text || 'Please analyze the attached item.', undefined, [], attachments)

  const ctx = await relevantContext(text, body?.use_knowledge !== false)
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

  const attached = await attachmentParts(attachments)
  const preferred = attached.forceMultimodal ? MULTIMODAL_MODEL : cleanModel(body?.model)
  let requestMessages: any[] = [{ role: 'system', content: system }, ...recent]
  if (attachments.length) {
    const last = requestMessages[requestMessages.length - 1]
    if (last?.role === 'user') last.content = [{ type:'text', text:text || 'Please analyze the attached item.' }, ...attached.parts]
  }
  const sourceMeta = (ctx.knowledge || []).slice(0, 10).map((k: any) => ({
    title: k.title,
    source_id: k.source_id,
    similarity: k.similarity,
  }))

  if (body?.stream === false) {
    const result = await openRouterOnce(preferred, requestMessages)
    await saveMessage(conversationId, 'assistant', result.content, result.model, sourceMeta)
    if (result.usage) {
      await db.from('private_ai_usage').insert({
        conversation_id: conversationId,
        model: result.model,
        operation: 'chat',
        prompt_tokens: Number(result.usage.prompt_tokens || 0),
        completion_tokens: Number(result.usage.completion_tokens || 0),
        total_tokens: Number(result.usage.total_tokens || 0),
        cost_usd: Number(result.usage.cost || 0),
      })
    }
    return json({
      ok: true,
      conversation_id: conversationId,
      title: conversation.title,
      model: result.model,
      content: result.content,
      sources: sourceMeta,
      memories_used: (ctx.memories || []).length,
    })
  }

  const upstream = await openRouterStream(preferred, requestMessages)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let full = '', buffer = '', usage: any = null, assistantSaved = false
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
          assistantSaved = true
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
        if (full.trim() && !assistantSaved) {
          try {
            await saveMessage(conversationId, 'assistant', full + '\n\n[Response interrupted]', upstream.model, sourceMeta)
            assistantSaved = true
          } catch {}
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
    db.from('private_ai_messages').select('id,role,content,model,sources,attachments,created_at').eq('conversation_id', id).order('created_at'),
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
    .select('id,title,source_type,enabled,content_hash,file_sha256,char_count,chunk_count,embedded_chunk_count,status,failure_count,last_error,metadata,created_at,updated_at,completed_at')
    .order('created_at', { ascending: false }).limit(1000)
  if (q.error) throw q.error
  return json({ sources: q.data || [] })
}

async function findDuplicateFile(fileSha256: string, title: string, fileSize: number) {
  const sha=String(fileSha256||'').toLowerCase().trim()
  if(sha){
    const exact=await db.from('private_ai_knowledge_sources')
      .select('id,title,status,chunk_count,embedded_chunk_count,file_sha256,metadata')
      .eq('source_type','file').eq('file_sha256',sha).maybeSingle()
    if(exact.error)throw exact.error
    if(exact.data)return { source:exact.data, reason:'exact_sha256' }
  }
  const legacy=await db.from('private_ai_knowledge_sources')
    .select('id,title,status,chunk_count,embedded_chunk_count,file_sha256,metadata')
    .eq('source_type','file').eq('title',title.trim().slice(0,160)).limit(25)
  if(legacy.error)throw legacy.error
  const match=(legacy.data||[]).find((x:any)=>!x.file_sha256 && Number(x.metadata?.file_size||-1)===Number(fileSize))
  return match ? { source:match, reason:'legacy_name_size' } : null
}

async function knowledgeFileCheck(req: Request) {
  const body=await req.json().catch(()=>({}))
  const sha=String(body?.sha256||'').toLowerCase().trim()
  const name=String(body?.name||'').trim().slice(0,160)
  const size=Number(body?.size||0)
  if(!sha || !/^[a-f0-9]{64}$/.test(sha))return json({error:'Valid SHA-256 fingerprint required.'},400)
  if(!name || !Number.isFinite(size) || size<0)return json({error:'File name and size are required.'},400)
  const found=await findDuplicateFile(sha,name,size)
  if(found?.reason==='legacy_name_size' && found.source?.id && !found.source?.file_sha256){
    const claimed=await db.from('private_ai_knowledge_sources')
      .update({file_sha256:sha,updated_at:new Date().toISOString()})
      .eq('id',found.source.id).is('file_sha256',null)
      .select('id,title,status,chunk_count,embedded_chunk_count,file_sha256,metadata').maybeSingle()
    if(!claimed.error && claimed.data){
      found.source=claimed.data
      found.reason='legacy_upgraded_to_sha256'
    }
  }
  return json({
    ok:true,
    duplicate:Boolean(found),
    reason:found?.reason||null,
    source:found?.source||null,
  })
}

async function createKnowledgeRecord(title: string, text: string, sourceType = 'paste', metadata: any = {}, fileSha256: string | null = null) {
  if (!text.trim()) return json({ error: 'No readable text found.' }, 400)
  if (text.length > 5000000) return json({ error: 'Source exceeds 5,000,000 characters.' }, 413)
  const hash = await contentHash(text)
  const fileFingerprint=sourceType==='file' && Boolean(metadata?.file_sha256)
  if(!fileFingerprint){
    const existing = await db.from('private_ai_knowledge_sources')
      .select('id,title,status,chunk_count,embedded_chunk_count').eq('content_hash', hash).maybeSingle()
    if (existing.error) throw existing.error
    if (existing.data) return json({ ok: true, duplicate: true, duplicate_reason:'content_hash', source: existing.data })
  }

  const parts = chunkText(text)
  const created = await db.from('private_ai_knowledge_sources').insert({
    title: title.trim().slice(0,160) || 'Untitled',
    source_type: sourceType.slice(0,40),
    enabled: true,
    content_hash: hash,
    file_sha256: fileSha256 || null,
    char_count: text.length,
    chunk_count: parts.length,
    embedded_chunk_count: 0,
    status: 'queued',
    metadata,
  }).select().single()
  if (created.error) {
    if (fileSha256 && String((created.error as any)?.code || '') === '23505') {
      const exact = await db.from('private_ai_knowledge_sources')
        .select('id,title,status,chunk_count,embedded_chunk_count,file_sha256,metadata')
        .eq('source_type','file').eq('file_sha256',fileSha256).maybeSingle()
      if (!exact.error && exact.data) return json({ ok:true, duplicate:true, duplicate_reason:'exact_sha256', source:exact.data })
    }
    throw created.error
  }

  for (let i=0;i<parts.length;i+=150) {
    const rows = await Promise.all(parts.slice(i,i+150).map(async (content,j)=>({
      source_id: created.data.id,
      chunk_index: i+j,
      content,
      content_hash: await contentHash(content),
    })))
    const ins = await db.from('private_ai_knowledge_chunks').insert(rows)
    if (ins.error) throw ins.error
  }
  await db.from('private_ai_knowledge_sources').update({ status:'processing', updated_at:new Date().toISOString() }).eq('id',created.data.id)
  return json({ ok:true, duplicate:false, source_id:created.data.id, chunk_count:parts.length, background:true })
}

async function knowledgeCreate(req: Request) {
  const body = await req.json().catch(() => ({}))
  const title=String(body?.title || 'Untitled')
  const sourceType=String(body?.source_type || 'paste')
  const metadata=body?.metadata || {}
  const part=Math.max(1,Number(metadata?.part||1))
  const fileSha=sourceType==='file' && part===1 ? String(metadata?.file_sha256||'').toLowerCase().trim() : ''
  if(fileSha){
    const found=await findDuplicateFile(fileSha,title,Number(metadata?.file_size||0))
    if(found){
      if(found.reason==='legacy_name_size' && found.source?.id && !found.source?.file_sha256){
        const claimed=await db.from('private_ai_knowledge_sources')
          .update({file_sha256:fileSha,updated_at:new Date().toISOString()})
          .eq('id',found.source.id).is('file_sha256',null)
          .select('id,title,status,chunk_count,embedded_chunk_count,file_sha256,metadata').maybeSingle()
        if(!claimed.error && claimed.data){found.source=claimed.data;found.reason='legacy_upgraded_to_sha256'}
      }
      return json({ok:true,duplicate:true,duplicate_reason:found.reason,source:found.source})
    }
  }
  let text=String(body?.text || '')
  const isHtml=sourceType==='file' && (/\.html?$/i.test(title) || /\.html?$/i.test(String(metadata?.file_name || '')))
  if(isHtml){
    const before=text.length
    text=htmlToText(text)
    metadata.cleaned_html=true
    metadata.raw_segment_chars=before
    metadata.cleaned_segment_chars=text.length
  }
  return createKnowledgeRecord(title,text,sourceType,metadata,fileSha||null)
}

async function knowledgeUrlCreate(req: Request) {
  const body = await req.json().catch(() => ({}))
  const url = String(body?.url || '').trim()
  if (!url) return json({ error:'URL is required.' },400)
  const page = await fetchReadablePage(url)
  return createKnowledgeRecord(page.title || new URL(page.url).hostname, page.text, 'website', { url:page.url, collection:String(body?.collection || '').trim().slice(0,80) })
}

async function statusRoute() {
  const spend = await rollingSpend()
  const cfg = await db.from('private_ai_runtime_config')
    .select('last_worker_run_at,last_worker_success_at,last_worker_error,backend_version')
    .eq('id', true).maybeSingle()
  return json({
    ok: true,
    backend: 'supabase-edge',
    backend_version: cfg.data?.backend_version || 'v3',
    openrouter_enabled: Boolean(OPENROUTER_KEY),
    memory_enabled: true,
    rolling_summaries_enabled: true,
    background_indexing_enabled: true,
    duplicate_detection_enabled: true,
    last_worker_run_at: cfg.data?.last_worker_run_at || null,
    last_worker_success_at: cfg.data?.last_worker_success_at || null,
    last_worker_error: cfg.data?.last_worker_error || null,
    rolling_24h_spend: spend,
    rolling_24h_cap: DAILY_CAP,
    default_model: DEFAULT_MODEL,
  })
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  if (origin && origin !== APP_ORIGIN) return json({ error: 'Origin not allowed' }, 403)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  const path = pathOf(req)

  if (path === '/api/status' && req.method === 'GET') return statusRoute()
  if (!(await authorized(req))) return json({ error: 'Access key required', requires_access_key: true }, 401)

  try {
    if (path === '/api/chat' && req.method === 'POST') return chat(req)
    if (path === '/api/uploads/sign' && req.method === 'POST') return signUpload(req)
    if (path === '/api/uploads/discard' && req.method === 'POST') return discardUpload(req)
    if (path === '/api/conversations' && req.method === 'GET') return listConversations()
    if (path === '/api/memories') return memoriesRoute(req)
    if (path === '/api/knowledge' && req.method === 'GET') return knowledgeList()
    if (path === '/api/knowledge/file-check' && req.method === 'POST') return knowledgeFileCheck(req)
    if (path === '/api/knowledge' && req.method === 'POST') return knowledgeCreate(req)
    if (path === '/api/knowledge/url' && req.method === 'POST') return knowledgeUrlCreate(req)

    const conv = path.match(/^\/api\/conversations\/([^/]+)$/)
    if (conv) {
      const id = decodeURIComponent(conv[1])
      if (req.method === 'GET') return getConversation(id)
      if (req.method === 'PATCH') return updateConversation(id, req)
      if (req.method === 'DELETE') {
        const messages = await db.from('private_ai_messages').select('attachments').eq('conversation_id', id)
        const paths = (messages.data || []).flatMap((m: any) => Array.isArray(m.attachments) ? m.attachments : [])
          .map((a: any) => String(a?.path || '')).filter((p: string) => p.startsWith('uploads/'))
        if (paths.length) await db.storage.from(ATTACHMENT_BUCKET).remove([...new Set(paths)])
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
