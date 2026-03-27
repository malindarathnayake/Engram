/**
 * Trigram Jaccard similarity scoring.
 *
 * Used to detect near-duplicate entity type names and extraction hints
 * before allowing schema additions.
 */

/**
 * Generate character trigrams from a string.
 * Pads with spaces for boundary trigrams.
 */
export function trigrams(str: string): Set<string> {
  const normalized = ` ${str.toLowerCase().trim()} `;
  const result = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    result.add(normalized.slice(i, i + 3));
  }
  return result;
}

/**
 * Compute Jaccard similarity between two strings using character trigrams.
 *
 * Returns a value between 0.0 (no overlap) and 1.0 (identical).
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  const trigramsA = trigrams(a);
  const trigramsB = trigrams(b);

  if (trigramsA.size === 0 && trigramsB.size === 0) return 1.0;
  if (trigramsA.size === 0 || trigramsB.size === 0) return 0.0;

  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }

  const union = trigramsA.size + trigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Find the most similar string in a list.
 * Returns the best match and its similarity score.
 */
export function findMostSimilar(
  query: string,
  candidates: string[],
): { match: string; score: number } | null {
  if (candidates.length === 0) return null;

  let bestMatch = candidates[0];
  let bestScore = trigramSimilarity(query, candidates[0]);

  for (let i = 1; i < candidates.length; i++) {
    const score = trigramSimilarity(query, candidates[i]);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidates[i];
    }
  }

  return { match: bestMatch, score: bestScore };
}
