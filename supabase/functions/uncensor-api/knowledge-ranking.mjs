// Deterministic, private reranking. Candidate text never leaves the private API.
const COMMON = new Set(
  'a an and are as at be been but by can could do does for from had has have how i if in into is it its me my of on or our should so than that the their them there these this to use using was were what when where which who why will with would you your about after before best better good great most more much very just really please give tell explain help make get run running work works way need want know all any some each other one two three 2024 2025 2026 2027'.split(' ')
);
const WEAK_DOMAIN = new Set('facebook meta ad ads advertising marketing campaign campaigns ecommerce ecom business'.split(' '));
const EVIDENCE_BONUS = {
  official: 0.05,
  research: 0.045,
  personal_data: 0.045,
  practitioner: 0.025,
  reference: 0.012,
  community: 0,
  unrated: 0,
};

function term(value) {
  const word = String(value).toLowerCase();
  if (word.length > 5 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 6 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}
function tokens(value) {
  return [...new Set((String(value || '').normalize('NFKC').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter(w => !COMMON.has(w)).map(term))];
}
function similarityOf(row) {
  const score = Number(row?.similarity);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}
function intersectionCount(a, b) {
  let matched = 0;
  for (const item of a) if (b.has(item)) matched++;
  return matched;
}
function sourceMeta(row) {
  const m = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const evidence = String(m.evidence_type || 'unrated').toLowerCase();
  const authority = Math.max(1, Math.min(5, Number(m.authority || 3)));
  return { m, evidence: Object.hasOwn(EVIDENCE_BONUS,evidence) ? evidence : 'unrated', authority };
}
function queryIntent(query) {
  const q = String(query || '').toLowerCase();
  return {
    diagnosis: /(my|our).{0,30}(ad|campaign|cpm|ctr|cpc|cpa|roas|conversion|sales|funnel|account)|diagnos|troubleshoot|why (?:is|are|did|does)/.test(q),
    current: /(current|currently|latest|today|now|this week|this month|this year|2026|2027)/.test(q),
  };
}
function recencyAdjustment(row, intent) {
  if (!intent.current) return 0;
  const date = String(row?.metadata?.source_date || row?.source_created_at || '');
  if (!date) return 0;
  const ms = Date.parse(date);
  if (!Number.isFinite(ms)) return 0;
  const ageDays = Math.max(0,(Date.now()-ms)/86400000);
  if (ageDays <= 365) return 0.02;
  if (ageDays > 1095) return -0.055;
  if (ageDays > 730) return -0.035;
  return 0;
}
function nearlySame(a, b) {
  if (String(a.source_id) !== String(b.source_id)) return false;
  if (Number(a.chunk_index) === Number(b.chunk_index)) return true;
  const aw = new Set(tokens(String(a.content || '').slice(0, 1200)));
  const bw = new Set(tokens(String(b.content || '').slice(0, 1200)));
  if (Math.min(aw.size, bw.size) < 9) return false;
  const shared = intersectionCount(aw, bw);
  return shared / Math.max(aw.size, bw.size) >= 0.87;
}
function publicEval(row) {
  const {
    _coverage,_titleCoverage,_matched,_titleMatched,_semantic,_authorityAdjustment,
    _evidenceAdjustment,_recencyAdjustment,_directness,_selected,...clean
  } = row;
  return clean;
}

/**
 * Evaluate broad semantic candidates using exact query overlap, source authority,
 * recency when the question is explicitly current, source diversity and duplicate removal.
 * Metadata is user-controlled and therefore only a small tie-breaker, never a truth oracle.
 */
export function rankKnowledgeCandidatesDetailed(query, rows, { limit = 12, perSource = 3 } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  if (!input.length) return { selected: [], evaluated: [] };

  const allTerms = tokens(query).slice(0, 40);
  const specificTerms = allTerms.filter(w => !WEAK_DOMAIN.has(w));
  const terms = specificTerms.length >= 2 ? specificTerms : allTerms;
  const bestSimilarity = Math.max(...input.map(similarityOf));
  const intent = queryIntent(query);

  const evaluated = input.map(row => {
    const semantic = similarityOf(row);
    const bodyTerms = new Set(tokens(String(row.content || '').slice(0, 7000)));
    const titleTerms = new Set(tokens(row.title || ''));
    const matched = intersectionCount(terms, bodyTerms);
    const titleMatched = intersectionCount(terms, titleTerms);
    const coverage = terms.length ? matched / terms.length : 0;
    const titleCoverage = terms.length ? titleMatched / terms.length : 0;
    const directness = matched >= 3 ? 0.045 : matched >= 2 ? 0.03 : matched === 0 && terms.length >= 2 ? -0.09 : 0;
    const { evidence, authority } = sourceMeta(row);
    let evidenceAdjustment = Number(EVIDENCE_BONUS[evidence] || 0);
    if (intent.diagnosis && evidence === 'personal_data') evidenceAdjustment += 0.035;
    else if (intent.diagnosis && evidence === 'official') evidenceAdjustment += 0.02;
    const authorityAdjustment = (authority - 3) * 0.0125;
    const recent = recencyAdjustment(row,intent);
    const score = 0.62 * semantic + 0.25 * coverage + 0.08 * titleCoverage + directness +
      evidenceAdjustment + authorityAdjustment + recent;
    const reasons = [
      'semantic '+semantic.toFixed(2),
      terms.length ? 'query overlap '+Math.round(coverage*100)+'%' : 'semantic-only query',
      titleCoverage > 0 ? 'title match '+Math.round(titleCoverage*100)+'%' : '',
      evidence !== 'unrated' ? 'evidence '+evidence.replaceAll('_',' ') : '',
      authority !== 3 ? 'authority '+authority+'/5' : '',
      recent > 0 ? 'recent-source boost' : recent < 0 ? 'stale-source penalty' : '',
    ].filter(Boolean);
    return {
      ...row,
      similarity: semantic,
      evidence_type: evidence,
      authority,
      relevance_score: Number(score.toFixed(4)),
      retrieval_reasons: reasons,
      rejection_reason: null,
      _coverage: coverage,
      _titleCoverage: titleCoverage,
      _matched: matched,
      _titleMatched: titleMatched,
      _semantic: semantic,
      _authorityAdjustment: authorityAdjustment,
      _evidenceAdjustment: evidenceAdjustment,
      _recencyAdjustment: recent,
      _directness: directness,
      _selected: false,
    };
  }).sort((a,b)=>b.relevance_score-a.relevance_score || b.similarity-a.similarity);

  const maxScore = evaluated[0]?.relevance_score || 0;
  const selected = [];
  const counts = new Map();

  for (const row of evaluated) {
    const source = String(row.source_id || '');
    if (!source || !String(row.content || '').trim()) {
      row.rejection_reason='empty candidate';
      continue;
    }
    if (row.similarity < Math.max(0.18,bestSimilarity-0.2) && row._coverage < 0.35) {
      row.rejection_reason='too weak semantically for this question';
      continue;
    }
    if (row.relevance_score < maxScore*0.66 && row._coverage < 0.5) {
      row.rejection_reason='lower relevance than stronger candidates';
      continue;
    }
    if ((counts.get(source)||0) >= perSource) {
      row.rejection_reason='source diversity cap';
      continue;
    }
    if (selected.some(other=>nearlySame(other,row))) {
      row.rejection_reason='near-duplicate passage';
      continue;
    }
    if (selected.length >= limit) {
      row.rejection_reason='context limit reached';
      continue;
    }
    row._selected=true;
    counts.set(source,(counts.get(source)||0)+1);
    selected.push(row);
  }

  return {
    selected:selected.map(publicEval),
    evaluated:evaluated.map(row=>({
      id:row.id,
      source_id:row.source_id,
      title:row.title,
      chunk_index:row.chunk_index,
      similarity:row.similarity,
      relevance_score:row.relevance_score,
      evidence_type:row.evidence_type,
      authority:row.authority,
      retrieval_reasons:row.retrieval_reasons,
      selected:row._selected,
      rejection_reason:row.rejection_reason,
      content_preview:String(row.content||'').replace(/\s+/g,' ').trim().slice(0,240),
    }))
  };
}

export function rankKnowledgeCandidates(query, rows, options = {}) {
  return rankKnowledgeCandidatesDetailed(query, rows, options).selected;
}
