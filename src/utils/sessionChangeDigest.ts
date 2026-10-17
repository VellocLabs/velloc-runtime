/**
 * Contract: a session's change figures (F-9), what the Outputs and Changes
 * cards show, and their digest kept in the session's metadata so an opened
 * session draws its cards without reading snapshots or tool-call sidecars.
 * A stored digest stands in for the computed history only while it names this
 * session and its fingerprint equals the loaded transcript's. Only a history
 * computed between turns, with every snapshot turn finalized, is stored; any
 * other computation leaves no digest that claims its transcript.
 */
import { SESSION_TOTAL_TURN_INDEX, type TurnDiffMeta } from './turnDiffs'

/** What the Outputs and Changes cards read from a session's change history. */
export type SessionChangeFigures = {
  plusLines: number
  minusLines: number
  /** Files the session created, newest first, each once. */
  createdFiles: string[]
}

/**
 * Lines are the sum of every turn (the whole-session row, turn 0, is an
 * aggregate and is skipped), matching the composer's session diff chip.
 * Created files are ordered by the latest turn that created them, the last
 * written first within a turn. When the history has turn 0 (the net result)
 * only the files it still lists as created are kept.
 */
export function sessionChangeFigures(history: readonly TurnDiffMeta[] | null | undefined): SessionChangeFigures {
  const figures: SessionChangeFigures = { plusLines: 0, minusLines: 0, createdFiles: [] }
  if (!history) return figures
  const total = history.find(turn => turn.turnIndex === SESSION_TOTAL_TURN_INDEX)
  const turns = history.filter(turn => turn.turnIndex !== SESSION_TOTAL_TURN_INDEX)
  for (const turn of turns) {
    figures.plusLines += turn.stats.plusLines
    figures.minusLines += turn.stats.minusLines
  }
  const newestFirst: string[] = []
  const seen = new Set<string>()
  for (const turn of [...turns].sort((a, b) => b.turnIndex - a.turnIndex)) {
    for (const file of [...turn.files].reverse()) {
      if (!file.fileWasCreated || seen.has(file.filePath)) continue
      seen.add(file.filePath)
      newestFirst.push(file.filePath)
    }
  }
  if (!total) {
    figures.createdFiles = newestFirst
    return figures
  }
  const net = new Set(total.files.filter(file => file.fileWasCreated).map(file => file.filePath))
  figures.createdFiles = newestFirst.filter(path => net.has(path))
  for (const path of net) {
    if (!seen.has(path)) figures.createdFiles.push(path)
  }
  return figures
}

/** Whether the figures would draw any card. */
export function hasSessionChanges(figures: SessionChangeFigures): boolean {
  return figures.plusLines > 0 || figures.minusLines > 0 || figures.createdFiles.length > 0
}

/** The `BrowserSessionMetadata` key the digest is kept under. */
export const SESSION_CHANGES_METADATA_KEY = 'sessionChanges'

/** Above this many created files no digest is kept: the metadata row is read
 *  for every session in the list, so it stays small. */
export const SESSION_CHANGES_MAX_CREATED_FILES = 500

export type SessionChangeDigest = {
  sessionId: string
  /** `transcriptFingerprint` of the transcript the figures were computed from. */
  fingerprint: string
  figures: SessionChangeFigures
}

/** Identifies a transcript's content: its row count and last row id. A new
 *  row, a rewind, a compaction or a fork each change it. */
export function transcriptFingerprint(rows: readonly unknown[]): string {
  const last = rows[rows.length - 1] as { uuid?: unknown } | undefined
  const uuid = typeof last?.uuid === 'string' ? last.uuid : ''
  return `${rows.length}:${uuid}`
}

/** The digest to store for a settled history, or null when none should be
 *  (nothing to show, or too many created files). */
export function buildSessionChangeDigest(
  sessionId: string,
  fingerprint: string,
  figures: SessionChangeFigures,
): SessionChangeDigest | null {
  if (!hasSessionChanges(figures)) return null
  if (figures.createdFiles.length > SESSION_CHANGES_MAX_CREATED_FILES) return null
  return { sessionId, fingerprint, figures }
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/**
 * Security: the digest comes from storage, so anything may be there. The
 * figures it carries, when it is well formed and describes `sessionId` at
 * `fingerprint`; otherwise null.
 */
export function readSessionChangeDigest(
  raw: unknown,
  sessionId: string,
  fingerprint: string,
): SessionChangeFigures | null {
  if (typeof raw !== 'object' || raw === null) return null
  const digest = raw as Record<string, unknown>
  if (digest.sessionId !== sessionId || digest.fingerprint !== fingerprint) return null
  const figures = digest.figures as Record<string, unknown> | null | undefined
  if (typeof figures !== 'object' || figures === null) return null
  const { plusLines, minusLines, createdFiles } = figures
  if (!isCount(plusLines) || !isCount(minusLines) || !Array.isArray(createdFiles)) return null
  if (createdFiles.length > SESSION_CHANGES_MAX_CREATED_FILES) return null
  if (!createdFiles.every(path => typeof path === 'string' && path.length > 0)) return null
  return { plusLines, minusLines, createdFiles: [...createdFiles] }
}

/** The fingerprint a stored digest claims, or null when it has none. */
export function storedDigestFingerprint(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const fingerprint = (raw as Record<string, unknown>).fingerprint
  return typeof fingerprint === 'string' ? fingerprint : null
}

export function sameSessionChangeDigest(raw: unknown, digest: SessionChangeDigest): boolean {
  const figures = readSessionChangeDigest(raw, digest.sessionId, digest.fingerprint)
  return (
    figures !== null &&
    figures.plusLines === digest.figures.plusLines &&
    figures.minusLines === digest.figures.minusLines &&
    figures.createdFiles.length === digest.figures.createdFiles.length &&
    figures.createdFiles.every((path, index) => path === digest.figures.createdFiles[index])
  )
}
