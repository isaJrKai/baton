// Token estimate. Per spec TABLE 1 row 7: chars / 4, rounded up.
// Known underestimate for code-heavy content with BPE tokenizers (10-30%).
// Documented in the packet footer when emitted.

export const BUDGET_DEFAULT = 6000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
