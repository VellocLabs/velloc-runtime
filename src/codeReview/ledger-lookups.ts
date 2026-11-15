/** True for a candidate merged into another as its duplicate. */
export const isMergedDuplicate = (ledger: { duplicateIds?: Record<string, string> }, id: string): boolean => Object.hasOwn(ledger.duplicateIds ?? {}, id)
/** Every candidate recorded, and how many are left once merged duplicates are set aside. */
export function candidateCounts(ledger: { diagnostics: readonly { id: string }[]; duplicateIds?: Record<string, string> }): { recorded: number; merged: number } {
  return { recorded: ledger.diagnostics.length, merged: ledger.diagnostics.filter(item => !isMergedDuplicate(ledger, item.id)).length }
}
/** A candidate's latest assessment, if it has one. */
export function latestAssessment<T extends { diagnosticId: string }>(ledger: { assessments: readonly T[] }, id: string): T | undefined {
  return ledger.assessments.filter(item => item.diagnosticId === id).at(-1)
}
