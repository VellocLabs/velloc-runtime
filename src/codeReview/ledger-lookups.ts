/** True for a candidate merged into another as its duplicate. */
export const isMergedDuplicate = (ledger: { duplicateIds?: Record<string, string> }, id: string): boolean => Object.hasOwn(ledger.duplicateIds ?? {}, id)
/** A candidate's latest assessment, if it has one. */
export function latestAssessment<T extends { diagnosticId: string }>(ledger: { assessments: readonly T[] }, id: string): T | undefined {
  return ledger.assessments.filter(item => item.diagnosticId === id).at(-1)
}
