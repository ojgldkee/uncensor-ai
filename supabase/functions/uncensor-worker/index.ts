import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') || ''
const SUMMARY_MODEL = Deno.env.get('OPENROUTER_SUMMARY_MODEL') || 'z-ai/glm-5.3-flash'
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
const EMBED_MODEL = Deno.env.get('OPENROUTER_EMBED_MODEL') || 'openai/text-embedding-3-small'
const EMBED_DIMENSIONS = 384
const KNOWLEDGE_BATCH = Math.max(32, Math.min(256, Number(Deno.env.get('KNOWLEDGE_EMBED_BATCH') || '192')))
const ATTACHMENT_BUCKET='private-ai-attachments'
const MEDIA_VISION_MODEL=Deno.env.get('OPENROUTER_MEDIA_MODEL') || 'nvidia/nemotron-3.5-super-vl'
const MEDIA_TRANSCRIBE_MODEL=Deno.env.get('OPENROUTER_TRANSCRIBE_MODEL') || 'openai/whisper-large-v3-turbo'
const PDF_PARSE_MODEL=Deno.env.get('OPENROUTER_PDF_MODEL') || SUMMARY_MODEL

type QueueJob = {
  msg_id: number
  read_ct: number
  enqueued_at: string
  vt: string
  message: Record<string, unknown>
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let vectorTransformPromise: Promise<{perm:number[],signs:number[]}> | null = null
async function vectorTransformSpec() {
  if (!vectorTransformPromise) vectorTransformPromise = (async()=>{
    const q=await db.rpc('private_ai_vector_transform_key')
    if(q.error)throw q.error
    const key=String(q.data||'')
    if(key.length<32)throw new Error('Vector transform key is unavailable')
    const bytes:number[]=[]
    for(let counter=0;bytes.length<4096;counter++){
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key+':'+counter))
      bytes.push(...new Uint8Array(digest))
    }
    let pos=0
    const nextU32=()=>{
      const v=(((bytes[pos]<<24)>>>0)|(bytes[pos+1]<<16)|(bytes[pos+2]<<8)|bytes[pos+3])>>>0
      pos+=4
      return v
    }
    const perm=Array.from({length:EMBED_DIMENSIONS},(_,i)=>i)
    for(let i=perm.length-1;i>0;i--){const j=nextU32()%(i+1);[perm[i],perm[j]]=[perm[j],perm[i]]}
    const signs=Array.from({length:EMBED_DIMENSIONS},()=>((nextU32()&1)===1?1:-1))
    return {perm,signs}
  })()
  return vectorTransformPromise
}
async function transformVector(vector:number[]) {
  const spec=await vectorTransformSpec()
  return spec.perm.map((sourceIndex,i)=>Number(vector[sourceIndex]||0)*spec.signs[i])
}

async function embeddingBatch(texts: string[]) {
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY is not configured for embeddings')
  if (!texts.length) return []
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + OPENROUTER_KEY,
      'content-type': 'application/json',
      'X-Title': 'Uncensor AI Knowledge Indexer',
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts.map(t => String(t || '').slice(0, 7000)),
      dimensions: EMBED_DIMENSIONS,
      encoding_format: 'float',
      provider: { allow_fallbacks: true, zdr: true, data_collection: 'deny' },
    }),
    signal: AbortSignal.timeout(60000),
  })
  const raw = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(raw?.error?.message || ('Embedding API ' + res.status))
  const data = Array.isArray(raw?.data) ? [...raw.data].sort((a,b)=>Number(a.index||0)-Number(b.index||0)) : []
  const vectors = data.map((x:any)=>x?.embedding)
  if (vectors.length !== texts.length || vectors.some((v:any)=>!Array.isArray(v) || v.length !== EMBED_DIMENSIONS)) {
    throw new Error('Embedding API returned an unexpected batch shape')
  }
  const usage = raw?.usage || null
  if (usage) {
    try {
      await db.from('private_ai_usage').insert({
        conversation_id: null,
        model: EMBED_MODEL,
        operation: 'embedding',
        prompt_tokens: Number(usage.prompt_tokens || usage.total_tokens || 0),
        completion_tokens: 0,
        total_tokens: Number(usage.total_tokens || usage.prompt_tokens || 0),
        cost_usd: Number(usage.cost || 0),
      })
    } catch {}
  }
  const spec=await vectorTransformSpec()
  return vectors.map((vector:any)=>spec.perm.map((sourceIndex,i)=>Number(vector[sourceIndex]||0)*spec.signs[i]))
}

async function embedding(text: string) {
  const out = await embeddingBatch([text])
  return out[0]
}

