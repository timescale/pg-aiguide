/** Default RRF smoothing constant (standard in hybrid search guides). */
export const DEFAULT_RRF_K = 60;
export const DEFAULT_SEMANTIC_WEIGHT = 1;
export const DEFAULT_KEYWORD_WEIGHT = 1;

export type RrfInput = {
  semanticIds: number[];
  keywordIds: number[];
  limit: number;
  /** RRF smoothing k; defaults to {@link DEFAULT_RRF_K}. */
  k?: number;
  /** Defaults to 1. */
  semanticWeight?: number;
  /** Defaults to 1. */
  keywordWeight?: number;
};

/**
 * RRF (reciprocal rank fusion): merge two ordered id lists (rank 1 = first element)
 * with weight/(k+rank), then return the top `limit` ids by fused score (descending).
 */
export function rrf(input: RrfInput): { id: number; rrf_score: number }[] {
  const {
    semanticIds,
    keywordIds,
    limit,
    k = DEFAULT_RRF_K,
    semanticWeight = DEFAULT_SEMANTIC_WEIGHT,
    keywordWeight = DEFAULT_KEYWORD_WEIGHT,
  } = input;
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
