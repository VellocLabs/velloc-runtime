// Heuristic detection of a provider "prompt too long" / context-window rejection
// (no structured error code on the wire). Kept specific so an unrelated error
// never masquerades as one.
export function isPromptTooLongError(error: unknown): boolean {
  const text = (
    error instanceof Error ? error.message : String(error ?? '')
  ).toLowerCase()
  if (!text) return false
  return (
    text.includes('prompt is too long')
    || text.includes('context_length_exceeded')
    || text.includes('maximum context length')
    || text.includes('context length exceeded')
    || text.includes('exceeds the maximum number of tokens')
    || text.includes('input is too long')
  )
}