async function contentHash(text: string) {
  const normalized = String(text || '').replace(/\r\n/g,'\n').replace(/[ \t]+\n/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')
}

function chunkText(text: string) {
  const normalized = String(text || '').replace(/\r\n/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim()
  const out: string[] = []
  const target=1350,overlap=180
  const markerRe=/\[(?:PDF page\s+\d+(?:\s*\|\s*[^\]]+)?|PDF parser block\s+\d+)\]/gi
  const markers=[...normalized.matchAll(markerRe)].map((m:any)=>({index:Number(m.index||0),text:String(m[0])}))
  let markerCursor=0,currentMarker=''
  let start=0
  while(start<normalized.length && out.length<4200){
    while(markerCursor<markers.length&&markers[markerCursor].index<=start){
      currentMarker=markers[markerCursor].text
      markerCursor++
    }
    let end=Math.min(normalized.length,start+target)
    if(end<normalized.length){
      const boundary=Math.max(
        normalized.lastIndexOf('\n\n',end),
        normalized.lastIndexOf('. ',end),
        normalized.lastIndexOf('\n',end)
      )
      if(boundary>start+650)end=boundary+(normalized[boundary]==='.'?1:0)
    }
    let part=normalized.slice(start,end).trim()
    if(part&&currentMarker&&!/^\[(?:PDF page|PDF parser block)/i.test(part))part=currentMarker+'\n'+part
    if(part)out.push(part)
    if(end>=normalized.length)break
    start=Math.max(start+1,end-overlap)
  }
  return out
}

function htmlToText(html: string) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g,' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi,' ')
    .replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|tr|br)>/gi,'\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/\S{500,}/g,' ')
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

function reconstructChunks(rows: Array<{chunk_index:number,content:string}>) {
  let out=''
  for(const row of rows.sort((a,b)=>Number(a.chunk_index)-Number(b.chunk_index))){
    const part=String(row.content||'')
    if(!out){out=part;continue}
    let overlap=0
    const max=Math.min(420,out.length,part.length)
    for(let k=max;k>=32;k--){
      if(out.endsWith(part.slice(0,k))){overlap=k;break}
    }
    out+=part.slice(overlap)
  }
  return out
}

function extractJson(text: string) {
  const clean = String(text || '').trim().replace(/^\x60\x60\x60json\s*/i, '').replace(/\x60\x60\x60$/i, '').trim()
  const start = clean.indexOf('{')
  if (start < 0) throw new Error('Model returned no JSON object')
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i]
    if (quoted) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) return JSON.parse(clean.slice(start, i + 1))
    }
  }
  throw new Error('Model returned incomplete JSON')
}

async function llm(system: string, user: string, operation: string, conversationId?: string) {
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY is not configured for background memory/summaries')
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + OPENROUTER_KEY,
      'content-type': 'application/json',
      'X-Title': 'Uncensor AI Background Worker',
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      temperature: 0.15,
      max_tokens: 2600,
      response_format: { type: 'json_object' },
      usage: { include: true },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      provider: { allow_fallbacks: true, zdr: true, data_collection: 'deny' },
    }),
    signal: AbortSignal.timeout(55000),
  })
  const raw = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(raw?.error?.message || ('OpenRouter ' + res.status))
  const content = raw?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('Background model returned an empty response')
  const usage = raw?.usage || null
  if (usage) {
    try {
      await db.from('private_ai_usage').insert({
        conversation_id: conversationId || null,
        model: SUMMARY_MODEL,
        operation,
        prompt_tokens: Number(usage.prompt_tokens || 0),
        completion_tokens: Number(usage.completion_tokens || 0),
        total_tokens: Number(usage.total_tokens || 0),
        cost_usd: Number(usage.cost || 0),
      })
    } catch {}
  }
  return extractJson(content)
}

async function finish(jobId: number) {
  const { error } = await db.rpc('private_ai_delete_job', { job_id: jobId })
  if (error) throw error
}

async function archive(jobId: number) {
  await db.rpc('private_ai_archive_job', { job_id: jobId })
}

async function processKnowledgeBatch() {
  const claim = await db.rpc('private_ai_claim_knowledge_chunks', {
    batch_size: KNOWLEDGE_BATCH,
    lease_seconds: 180,
  })
  if (claim.error) throw claim.error
  const rows = (claim.data || []) as Array<{id:number,source_id:string,content:string}>
  if (!rows.length) return { processed: 0, sources: 0 }

  const vectors = await embeddingBatch(rows.map(r => r.content))
  const payload = rows.map((r,i)=>({ id:r.id, embedding:JSON.stringify(vectors[i]) }))
  const saved = await db.rpc('private_ai_set_chunk_embeddings', { payload })
  if (saved.error) throw saved.error

  const sourceIds = [...new Set(rows.map(r=>r.source_id).filter(Boolean))]
  if (sourceIds.length) {
    const refreshed = await db.rpc('private_ai_refresh_knowledge_progress', { source_ids: sourceIds })
    if (refreshed.error) throw refreshed.error
  }
  return { processed: Number(saved.data || rows.length), sources: sourceIds.length }
}

