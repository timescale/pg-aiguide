export const DEFAULT_RRF_K = 60;
export const DEFAULT_RRF_SEMANTIC_WEIGHT = 0.5;

export type RrfInput = {
  semanticIds: number[];
  keywordIds: number[];
  limit: number;
  /** RRF smoothing k; defaults to {@link DEFAULT_RRF_K}. */
  k?: number;
  /**
   * Fraction of each reciprocal-rank term applied to the semantic list; the keyword list
   * uses `1 - semanticWeight`. Omit for {@link DEFAULT_RRF_SEMANTIC_WEIGHT} (equal mix).
   */
  semanticWeight?: number;
};

/**
 * RRF (reciprocal rank fusion): merge two ordered id lists (rank 1 = first element)
 * with `semanticWeight/(k+rank)` for semantic ranks and `(1-semanticWeight)/(k+rank)` for
 * keyword ranks, then return the top `limit` ids by fused score (descending).
 */
export function rrf(input: RrfInput): { id: number; rrf_score: number }[] {
  const {
    semanticIds,
    keywordIds,
    limit,
    k = DEFAULT_RRF_K,
    semanticWeight = DEFAULT_RRF_SEMANTIC_WEIGHT,
  } = input;
  const keywordWeight = 1 - semanticWeight;
  const scores = new Map<number, number>();

  semanticIds.forEach((id, i) => {
    const r = i + 1;
    scores.set(id, (scores.get(id) ?? 0) + semanticWeight / (k + r));
  });

  keywordIds.forEach((id, i) => {
    const r = i + 1;
    scores.set(id, (scores.get(id) ?? 0) + keywordWeight / (k + r));
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, rrf_score]) => ({ id, rrf_score }));
}
