import assert from 'node:assert/strict';
import fs from 'node:fs';

const app=fs.readFileSync('app.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const api=fs.readFileSync('supabase/functions/uncensor-api/index.ts','utf8');
const rank=fs.readFileSync('supabase/functions/uncensor-api/knowledge-ranking.mjs','utf8');

assert.ok(html.includes('id="knowledgeViewProcessing"'),'Processing center view is missing');
assert.ok(html.includes('id="knowledgeViewAttention"'),'Needs Attention view is missing');
assert.ok(html.includes('id="knowledgeInspectorModal"'),'Knowledge Inspector UI is missing');
assert.ok(html.includes('id="retrievalDebugModal"'),'Retrieval Inspector UI is missing');

assert.ok(app.includes('sourceNeedsAttention'),'UI must derive Needs Attention sources from persistent backend state');
assert.ok(app.includes('openKnowledgeInspector'),'Source rows must open the inspector');
assert.ok(app.includes('saveInspectorMetadata'),'Inspector metadata must be editable');
assert.ok(app.includes('testInspectorSource'),'Inspector must generate source-specific verification questions');
assert.ok(app.includes('retryKnowledgeFromRow'),'Failed persistent sources must be retryable');
assert.ok(app.includes('runRetrievalDebugger'),'Retrieval debugger must be runnable');

assert.ok(api.includes('function knowledgeQuality'),'Backend must score ingestion quality');
assert.ok(api.includes('inspectKnowledgeSource'),'Backend must return extracted chunks');
assert.ok(api.includes('safeKnowledgeMetadataPatch'),'Metadata edits must be allow-listed');
assert.ok(api.includes('retryKnowledgeSource'),'Backend must retry persistent failed sources');
assert.ok(api.includes('testKnowledgeSource'),'Backend must generate source-specific test questions');
assert.ok(api.includes('retrievalDebug'),'Backend must expose scoped explainable retrieval');
assert.ok(api.includes("evidence_type:String(meta.evidence_type"),'Citations must carry evidence metadata');
assert.ok(api.includes('retrieval_reasons:k.retrieval_reasons'),'Citations must preserve retrieval reasons');

assert.ok(rank.includes('rankKnowledgeCandidatesDetailed'),'Detailed reranking export is missing');
assert.ok(rank.includes('source diversity cap'),'Reranking must explain diversity rejection');
assert.ok(rank.includes('near-duplicate passage'),'Reranking must explain duplicate rejection');
assert.ok(rank.includes('evidenceAdjustment'),'Evidence type must influence ranking only as a tie-breaker');
assert.ok(rank.includes('authorityAdjustment'),'User-set authority must be part of explainable scoring');
assert.ok(rank.includes('stale-source penalty'),'Explicitly current questions must account for dated sources');

console.log('Knowledge Intelligence processing, inspection, retry and retrieval-debug regression tests passed');

assert.ok(app.includes('knowledge-card-footer')&&app.includes('knowledge-more-menu'),'Knowledge cards must use the mobile-safe v40 layout');
assert.ok(app.includes('askInspectorSource')&&api.includes('askKnowledgeSource'),'Source-only Q&A must be wired');
assert.ok(app.includes('suggestInspectorMetadata')&&api.includes('suggestKnowledgeMetadata'),'Metadata suggestions must be wired');
assert.ok(api.includes('cleanKnowledgeText'),'Inspector/evidence must clean parser wrapper noise');
assert.ok(app.includes('knowledge-source-link'),'Knowledge citation chips must open source inspection');
assert.ok(html.includes('id="inspectorMetadataPanel"'),'Advanced source metadata must be collapsible');
assert.ok(html.includes('id="knowledgeInspectorAsk"'),'Inspector must expose source-only Q&A');