async function processMemoryBackfillBatch() {
  const q = await db.from('private_ai_memories_read')
    .select('id,content')
    .eq('active', true)
    .is('embedding', null)
    .order('updated_at', { ascending: true })
    .limit(32)
  if (q.error) throw q.error
  const rows = q.data || []
  if (!rows.length) return 0
  const vectors = await embeddingBatch(rows.map((r:any)=>String(r.content||'')))
  const payload = rows.map((r:any,i:number)=>({id:r.id,embedding:JSON.stringify(vectors[i])}))
  const saved = await db.rpc('private_ai_set_memory_embeddings', { payload })
  if (saved.error) throw saved.error
  return Number(saved.data || rows.length)
}


function tsLabel(seconds:number){
  const s=Math.max(0,Math.floor(Number(seconds||0))),m=Math.floor(s/60),r=s%60
  return String(m).padStart(2,'0')+':'+String(r).padStart(2,'0')
}

function mediaJson(text:string){
  const clean=String(text||'').trim().replace(/^\x60\x60\x60json\s*/i,'').replace(/\x60\x60\x60$/i,'').trim()
  try{return JSON.parse(clean)}catch{}
  const start=clean.indexOf('{'),end=clean.lastIndexOf('}')
  if(start>=0&&end>start)return JSON.parse(clean.slice(start,end+1))
  throw new Error('Media model returned invalid JSON')
}

async function mediaSignedUrl(path:string){
  const q=await db.storage.from(ATTACHMENT_BUCKET).createSignedUrl(path,3600)
  if(q.error||!q.data?.signedUrl)throw q.error||new Error('Could not create private media URL')
  return q.data.signedUrl
}

async function transcribeSmallMedia(path:string,mime:string,fileName:string,size:number){
  if(size>16*1024*1024)return null
  const dl=await db.storage.from(ATTACHMENT_BUCKET).download(path)
  if(dl.error||!dl.data)throw dl.error||new Error('Could not download media for transcription')
  const bytes=new Uint8Array(await dl.data.arrayBuffer())
  let binary=''
  for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+0x8000,bytes.length)))
  const base64=btoa(binary)
  const ext=(fileName.split('.').pop()||'mp4').toLowerCase()
  const format=['wav','mp3','flac','m4a','ogg','webm','aac','mp4'].includes(ext)?ext:(mime.includes('mp4')?'mp4':'webm')
  const res=await fetch('https://openrouter.ai/api/v1/audio/transcriptions',{
    method:'POST',
    headers:{authorization:'Bearer '+OPENROUTER_KEY,'content-type':'application/json','X-Title':'Uncensor AI Private Media'},
    body:JSON.stringify({
      model:MEDIA_TRANSCRIBE_MODEL,
      input_audio:{data:base64,format},
      response_format:'verbose_json',
      timestamp_granularities:['segment'],
      provider:{zdr:true,data_collection:'deny'},
    }),
    signal:AbortSignal.timeout(60000),
  })
  const raw=await res.json().catch(()=>({}))
  if(!res.ok)throw new Error(raw?.error?.message||('Transcription '+res.status))
  const segments=Array.isArray(raw?.segments)?raw.segments.map((s:any)=>({
    start:Number(s.start||0),end:Number(s.end||0),text:String(s.text||'').trim()
  })).filter((s:any)=>s.text):[]
  return {text:String(raw?.text||'').trim(),segments,usage:raw?.usage||null}
}

async function analyzeVideo(path:string,title:string){
  const url=await mediaSignedUrl(path)
  const res=await fetch('https://openrouter.ai/api/v1/chat/completions',{
    method:'POST',
    headers:{authorization:'Bearer '+OPENROUTER_KEY,'content-type':'application/json','X-Title':'Uncensor AI Private Media'},
    body:JSON.stringify({
      model:MEDIA_VISION_MODEL,
      stream:false,
      temperature:0.1,
      max_tokens:6000,
      response_format:{type:'json_object'},
      messages:[{role:'user',content:[
        {type:'text',text:[
          'Analyze this private reference video for a searchable Knowledge library.',
          'Return JSON only with shape:',
          '{"duration_seconds":number,"summary":"concise overview","segments":[{"start":number,"end":number,"topic":"short label","spoken":"important spoken content","visual":"important on-screen context, slides, dashboards, charts, UI or examples"}]}',
          'Create useful chronological segments, usually 15-60 seconds each. Preserve concrete tactics, numbers, campaign settings, examples, caveats, and reasoning.',
          'Use seconds from the start of the video. Do not invent details that are not visible/audible.',
          'VIDEO TITLE: '+title
        ].join('\n')},
        {type:'video_url',video_url:{url}}
      ]}],
      provider:{allow_fallbacks:true,zdr:true,data_collection:'deny'},
      usage:{include:true},
    }),
    signal:AbortSignal.timeout(90000),
  })
  const raw=await res.json().catch(()=>({}))
  if(!res.ok)throw new Error(raw?.error?.message||('Video analysis '+res.status))
  const content=String(raw?.choices?.[0]?.message?.content||'')
  const parsed=mediaJson(content)
  return {parsed,usage:raw?.usage||null,model:String(raw?.model||MEDIA_VISION_MODEL)}
}

