/**
 * Marks a model request the host refused for want of a usable stored secret
 * (`SECRET_UNAVAILABLE`), so the classifier and the API-error card agree on
 * the cause. `unreadable`: stored sealed, but this keystore will not open it
 * (another OS user, profile or machine). `unavailable`: nothing usable stored,
 * or a host too old to say why. Dependency-free: worker and webview. (P-4)
 */
export type StoredKeyProblem = 'unreadable' | 'unavailable'

const MARKERS: Record<StoredKeyProblem, string> = {
  unreadable: 'stored_secret_unreadable',
  unavailable: 'stored_secret_unusable',
}

/** `error.data.reason` of a SECRET_UNAVAILABLE refusal → the problem, if it is one. */
export function storedKeyProblemFromReason(reason: unknown): StoredKeyProblem | undefined {
  if (reason === 'unreadable') return 'unreadable'
  // `keystore_not_ready` is transient: a later request can succeed.
  if (reason === 'keystore_not_ready') return undefined
  return 'unavailable'
}

export function withStoredKeyMarker(problem: StoredKeyProblem, hostMessage: string): string {
  return `${MARKERS[problem]}: ${hostMessage}`
}

export function storedKeyProblemOf(text: string): StoredKeyProblem | undefined {
  const lower = text.toLowerCase()
  if (lower.includes(`${MARKERS.unreadable}:`)) return 'unreadable'
  if (lower.includes(`${MARKERS.unavailable}:`)) return 'unavailable'
  return undefined
}
