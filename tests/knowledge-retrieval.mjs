import assert from 'node:assert/strict';
import { rankKnowledgeCandidates } from '../supabase/functions/uncensor-api/knowledge-ranking.mjs';

const query = 'Why is my Meta Facebook ads CPM so high, and how should I diagnose creative fatigue?';
const candidates = [
  { id:1,source_id:'payments',title:'Nominee merchant processing',content:'Set up payment processors and protect your business. Facebook ads help increase sales.',similarity:.52,chunk_index:0 },
  { id:2,source_id:'meta',title:'Meta CPM diagnosis',content:'Investigate CPM through auction competition, audience overlap, conversion data, creative fatigue, frequency and first-three-second hook performance.',similarity:.48,chunk_index:0 },
  { id:3,source_id:'creative',title:'Creative fatigue symptoms',content:'Check creative fatigue with falling outbound CTR, increasing frequency, rising CPM, changes in hook performance and CPA before changing the whole account.',similarity:.45,chunk_index:0 },
  { id:4,source_id:'meta',title:'Meta CPM diagnosis',content:'Investigate CPM through auction competition, audience overlap, conversion data, creative fatigue, frequency and first-three-second hook performance.',similarity:.47,chunk_index:1 },
];
const ranked = rankKnowledgeCandidates(query,candidates);
assert.equal(ranked[0].source_id,'meta','Direct answer should outrank vaguely related payment source');
assert.ok(ranked.some(x=>x.source_id==='creative'),'Complementary evidence should be included');
assert.equal(ranked.filter(x=>x.source_id==='meta').length,1,'Duplicated chunks should not flood context');
assert.deepEqual(rankKnowledgeCandidates(query,[]),[],'Empty knowledge stays empty');
assert.equal(rankKnowledgeCandidates(query,candidates,{limit:1}).length,1,'Context budget must be respected');
const many = Array.from({length:20},(_,i)=>({
 id:100+i,source_id:'same',title:'Campaign diagnostics '+i,content:'CPM creative fatigue diagnosis phase '+i+' unique'+i+' example',similarity:.55-i*.005,chunk_index:i
}));
assert.ok(rankKnowledgeCandidates(query,many,{limit:12,perSource:2}).length<=2,'One source may not dominate');
assert.ok(!ranked.some(x=>x.relevance_score==null),'Selected chunks have deterministic relevance signals');
console.log('Knowledge ranking regression tests passed');

import fs from 'node:fs';
const api=fs.readFileSync('supabase/functions/uncensor-api/index.ts','utf8');
const schema=fs.readFileSync('supabase/backend_v3.sql','utf8');
assert.match(api,/rankKnowledgeCandidates\(query,candidates/,'API must rerank broad candidates');
assert.match(api,/include_global:includeGlobal/,'API must preserve Global setting');
assert.match(api,/knowledgeSourceMeta\(ctx.knowledge\)/,'API must bind cited refs to selected chunks');
assert.match(api,/EVIDENCE_RULES/,'Source citation rules must apply in chat and web research');
assert.match(schema,/private_ai_match_chunks_scoped_v2/,'Scoped candidate RPC must be versioned in schema');
assert.match(schema,/ck.conversation_id=target_conversation_id/,'DB must filter to chat sources');
assert.match(schema,/include_global=true and s.global_enabled=true/,'Global must require explicit opt-in');
