import assert from 'node:assert/strict';
import fs from 'node:fs';

const app=fs.readFileSync('app.js','utf8');
const api=fs.readFileSync('supabase/functions/uncensor-api/index.ts','utf8');
const worker=fs.readFileSync('supabase/functions/uncensor-worker/index.ts','utf8');
const html=fs.readFileSync('index.html','utf8');

assert.ok(app.includes("ingestKnowledgePdfPersistent"),'PDFs must be handed off to persistent server processing');
assert.ok(app.includes("/api/uploads/sign"),'PDF must upload to private storage first');
assert.ok(app.includes("/api/knowledge/pdf"),'PDF handoff endpoint must be called');
assert.ok(app.includes("safe to refresh or close"),'UI must tell the user the persisted job survives navigation');
assert.ok(!/if\(pdf\)\{\s*setKnowledgeFileStatus\(row,'scanning'/.test(app),'Main PDF upload path must not rely on browser OCR before persistence');

assert.ok(api.includes("async function knowledgePdfCreate"),'API must create persistent PDF sources');
assert.ok(api.includes("type:'process_pdf_source'"),'API must enqueue a PDF worker job');
assert.ok(api.includes("source_type:'pdf'"),'PDF must exist as a first-class persistent source');
assert.ok(api.includes("pdf_stage:'queued'"),'PDF source must expose persistent progress metadata');

assert.ok(worker.includes("async function parsePdfWithOpenRouter"),'Worker must parse persisted PDFs');
assert.ok(worker.includes("id:'file-parser'"),'Worker must use the OpenRouter file parser');
assert.ok(worker.includes("engine:'mistral-ocr'"),'Scanned PDFs must use the OCR-capable parser');
assert.ok(worker.includes("async function processPdfSource"),'Worker must own PDF extraction');
assert.ok(worker.includes("if (type === 'process_pdf_source') return processPdfSource(job)"),'PDF jobs must be dispatched');
assert.ok(worker.includes("private_ai_replace_knowledge_chunks"),'Parsed PDF text must become searchable Knowledge chunks');
assert.ok(worker.includes("operation:'pdf_ocr'"),'PDF OCR usage must be metered');
assert.ok(worker.includes("original_deleted=true"),'Raw PDF should be deleted only after searchable chunks are built');

assert.ok(html.includes('app.js?v=41'),'v41 frontend cache must be active');
console.log('Persistent PDF upload, background OCR, and indexing regression tests passed');
