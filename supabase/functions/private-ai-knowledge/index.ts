import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const headers = { 'content-type': 'application/json' }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
const model = new Supabase.ai.Session('gte-small')

async function embed(text: string) {
  const result = await model.run(text, { mean_pool: true, normalize: true })
  if (!Array.isArray(result) || result.length !== 384) throw new Error('Embedding model returned an unexpected vector.')
  return result
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply({ error: 'POST required' }, 405)
  const expected = Deno.env.get('PRIVATE_AI_INTERNAL_TOKEN') || ''
  const supplied = req.headers.get('x-private-ai-token') || ''
  if (!expected || supplied !== expected) return reply({ error: 'Unauthorized' }, 401)

  const url = Deno.env.get('SUPABASE_URL') || ''
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  if (!url || !service) return reply({ error: 'Supabase server configuration missing' }, 503)
  const db = createClient(url, service, { auth: { persistSession: false } })

  try {
    const body = await req.json().catch(() => ({}))
    const action = String(body?.action || '')

    if (action === 'list') {
      const { data, error } = await db.from('private_ai_knowledge_sources')
        .select('id,title,source_type,enabled,char_count,chunk_count,status,created_at,updated_at')
        .order('created_at', { ascending: false }).limit(1000)
      if (error) throw error
      return reply({ sources: data || [] })
    }

    if (action === 'update') {
      const sourceId = String(body?.source_id || '')
      if (!sourceId) return reply({ error: 'source_id required' }, 400)
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (typeof body?.title === 'string') patch.title = String(body.title).trim().slice(0, 160) || 'Untitled'
      if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled
      const { data, error } = await db.from('private_ai_knowledge_sources').update(patch).eq('id', sourceId).select().single()
      if (error) throw error
      return reply({ ok: true, source: data })
    }

    if (action === 'delete') {
      const sourceId = String(body?.source_id || '')
      if (!sourceId) return reply({ error: 'source_id required' }, 400)
      const { error } = await db.from('private_ai_knowledge_sources').delete().eq('id', sourceId)
      if (error) throw error
      return reply({ ok: true, permanent: true })
    }

    if (action === 'search') {
      const query = String(body?.query || '').trim()
      if (!query) return reply({ matches: [] })
      const queryEmbedding = await embed(query.slice(0, 2600))
      const { data, error } = await db.rpc('private_ai_match_chunks', {
        query_embedding: queryEmbedding,
        match_count: Math.max(1, Math.min(Number(body?.limit || 10), 20)),
        similarity_threshold: Number(body?.threshold || 0.25),
      })
      if (error) throw error
      const seen = new Set<string>()
      const matches = (data || []).filter((row: any) => {
        const key = `${row.source_id}:${row.chunk_index}`
        if (seen.has(key)) return false
        seen.add(key); return true
      })
      return reply({ matches })
    }

    if (action === 'process_source') {
      const sourceId = String(body?.source_id || '')
      const batchSize = Math.max(1, Math.min(Number(body?.batch_size || 24), 48))
      if (!sourceId) return reply({ error: 'source_id required' }, 400)
      const pending = await db.from('private_ai_knowledge_chunks').select('id,content,chunk_index')
        .eq('source_id', sourceId).is('embedding', null).order('chunk_index', { ascending: true }).limit(batchSize)
      if (pending.error) throw pending.error
      const rows = pending.data || []
      if (rows.length) {
        const vectors = await Promise.all(rows.map(row => embed(String(row.content || ''))))
        const writes = await Promise.all(rows.map((row, i) => db.from('private_ai_knowledge_chunks').update({ embedding: vectors[i] }).eq('id', row.id)))
        const failed = writes.find(x => x.error); if (failed?.error) throw failed.error
      }
      const remainingQ = await db.from('private_ai_knowledge_chunks').select('id', { count: 'exact', head: true }).eq('source_id', sourceId).is('embedding', null)
      if (remainingQ.error) throw remainingQ.error
      const totalQ = await db.from('private_ai_knowledge_sources').select('chunk_count').eq('id', sourceId).single()
      if (totalQ.error) throw totalQ.error
      const remaining = Number(remainingQ.count || 0), total = Number(totalQ.data?.chunk_count || 0), processed = Math.max(0, total - remaining)
      if (remaining === 0) {
        const done = await db.from('private_ai_knowledge_sources').update({ status: 'ready', updated_at: new Date().toISOString() }).eq('id', sourceId)
        if (done.error) throw done.error
      }
      return reply({ ok: true, source_id: sourceId, processed, remaining, total, done: remaining === 0 })
    }

    return reply({ error: 'Unknown action' }, 400)
  } catch (e) {
    console.error('private-ai-knowledge', e)
    return reply({ error: e instanceof Error ? e.message : 'Knowledge operation failed' }, 500)
  }
})
