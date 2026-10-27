import assert from 'node:assert/strict';
import { rankKnowledgeCandidates, rankKnowledgeCandidatesDetailed } from '../supabase/functions/uncensor-api/knowledge-ranking.mjs';

const query='Why is my Meta Facebook ads CPM so high, and how should I diagnose creative fatigue?';
const candidates=[
  {id:1,source_id:'payments',title:'Nominee merchant processing',content:'Set up payment processors and protect your business. Facebook ads help increase sales.',similarity:.52,chunk_index:0,metadata:{evidence_type:'community',authority:2}},
  {id:2,source_id:'meta',title:'Meta CPM diagnosis',content:'Investigate CPM through auction competition, audience overlap, conversion data, creative fatigue, frequency and first-three-second hook performance.',similarity:.48,chunk_index:0,metadata:{evidence_type:'official',authority:5}},
  {id:3,source_id:'creative',title:'Creative fatigue symptoms',content:'Check creative fatigue with falling outbound CTR, increasing frequency, rising CPM, changes in hook performance and CPA before changing the whole account.',similarity:.45,chunk_index:0,metadata:{evidence_type:'practitioner',authority:4}},
  {id:4,source_id:'meta',title:'Meta CPM diagnosis',content:'Investigate CPM through auction competition, audience overlap, conversion data, creative fatigue, frequency and first-three-second hook performance.',similarity:.47,chunk_index:1,metadata:{evidence_type:'official',authority:5}},
];
const ranked=rankKnowledgeCandidates(query,candidates);
assert.equal(ranked[0].source_id,'meta','Direct official evidence should outrank vaguely related payments material');
assert.ok(ranked.some(x=>x.source_id==='creative'),'Complementary practitioner evidence should be included');
assert.equal(ranked.filter(x=>x.source_id==='meta').length,1,'Duplicated chunks should not flood context');
assert.deepEqual(rankKnowledgeCandidates(query,[]),[],'Empty knowledge stays empty');
assert.equal(rankKnowledgeCandidates(query,candidates,{limit:1}).length,1,'Context budget must be respected');

const detailed=rankKnowledgeCandidatesDetailed(query,candidates);
assert.equal(detailed.selected.length,ranked.length);
assert.ok(detailed.evaluated.some(x=>x.selected&&Array.isArray(x.retrieval_reasons)&&x.retrieval_reasons.length),'Selected candidates explain why they were chosen');
assert.ok(detailed.evaluated.some(x=>!x.selected&&x.rejection_reason),'Rejected candidates expose a reason');

const many=Array.from({length:20},(_,i)=>({
  id:100+i,source_id:'same',title:'Campaign diagnostics '+i,
  content:'CPM creative fatigue diagnosis phase '+i+' unique'+i+' example',
  similarity:.55-i*.005,chunk_index:i,metadata:{evidence_type:'practitioner',authority:4}
}));
assert.ok(rankKnowledgeCandidates(query,many,{limit:12,perSource:2}).length<=2,'One source may not dominate');

const diagnosisCandidates=[
  {id:201,source_id:'blog',title:'General ad blog',content:'Campaign CPA and conversion diagnosis from a generic example.',similarity:.51,chunk_index:0,metadata:{evidence_type:'reference',authority:3}},
  {id:202,source_id:'account',title:'My campaign export',content:'My campaign CPM CTR CPC CPA purchases spend and conversion results.',similarity:.49,chunk_index:0,metadata:{evidence_type:'personal_data',authority:4}},
];
assert.equal(rankKnowledgeCandidates('Diagnose my campaign CPM CTR and CPA',diagnosisCandidates)[0].source_id,'account','Actual user data should get a small diagnosis-specific preference when relevance is similar');

console.log('Knowledge ranking and explainability regression tests passed');

import fs from 'node:fs';
const api=fs.readFileSync('supabase/functions/uncensor-api/index.ts','utf8');
const schema=fs.readFileSync('supabase/backend_v3.sql','utf8');
assert.match(api,/rankKnowledgeCandidatesDetailed\(query,candidates/,'API must rerank broad candidates with debug metadata');
assert.match(api,/match_count:100/,'API must retrieve a broad candidate pool before reranking');
assert.match(api,/include_global:includeGlobal/,'API must preserve Global setting');
assert.match(api,/knowledgeSourceMeta\(ctx.knowledge\)/,'API must bind cited refs to selected chunks');
assert.match(api,/EVIDENCE_RULES/,'Source citation rules must apply in chat and web research');
assert.match(api,/do not manufacture agreement or average their numbers into a fake compromise/,'Contradiction instructions must forbid fake reconciliation');
assert.match(schema,/private_ai_match_chunks_scoped_v2/,'Scoped candidate RPC must be versioned in schema');
assert.match(schema,/ck.conversation_id=target_conversation_id/,'DB must filter to chat sources');
assert.match(schema,/include_global=true and s.global_enabled=true/,'Global must require explicit opt-in');