async function parsePdfWithOpenRouter(path:string,title:string){
  if(!OPENROUTER_KEY)throw new Error('OPENROUTER_API_KEY is not configured for PDF OCR')
  const url=await mediaSignedUrl(path)
  const res=await fetch('https://openrouter.ai/api/v1/chat/completions',{
    method:'POST',
    headers:{
      authorization:'Bearer '+OPENROUTER_KEY,
      'content-type':'application/json',
      'X-Title':'Uncensor AI PDF Indexer',
    },
    body:JSON.stringify({
      model:PDF_PARSE_MODEL,
      stream:false,
      temperature:0,
      max_tokens:24,
      usage:{include:true},
      messages:[{role:'user',content:[
        {type:'text',text:'Parse this private PDF for a searchable Knowledge library. Reply only with OK after parsing; do not summarize it.'},
        {type:'file',file:{filename:title,file_data:url}},
      ]}],
      plugins:[{id:'file-parser',pdf:{engine:'mistral-ocr'}}],
      provider:{allow_fallbacks:true,zdr:true,data_collection:'deny'},
    }),
    signal:AbortSignal.timeout(120000),
  })
  const raw=await res.json().catch(()=>({}))
  const annotations=[
    ...(Array.isArray(raw?.choices?.[0]?.message?.annotations)?raw.choices[0].message.annotations:[]),
    ...(Array.isArray(raw?.error?.metadata?.file_annotations)?raw.error.metadata.file_annotations:[]),
  ].filter((x:any)=>x?.type==='file'&&Array.isArray(x?.file?.content))
  const blocks:string[]=[]
  let imageParts=0
  const hashes:string[]=[]
  for(const ann of annotations){
    if(ann?.file?.hash)hashes.push(String(ann.file.hash))
    for(const part of ann.file.content||[]){
      if(part?.type==='text'&&String(part?.text||'').trim())blocks.push(String(part.text).trim())
      else if(part?.type==='image_url')imageParts++
    }
  }
  if(!res.ok&&blocks.length===0)throw new Error(raw?.error?.message||('PDF parser '+res.status))
  if(!blocks.length)throw new Error('PDF parser returned no readable text annotations')
  const text=blocks.map((block,i)=>'[PDF parser block '+String(i+1)+']\n'+block).join('\n\n')
  return{
    text,
    blocks:blocks.length,
    imageParts,
    hashes:[...new Set(hashes)],
    usage:raw?.usage||null,
    model:String(raw?.model||PDF_PARSE_MODEL),
  }
}

async function processPdfSource(job:QueueJob){
  const sourceId=String(job.message.source_id||'')
  if(!sourceId){await archive(job.msg_id);return 'invalid PDF job'}
  const source=await db.from('private_ai_knowledge_sources_read')
    .select('id,title,source_type,metadata,failure_count').eq('id',sourceId).maybeSingle()
  if(source.error)throw source.error
  if(!source.data){await finish(job.msg_id);return 'source deleted'}

  const meta:any=source.data.metadata||{}
  const path=String(meta.storage_path||''),title=String(source.data.title||meta.file_name||'document.pdf')
  if(!path.startsWith('uploads/'))throw new Error('PDF source is missing its private storage path')

  const updateMeta=async(stage:string,progress:number,extra:any={})=>{
    const next={...meta,...extra,pdf_stage:stage,pdf_progress:progress,updated_at:new Date().toISOString()}
    const q=await db.from('private_ai_knowledge_sources').update({
      metadata:next,status:'processing',last_error:null,updated_at:new Date().toISOString()
    }).eq('id',sourceId)
    if(q.error)throw q.error
    Object.assign(meta,next)
  }

  try{
    await updateMeta('ocr',20,{pdf_parser:'mistral-ocr'})
    const parsed=await parsePdfWithOpenRouter(path,title)
    const clean=String(parsed.text||'').trim()
    const wordCount=(clean.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)||[]).length
    if(clean.length<300||wordCount<50)throw new Error('PDF OCR produced too little readable text to index safely')

    await updateMeta('building_knowledge',65,{
      pdf_parser_blocks:parsed.blocks,
      pdf_extracted_images:parsed.imageParts,
      pdf_words:wordCount,
      pdf_chars:clean.length,
      pdf_parser_hashes:parsed.hashes,
    })

    const parts=chunkText(clean)
    if(!parts.length)throw new Error('PDF OCR produced no searchable chunks')
    const payload=[]
    for(let i=0;i<parts.length;i++){
      payload.push({chunk_index:i,content:parts[i],content_hash:await contentHash(parts[i])})
    }

    const replaced=await db.rpc('private_ai_replace_knowledge_chunks',{
      p_source_id:sourceId,
      p_content_hash:await contentHash(clean),
      p_char_count:clean.length,
      p_chunks:payload,
      p_metadata:{
        ...meta,
        pdf_stage:'indexing',
        pdf_progress:80,
        pdf_parser_blocks:parsed.blocks,
        pdf_extracted_images:parsed.imageParts,
        pdf_words:wordCount,
        pdf_chars:clean.length,
        pdf_parser_hashes:parsed.hashes,
      },
    })
    if(replaced.error)throw replaced.error

    const removed=await db.storage.from(ATTACHMENT_BUCKET).remove([path])
    if(!removed.error){
      meta.storage_path=''
      meta.original_deleted=true
      meta.original_deleted_at=new Date().toISOString()
      await db.from('private_ai_knowledge_sources').update({
        metadata:{...meta,pdf_stage:'indexing',pdf_progress:82,pdf_parser_blocks:parsed.blocks,pdf_words:wordCount,pdf_chars:clean.length},
        updated_at:new Date().toISOString()
      }).eq('id',sourceId)
    }

    if(parsed.usage){
      try{await db.from('private_ai_usage').insert({
        conversation_id:null,model:parsed.model,operation:'pdf_ocr',
        prompt_tokens:Number(parsed.usage.prompt_tokens||0),
        completion_tokens:Number(parsed.usage.completion_tokens||0),
        total_tokens:Number(parsed.usage.total_tokens||0),
        cost_usd:Number(parsed.usage.cost||0),
      })}catch{}
    }

    await finish(job.msg_id)
    return 'PDF OCR built '+String(payload.length)+' searchable chunks'
  }catch(e){
    const message=e instanceof Error?e.message:String(e)
    const failures=Number(source.data.failure_count||0)+1
    const final=failures>=5
    const q=await db.from('private_ai_knowledge_sources').update({
      failure_count:failures,
      last_error:message.slice(0,1800),
      status:final?'failed':'processing',
      metadata:{...meta,pdf_stage:final?'failed':'retrying',pdf_progress:final?100:10},
      updated_at:new Date().toISOString(),
    }).eq('id',sourceId)
    if(q.error)console.error('failed to record PDF error',q.error)
    if(final){await archive(job.msg_id);return 'PDF failed after retries: '+message}
    throw e
  }
}

