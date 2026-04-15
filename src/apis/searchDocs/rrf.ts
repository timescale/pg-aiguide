import type { BaseResult, HybridResult } from './schemas.js';

/** Rank constant for reciprocal rank fusion (common default). */
const RRF_K = 60;

export function mergeRrf(
  semantic: BaseResult[],
  keyword: BaseResult[],
  resultLimit: number,
): HybridResult[] {
  const byId = new Map<
    number,
    { content: string; metadata: string; rrf: number }
  >();

  const addRanked = (rows: BaseResult[]) => {
    rows.forEach((row, i) => {
      const contrib = 1 / (RRF_K + (i + 1));
      const prev = byId.get(row.id);
      if (prev) {
        prev.rrf += contrib;
      } else {
        byId.set(row.id, {
          content: row.content,
          metadata: row.metadata,
          rrf: contrib,
        });
      }
    });
  };

  addRanked(semantic);
  addRanked(keyword);

  return Array.from(byId.entries())
    .map(([id, v]) => ({
      id,
      content: v.content,
      metadata: v.metadata,
      rrf_score: v.rrf,
    }))
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, resultLimit);
}
