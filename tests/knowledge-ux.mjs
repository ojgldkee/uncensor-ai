import assert from 'node:assert/strict';
import fs from 'node:fs';

const app=fs.readFileSync('app.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('styles.css','utf8');
const api=fs.readFileSync('supabase/functions/uncensor-api/index.ts','utf8');
const worker=fs.readFileSync('supabase/functions/uncensor-worker/index.ts','utf8');

assert.ok(app.includes('knowledge-card-footer')&&app.includes('knowledge-more'),'Source cards must separate primary and secondary actions');
assert.ok(css.includes('.knowledge-card-footer')&&css.includes('.knowledge-more-menu'),'Mobile card action layout must be styled');
assert.ok(css.includes('.knowledge-badge-row'),'Quality/scope badges must live in their own wrapping row');
assert.ok(!app.includes("meta.pdf_parser_blocks?' · '+Number(meta.pdf_parser_blocks)+' parsed blocks'"),'Technical parser-block counts should not clutter ready cards');
assert.ok(app.includes("status==='ready'"),'Ready cards must normalize completed status text');

assert.ok(html.includes('id="inspectorMetadataPanel"'),'Advanced metadata must be collapsed behind details');
assert.ok(html.includes('id="knowledgeInspectorAsk"')&&html.includes('id="askInspectorSource"'),'Source-only question UI is required');
assert.ok(html.includes('id="suggestInspectorMetadata"'),'Metadata suggestion control is required');
assert.ok(app.includes('source-test-question')&&app.includes('Ask this'),'Generated verification questions must be one-tap actions');

assert.ok(api.includes('async function askKnowledgeSource'),'Source-only answer endpoint is required');
assert.ok(api.includes('using ONLY the supplied excerpts'),'Source-only Q&A must prohibit silent outside knowledge');
assert.ok(api.includes('async function suggestKnowledgeMetadata'),'Metadata suggestion endpoint is required');
assert.ok(api.includes('Do not invent an author or date'),'Metadata suggestions must be conservative');
assert.ok(api.includes('cleanKnowledgeText'),'Existing indexed parser noise must be stripped before display/answering');
assert.ok(worker.includes('cleanPdfParserBlock'),'New PDF parser wrapper noise must be stripped before indexing');

assert.ok(app.includes('knowledge-source-link')&&app.includes('openKnowledgeInspector({id:btn.dataset.sourceId'),'Knowledge citation chips must open the exact saved source');
assert.ok(html.includes('app.js?v=40')&&html.includes('styles.css?v=40'),'v40 cache URLs must be active');

console.log('v40 Knowledge UX, source verification, parser cleanup and citation navigation tests passed');