async function processMediaSource(job:QueueJob){
  const sourceId=String(job.message.source_id||'')
  if(!sourceId){await archive(job.msg_id);return 'invalid media job'}
  const source=await db.from('private_ai_knowledge_sources_read')
    .select('id,title,source_type,metadata,failure_count').eq('id',sourceId).maybeSingle()
  if(source.error)throw source.error
  if(!source.data){await finish(job.msg_id);return 'source deleted'}

  const meta:any=source.data.metadata||{}
  const path=String(meta.storage_path||''),title=String(source.data.title||meta.file_name||'Media')
  const mime=String(meta.mime||''),size=Number(meta.file_size||0),mode=String(meta.media_mode||'full')
  if(!path.startsWith('uploads/'))throw new Error('Media source is missing its private storage path')

  const updateMeta=async(stage:string,progress:number,extra:any={})=>{
    const next={...meta,...extra,media_stage:stage,media_progress:progress,updated_at:new Date().toISOString()}
    const q=await db.from('private_ai_knowledge_sources').update({metadata:next,status:'processing',last_error:null,updated_at:new Date().toISOString()}).eq('id',sourceId)
    if(q.error)throw q.error
    Object.assign(meta,next)
  }

  try{
    await updateMeta('transcribing',20)
    let transcript:any=null,visual:any=null,transcriptError='',visualError=''

    try{transcript=await transcribeSmallMedia(path,mime,String(meta.file_name||title),size)}
    catch(e){transcriptError=e instanceof Error?e.message:String(e)}

    if(source.data.source_type==='video'&&mode!=='transcript'){
      await updateMeta('analyzing_visuals',45,{transcription_available:Boolean(transcript)})
      try{visual=await analyzeVideo(path,title)}catch(e){visualError=e instanceof Error?e.message:String(e)}
    }

    if(!transcript&&!visual)throw new Error('Media processing failed. '+[transcriptError,visualError].filter(Boolean).join(' · '))

    const segments:any[]=[]
    if(transcript?.segments?.length){
      for(const s of transcript.segments){
        segments.push({start:s.start,end:s.end,topic:'Transcript',spoken:s.text,visual:''})
      }
    }
    if(visual?.parsed?.segments?.length){
      for(const s of visual.parsed.segments){
        const start=Number(s.start||0),end=Number(s.end||start)
        segments.push({start,end,topic:String(s.topic||'Video'),spoken:String(s.spoken||''),visual:String(s.visual||'')})
      }
    }
    if(!segments.length&&transcript?.text){
      segments.push({start:0,end:Number(visual?.parsed?.duration_seconds||0),topic:'Transcript',spoken:transcript.text,visual:''})
    }
    segments.sort((a,b)=>a.start-b.start)

    const payload:any[]=[]
    const seen=new Set<string>()
    for(const s of segments){
      const body=[
        '['+tsLabel(s.start)+'-'+tsLabel(s.end)+'] '+String(s.topic||'Reference'),
        s.spoken?('Spoken: '+String(s.spoken).trim()):'',
        s.visual?('Visual: '+String(s.visual).trim()):'',
      ].filter(Boolean).join('\n').trim()
      if(!body||seen.has(body))continue
      seen.add(body)
      payload.push({chunk_index:payload.length,content:body,content_hash:await contentHash(body)})
    }
    if(visual?.parsed?.summary){
      const summary='[VIDEO OVERVIEW]\n'+String(visual.parsed.summary).trim()
      payload.unshift({chunk_index:0,content:summary,content_hash:await contentHash(summary)})
      payload.forEach((p,i)=>p.chunk_index=i)
    }
    if(!payload.length)throw new Error('Media processing produced no searchable reference sections')

    await updateMeta('building_knowledge',70,{
      duration_seconds:Number(visual?.parsed?.duration_seconds||transcript?.duration||0),
      transcript_method:transcript?'timestamped_transcription':(source.data.source_type==='video'?'visual_video_analysis':'unavailable'),
      visual_analysis:Boolean(visual),
      transcript_error:transcriptError||null,
      visual_error:visualError||null,
      reference_sections:payload.length,
    })

    const joined=payload.map(p=>p.content).join('\n\n')
    const replaced=await db.rpc('private_ai_replace_knowledge_chunks',{
      p_source_id:sourceId,
      p_content_hash:await contentHash(joined),
      p_char_count:joined.length,
      p_chunks:payload,
      p_metadata:{...meta,media_stage:'indexing',media_progress:80,reference_sections:payload.length},
    })
    if(replaced.error)throw replaced.error

    // Privacy default: once searchable references exist, remove the raw media object.
    const removed=await db.storage.from(ATTACHMENT_BUCKET).remove([path])
    if(removed.error)console.error('raw media cleanup failed',removed.error)
    else{
      meta.storage_path=''
      meta.original_deleted=true
      meta.original_deleted_at=new Date().toISOString()
      const cleaned=await db.from('private_ai_knowledge_sources').update({
        metadata:{...meta,media_stage:'indexing',media_progress:82,reference_sections:payload.length},
        updated_at:new Date().toISOString()
      }).eq('id',sourceId)
      if(cleaned.error)console.error('media metadata cleanup failed',cleaned.error)
    }

    if(transcript?.usage){
      try{await db.from('private_ai_usage').insert({
        conversation_id:null,model:MEDIA_TRANSCRIBE_MODEL,operation:'media_transcription',
        prompt_tokens:Number(transcript.usage.prompt_tokens||0),completion_tokens:Number(transcript.usage.completion_tokens||0),
        total_tokens:Number(transcript.usage.total_tokens||0),cost_usd:Number(transcript.usage.cost||0)
      })}catch{}
    }
    if(visual?.usage){
      try{await db.from('private_ai_usage').insert({
        conversation_id:null,model:visual.model,operation:'media_visual_analysis',
        prompt_tokens:Number(visual.usage.prompt_tokens||0),completion_tokens:Number(visual.usage.completion_tokens||0),
        total_tokens:Number(visual.usage.total_tokens||0),cost_usd:Number(visual.usage.cost||0)
      })}catch{}
    }
    await finish(job.msg_id)
    return 'media reference built: '+String(payload.length)+' timestamped sections'
  }catch(e){
    const message=e instanceof Error?e.message:String(e)
    const failures=Number(source.data.failure_count||0)+1
    const final=failures>=5
    const q=await db.from('private_ai_knowledge_sources').update({
      failure_count:failures,last_error:message.slice(0,1800),
      status:final?'failed':'processing',
      metadata:{...meta,media_stage:final?'failed':'retrying',media_progress:final?100:10},
      updated_at:new Date().toISOString()
    }).eq('id',sourceId)
    if(q.error)console.error('failed to record media error',q.error)
    if(final){await archive(job.msg_id);return 'media failed after retries: '+message}
    throw e
  }
}

