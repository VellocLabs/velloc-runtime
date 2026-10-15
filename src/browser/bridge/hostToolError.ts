/**
 * A host tool call the host rejected. The message is `code: text` — the
 * text the runtime rendered for the model (toolkit/builtin/host/resultText)
 * — and the host's `params` ride along for callers that branch on data
 * rather than prose: the hook runner's pwsh → powershell fallback reads
 * `service_code` (the shell service's BINARY_NOT_FOUND) from here.
 */
export class HostToolError extends Error {
  override readonly name = 'HostToolError'
  constructor(
    readonly code: string,
    text: string,
    readonly params: Record<string, unknown> | undefined,
  ) {
    super(`${code}: ${text}`)
  }
}

/** A string param of a host tool error, or undefined for any other error. */
export function hostToolErrorParam(error: unknown, key: string): string | undefined {
  if (!(error instanceof HostToolError)) return undefined
  const value = error.params?.[key]
  return typeof value === 'string' ? value : undefined
}
