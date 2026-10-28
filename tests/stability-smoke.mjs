import fs from 'node:fs';

const app=fs.readFileSync('app.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const config=fs.readFileSync('config.js','utf8');
const api=fs.readFileSync('supabase/functions/uncensor-api/index.ts','utf8');

const fail=(m)=>{throw new Error(m)};
const expect=(v,m)=>{if(!v)fail(m)};

const htmlIds=[...html.matchAll(/\bid=["']([^"']+)["']/g)].map(x=>x[1]);
const duplicateIds=htmlIds.filter((id,i,a)=>a.indexOf(id)!==i);
expect(duplicateIds.length===0,'Duplicate HTML IDs: '+[...new Set(duplicateIds)].join(', '));

const appIds=[...app.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(x=>x[1]);
const missing=[...new Set(appIds)].filter(id=>!htmlIds.includes(id)&&id!=='emptyAddKnowledge');
expect(missing.length===0,'app.js references missing HTML IDs: '+missing.join(', '));

expect(/knowledgeFile[^>]+accept=["'][^"']*\.pdf/i.test(html),'Knowledge file picker must accept PDF files');
expect(app.includes("application/pdf")&&app.includes("extractKnowledgePdf"),'PDF Knowledge extraction support is missing');
expect(app.includes("/api/knowledge/ocr-page")&&api.includes("ocrPdfPage"),'PDF AI OCR fallback is missing');
expect(app.includes("/api/knowledge/pdf")&&api.includes("knowledgePdfCreate"),'Persistent PDF upload handoff is missing');
expect(api.includes("knowledgePageNumber")&&api.includes("[PDF page"),'PDF page-aware retrieval is missing');
expect(html.includes('app.js?v=41.2'),'Frontend cache version must be v41');
expect(html.includes('styles.css?v=41'),'Styles cache version must be v41');
expect(app.includes("/api/diagnostics")&&html.includes('id="runDiagnostics"'),'Diagnostics UI/endpoint wiring is missing');
expect(api.includes("if (path === '/api/diagnostics'"),'Diagnostics backend route is missing');
expect(api.includes('private_ai_match_chunks_scoped'),'Scoped Knowledge retrieval RPC is missing');
expect(api.includes('inspectKnowledgeSource')&&html.includes('id="knowledgeInspectorModal"'),'Knowledge Inspector backend/UI is missing');
expect(api.includes('retryKnowledgeSource')&&app.includes('retryKnowledgeFromRow'),'Persistent source retry is missing');
expect(api.includes('retrievalDebug')&&html.includes('id="retrievalDebugModal"'),'Retrieval debugger is missing');
expect(api.includes('knowledgeQuality')&&app.includes('knowledge-quality-chip'),'Knowledge quality scoring is missing');
expect(api.includes("const retrievalQuery=text || attachmentHint"),'Attachment-only retrieval fallback is missing');
expect(api.includes("TRANSCRIBE_MODEL"),'Current audio transcription model wiring is missing');
expect(app.includes("kind==='audio'?16*1024*1024"),'Direct-chat audio memory guard is missing');
expect(app.includes("serverHandoffStarted"),'Media upload handoff race guard is missing');
expect(api.includes("cleanup=await db.from('private_ai_knowledge_sources').delete()"),'Knowledge creation cleanup guard is missing');

for(const [name,text] of [['app.js',app],['index.html',html],['config.js',config]]){
  expect(!/SUPABASE_SERVICE_ROLE_KEY|OPENROUTER_API_KEY|sk-or-v1-|service_role/i.test(text),name+' appears to expose a server-side secret');
}

expect(!app.includes('sourceHtml=state.showSources'),'Visible source-chip lists must be removed from answers');
expect(app.includes('function messageSources(')&&html.includes('id="messageSourcesAction"'),'Sources must be available only through the message action menu');
expect(app.includes('refreshFinishedRun(run)'),'Streaming responses must refresh the completed cited answer');

console.log('Stability smoke tests passed');
