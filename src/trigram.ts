// pg_trgm word_similarity, ported from contrib/pg_trgm/trgm_op.c (calc_word_similarity and
// iterate_word_similarity, non-strict), so the search mock matches names the way murmur8's
// SearchRepository SQL does (`@search_text <% name`).
//
// Production threshold: the murmur8 database sets pg_trgm.word_similarity_threshold = 0.3
// (pg_db_role_setting on serve, read 2026-10-01). The SearchRepository doc comment says 0.38; that
// comment is stale, the database setting is what the operator uses.

export const WORD_SIMILARITY_THRESHOLD = 0.3;

/**
 * generate_trgm_only: lowercase, split into words of letters and digits, pad each word as
 * "  word " and take every three-character window, in order, duplicates kept.
 */
function trigramsOf(text: string): string[] {
  const trigrams: string[] = [];
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    const padded = Array.from(`  ${word} `);
    for (let index = 0; index + 3 <= padded.length; index += 1) {
      trigrams.push(padded.slice(index, index + 3).join(''));
    }
  }
  return trigrams;
}

/** CALCSML in float4: count / (len1 + len2 - count). */
function similarityOf(count: number, firstLength: number, secondLength: number): number {
  return Math.fround(count / (firstLength + secondLength - count));
}

/** The float4 value as the shortest decimal that reads back to it (how psql and .NET write a real). */
function shortestFloat4(value: number): number {
  const single = Math.fround(value);
  for (let precision = 1; precision <= 9; precision += 1) {
    const candidate = Number(single.toPrecision(precision));
    if (Math.fround(candidate) === single) return candidate;
  }
  return single;
}

/**
 * word_similarity(query, text): the greatest similarity between the query's trigram set and any
 * continuous extent of the text's ordered trigrams. Returned as the float4 production computes.
 */
export function wordSimilarity(query: string, text: string): number {
  const queryTrigrams = new Set(trigramsOf(query));
  const textTrigrams = trigramsOf(text);
  const queryLength = queryTrigrams.size;
  if (queryLength === 0 || textTrigrams.length === 0) return 0;

  // lastPosition holds, for each trigram inside the current extent, its last index (absent is -1).
  const lastPosition = new Map<string, number>();
  let extentLength = 0;
  let count = 0;
  let lower = -1;
  let maximum = 0;

  for (let index = 0; index < textTrigrams.length; index += 1) {
    const trigram = textTrigrams[index];
    const found = queryTrigrams.has(trigram);
    if (lower >= 0 || found) {
      if (!lastPosition.has(trigram)) {
        extentLength += 1;
        if (found) count += 1;
      }
      lastPosition.set(trigram, index);
    }
    if (!found) continue;

    const upper = index;
    if (lower === -1) {
      lower = index;
      extentLength = 1;
    }
    let current = similarityOf(count, queryLength, extentLength);

    // Try every later lower bound for a greater similarity.
    let candidateCount = count;
    let candidateLength = extentLength;
    const previousLower = lower;
    for (let candidateLower = lower; candidateLower <= upper; candidateLower += 1) {
      const candidate = similarityOf(candidateCount, queryLength, candidateLength);
      if (candidate > current) {
        current = candidate;
        extentLength = candidateLength;
        lower = candidateLower;
        count = candidateCount;
      }
      const lowerTrigram = textTrigrams[candidateLower];
      if (lastPosition.get(lowerTrigram) === candidateLower) {
        candidateLength -= 1;
        if (queryTrigrams.has(lowerTrigram)) candidateCount -= 1;
      }
    }
    maximum = Math.max(maximum, current);

    for (let droppedLower = previousLower; droppedLower < lower; droppedLower += 1) {
      const droppedTrigram = textTrigrams[droppedLower];
      if (lastPosition.get(droppedTrigram) === droppedLower) lastPosition.delete(droppedTrigram);
    }
  }
  return shortestFloat4(maximum);
}

/** The `<%` operator: word_similarity at or above the production threshold. */
export function matchesWordSimilarity(query: string, text: string): boolean {
  return wordSimilarity(query, text) >= WORD_SIMILARITY_THRESHOLD;
}
