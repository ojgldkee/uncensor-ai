// Local, deterministic ranking of decrypted candidates returned only by a scoped server RPC.
// No user content leaves the private API for reranking.
const COMMON = new Set(
  'a an and are as at be been but by can could do does for from had has have how i if in into is it its me my of on or our should so than that the their them there these this to use using was were what when where which who why will with would you your about after before best better good great most more much very just really please give tell explain help make get run running work works way need want know all any some each other one two three 2024 2025 2026 2027'.split(' ')
);
const WEAK_DOMAIN = new Set('facebook meta ad ads advertising marketing campaign campaigns'.split(' '));

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
function nearlySame(a, b) {
  if (String(a.source_id) !== String(b.source_id)) return false;
  if (Number(a.chunk_index) === Number(b.chunk_index)) return true;
  const aw = new Set(tokens(String(a.content || '').slice(0, 900)));
  const bw = new Set(tokens(String(b.content || '').slice(0, 900)));
  if (Math.min(aw.size, bw.size) < 9) return false;
  const shared = intersectionCount(aw, bw);
  return shared / Math.max(aw.size, bw.size) >= 0.87;
}

/**
 * Re-rank broad semantic candidates using question-specific terms, source diversity
 * and near-duplicate removal. Call only after the DB has enforced chat/global scope.
 */
export function rankKnowledgeCandidates(query, rows, { limit = 12, perSource = 3 } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  if (!input.length) return [];
  const allTerms = tokens(query).slice(0, 32);
  const specificTerms = allTerms.filter(w => !WEAK_DOMAIN.has(w));
  const terms = specificTerms.length >= 2 ? specificTerms : allTerms;
  const bestSimilarity = Math.max(...input.map(similarityOf));
  const ranked = input.map(row => {
    const semantic = similarityOf(row);
    const bodyTerms = new Set(tokens(String(row.content || '').slice(0, 5500)));
    const titleTerms = new Set(tokens(row.title || ''));
    const matched = intersectionCount(terms, bodyTerms);
    const titleMatched = intersectionCount(terms, titleTerms);
    const coverage = terms.length ? matched / terms.length : 0;
    const titleCoverage = terms.length ? titleMatched / terms.length : 0;
    const directness = matched >= 2 ? 0.035 : matched === 0 && terms.length >= 2 ? -0.085 : 0;
    const score = 0.68 * semantic + 0.25 * coverage + 0.07 * titleCoverage + directness;
    return { ...row, similarity: semantic, relevance_score: Number(score.toFixed(4)), _coverage: coverage };
  }).sort((a, b) => b.relevance_score - a.relevance_score || b.similarity - a.similarity);
  const maxScore = ranked[0]?.relevance_score || 0;
  const results = [];
  const counts = new Map();
  for (const row of ranked) {
    if (results.length >= limit) break;
    const source = String(row.source_id || '');
    if (!source || !String(row.content || '').trim()) continue;
    if (row.similarity < Math.max(0.19, bestSimilarity - 0.18) && row._coverage < 0.4) continue;
    if (row.relevance_score < maxScore * 0.69 && row._coverage < 0.55) continue;
    if ((counts.get(source) || 0) >= perSource) continue;
    if (results.some(other => nearlySame(other, row))) continue;
    counts.set(source, (counts.get(source) || 0) + 1);
    const { _coverage, ...publicRow } = row;
    results.push(publicRow);
  }
  return results;
}
