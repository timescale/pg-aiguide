/** Default RRF smoothing constant (standard in hybrid search guides). */
export const DEFAULT_RRF_K = 60;

export type RrfWeights = { keywordWeight: number; semanticWeight: number };

/**
 * Reciprocal rank fusion: merges two ordered id rankings using weight/(k+rank).
 * Rank 1 = first element in each list.
 */
export class RrfFusion {
  constructor(
    private readonly k: number,
    private readonly weights: RrfWeights,
  ) {}

  fuse(semanticIds: number[], keywordIds: number[]): Map<number, number> {
    const scores = new Map<number, number>();
    const add = (ids: number[], weight: number) => {
      ids.forEach((id, i) => {
        const r = i + 1;
        scores.set(id, (scores.get(id) ?? 0) + weight / (this.k + r));
      });
    };
    add(semanticIds, this.weights.semanticWeight);
    add(keywordIds, this.weights.keywordWeight);
    return scores;
  }

  /** Fuse then return the top `limit` ids by fused score (descending). */
  rankedTop(
    semanticIds: number[],
    keywordIds: number[],
    limit: number,
  ): { id: number; rrf_score: number }[] {
    return RrfFusion.topIds(this.fuse(semanticIds, keywordIds), limit);
  }

  static topIds(
    scores: Map<number, number>,
    limit: number,
  ): { id: number; rrf_score: number }[] {
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, rrf_score]) => ({ id, rrf_score }));
  }
}