async function processHtmlReprocess(job: QueueJob) {
  const sourceId=String(job.message.source_id||'')
  if(!sourceId){await archive(job.msg_id);return 'invalid HTML reprocess job'}

  const source=await db.from('private_ai_knowledge_sources_read')
    .select('id,title,char_count,metadata').eq('id',sourceId).maybeSingle()
  if(source.error)throw source.error
  if(!source.data){await finish(job.msg_id);return 'source deleted'}

  const rows:any[]=[]
  for(let from=0;;from+=1000){
    const page=await db.from('private_ai_knowledge_chunks_read')
      .select('chunk_index,content').eq('source_id',sourceId)
      .order('chunk_index',{ascending:true}).range(from,from+999)
    if(page.error)throw page.error
    const batch=page.data||[]
    rows.push(...batch)
    if(batch.length<1000)break
  }
  if(!rows.length)throw new Error('HTML source has no chunks to rebuild')

  const raw=reconstructChunks(rows)
  const cleaned=htmlToText(raw)
  if(cleaned.length<200)throw new Error('HTML cleanup found too little readable text')

  const parts=chunkText(cleaned)
  const payload=[]
  for(let i=0;i<parts.length;i++){
    payload.push({chunk_index:i,content:parts[i],content_hash:await contentHash(parts[i])})
  }
  const hash=await contentHash(cleaned)
  const metadata={
    ...(source.data.metadata||{}),
    cleaned_html:true,
    original_char_count:Number(source.data.char_count||raw.length),
    cleaned_char_count:cleaned.length,
    reprocessed_at:new Date().toISOString(),
  }
  const replaced=await db.rpc('private_ai_replace_knowledge_chunks',{
    p_source_id:sourceId,
    p_content_hash:hash,
    p_char_count:cleaned.length,
    p_chunks:payload,
    p_metadata:metadata,
  })
  if(replaced.error)throw replaced.error
  await finish(job.msg_id)
  return 'HTML cleaned: '+String(rows.length)+' raw chunks -> '+String(replaced.data||parts.length)+' readable chunks'
}

