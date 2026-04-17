/** Default RRF smoothing constant (standard in hybrid search guides). */
export const DEFAULT_RRF_K = 60;

/**
 * RRF (reciprocal rank fusion): merge two ordered id lists (rank 1 = first element)
 * with weight/(k+rank), then return the top `limit` ids by fused score (descending).
 */
export function rrfRankedTop(
  semanticIds: number[],
  keywordIds: number[],
  k: number,
  semanticWeight: number,
  keywordWeight: number,
  limit: number,
): { id: number; rrf_score: number }[] {
  const scores = new Map<number, number>();
  for (let i = 0; i < semanticIds.length; i++) {
    const id = semanticIds[i]!;
    const r = i + 1;
    scores.set(id, (scores.get(id) ?? 0) + semanticWeight / (k + r));
  }
  for (let i = 0; i < keywordIds.length; i++) {
    const id = keywordIds[i]!;
    const r = i + 1;
    scores.set(id, (scores.get(id) ?? 0) + keywordWeight / (k + r));
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, rrf_score]) => ({ id, rrf_score }));
}