async function processSummary(job: QueueJob) {
  const conversationId = String(job.message.conversation_id || '')
  const target = Number(job.message.target_message_count || 0)
  if (!conversationId || !target) { await archive(job.msg_id); return 'invalid summary job' }

  const conv = await db.from('private_ai_conversations_read')
    .select('id,title,rolling_summary,summary_through_message_count,total_message_count,summary_version')
    .eq('id', conversationId).maybeSingle()
  if (conv.error) throw conv.error
  if (!conv.data) { await finish(job.msg_id); return 'conversation deleted' }

  const through = Number(conv.data.summary_through_message_count || 0)
  const actualTarget = Math.min(target, Number(conv.data.total_message_count || target))
  if (actualTarget <= through) { await finish(job.msg_id); return 'summary already current' }

  const msgs = await db.from('private_ai_messages_read')
    .select('role,content,created_at').eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .range(through, Math.max(through, actualTarget - 1))
  if (msgs.error) throw msgs.error

  const transcript = (msgs.data || []).map((m: any, i: number) =>
    String(through + i + 1) + '. ' + String(m.role).toUpperCase() + ': ' + String(m.content).slice(0, 18000)
  ).join('\n\n')

  const result = await llm(
    'Maintain a rolling conversation summary for a personal AI. Return JSON only: {"summary":"..."}. Preserve user goals, decisions, preferences, definitions, commitments, important facts, unresolved questions, prior advice that later context depends on, and changes of mind. Drop greetings, repetition, filler, transient wording, and details that do not help future continuity. Never invent facts. Write a compact but information-dense summary that another AI can use as prior context.',
    'CHAT TITLE: ' + String(conv.data.title || 'Untitled') +
      '\n\nPREVIOUS ROLLING SUMMARY:\n' + String(conv.data.rolling_summary || '(none)') +
      '\n\nNEW MESSAGES TO INCORPORATE:\n' + transcript,
    'summary',
    conversationId,
  )

  const summary = String(result.summary || '').trim()
  if (!summary) throw new Error('Summary model returned no summary')

  const saved = await db.from('private_ai_conversations').update({
    rolling_summary: summary,
    summary_through_message_count: actualTarget,
    summary_version: Number(conv.data.summary_version || 0) + 1,
    summary_updated_at: new Date().toISOString(),
  }).eq('id', conversationId)
  if (saved.error) throw saved.error

  await finish(job.msg_id)
  return 'summarized through ' + String(actualTarget)
}

async function processMemories(job: QueueJob) {
  const conversationId = String(job.message.conversation_id || '')
  if (!conversationId) { await archive(job.msg_id); return 'invalid memory job' }

  const conv = await db.from('private_ai_conversations_read')
    .select('title,rolling_summary').eq('id', conversationId).maybeSingle()
  if (conv.error) throw conv.error
  if (!conv.data) { await finish(job.msg_id); return 'conversation deleted' }

  const recent = await db.from('private_ai_messages_read')
    .select('id,role,content,created_at').eq('conversation_id', conversationId)
    .order('created_at', { ascending: false }).limit(18)
  if (recent.error) throw recent.error
  const rows = (recent.data || []).reverse()
  if (!rows.length) { await finish(job.msg_id); return 'no messages' }

  const transcript = rows.map((m: any) =>
    String(m.role).toUpperCase() + ': ' + String(m.content).slice(0, 12000)
  ).join('\n\n')

  const result = await llm(
    'Extract durable personal memory for a private AI assistant. Return JSON only with shape {"memories":[{"memory_key":"stable_snake_case_key","content":"concise factual memory","category":"preference|goal|project|decision|routine|relationship|background|instruction|other","importance":1-10,"confidence":0-1}]}. Only store information the user explicitly supplied or clearly confirmed. Store things likely to matter in future conversations, not every detail. Include ongoing projects, durable preferences, goals, repeated routines, decisions, and standing instructions. Do not infer sensitive traits. Never store passwords, API keys, authentication codes, full account/card numbers, or other credentials. If a newer statement contradicts an older one, use the newer confirmed statement. Use the same memory_key for the same underlying fact so it updates instead of duplicating. Return at most 10 memories. Return an empty array if nothing is durable.',
    'CHAT: ' + String(conv.data.title || 'Untitled') +
      '\nROLLING CONTEXT:\n' + String(conv.data.rolling_summary || '(none)') +
      '\n\nRECENT MESSAGES:\n' + transcript,
    'memory',
    conversationId,
  )

  const memories = Array.isArray(result.memories) ? result.memories.slice(0, 10) : []
  for (const m of memories) {
    const rawKey = String(m?.memory_key || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120)
    const content = String(m?.content || '').trim().slice(0, 4000)
    if (!rawKey || !content) continue
    const key = await contentHash(rawKey)
    const vector = await embedding(content)
    const latestUserMessage = [...rows].reverse().find((r: any) => r.role === 'user')
    const row = {
      memory_key: key,
      content,
      category: String(m?.category || 'other').slice(0, 40),
      importance: Math.max(1, Math.min(10, Number(m?.importance || 5))),
      confidence: Math.max(0, Math.min(1, Number(m?.confidence ?? 0.8))),
      active: true,
      source_conversation_id: conversationId,
      source_message_id: latestUserMessage?.id || null,
      embedding: vector,
      updated_at: new Date().toISOString(),
    }
    const saved = await db.from('private_ai_memories').upsert(row, { onConflict: 'memory_key' })
    if (saved.error) throw saved.error
  }

  await finish(job.msg_id)
  return 'memory extraction: ' + String(memories.length)
}

async function processJob(job: QueueJob) {
  const type = String(job.message?.type || '')
  if (type === 'embed_knowledge_chunk') { await finish(job.msg_id); return 'legacy embedding job removed' }
  if (type === 'reprocess_html_source') return processHtmlReprocess(job)
  if (type === 'process_media_source') return processMediaSource(job)
  if (type === 'process_pdf_source') return processPdfSource(job)
  if (type === 'summarize_conversation') return processSummary(job)
  if (type === 'extract_memories') return processMemories(job)
  await archive(job.msg_id)
  return 'unknown job archived'
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405)
  const token = req.headers.get('x-worker-token') || ''
  if (!token) return json({ error: 'Worker token required' }, 401)

  const valid = await db.rpc('private_ai_validate_worker_token', { candidate: token })
  if (valid.error) return json({ error: valid.error.message }, 500)
  if (valid.data !== true) return json({ error: 'Unauthorized' }, 401)

  const started = new Date().toISOString()
  await db.from('private_ai_runtime_config').update({
    last_worker_run_at: started,
    last_worker_error: null,
    updated_at: started,
  }).eq('id', true)

  const results: any[] = []
  let workerError: string | null = null

  try {
    const knowledge = await processKnowledgeBatch()
    results.push({ type:'knowledge_batch', ok:true, ...knowledge })
  } catch (error) {
    workerError = error instanceof Error ? error.message : String(error)
    console.error('knowledge batch failed', workerError)
    results.push({ type:'knowledge_batch', ok:false, error:workerError })
  }

  try {
    const memories = await processMemoryBackfillBatch()
    if (memories) results.push({ type:'memory_embedding_backfill', ok:true, processed:memories })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!workerError) workerError = message
    console.error('memory embedding backfill failed', message)
    results.push({ type:'memory_embedding_backfill', ok:false, error:message })
  }

  const read = await db.rpc('private_ai_read_jobs', { qty: 1, visibility_seconds: 300 })
  if (read.error) {
    if (!workerError) workerError = read.error.message
    results.push({ type:'queue_read', ok:false, error:read.error.message })
  } else {
    const jobs = (read.data || []) as QueueJob[]
    for (const job of jobs) {
      try {
        const detail = await processJob(job)
        results.push({ id:job.msg_id, type:job.message?.type, ok:true, detail })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!workerError) workerError = message
        console.error('uncensor-worker job failed', { id:job.msg_id, type:job.message?.type, read_ct:job.read_ct, error:message })
        const providerMissing = message.includes('OPENROUTER_API_KEY')
        if (job.read_ct >= 8 && !providerMissing) {
          try { await archive(job.msg_id) } catch {}
        }
        results.push({ id:job.msg_id, type:job.message?.type, ok:false, error:message, retry:job.read_ct < 8 })
      }
    }
  }

  const now = new Date().toISOString()
  await db.from('private_ai_runtime_config').update({
    last_worker_success_at: workerError ? undefined : now,
    last_worker_error: workerError ? workerError.slice(0,2000) : null,
    backend_version: 'v7-private-pdf',
    updated_at: now,
  }).eq('id', true)

  return json({ ok: !workerError, embedding_model: EMBED_MODEL, batch_size: KNOWLEDGE_BATCH, results })
})
