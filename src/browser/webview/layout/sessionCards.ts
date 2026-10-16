/**
 * The session card stack's model (F-9): which information cards exist, the
 * person's order and Show choices for them, and the figures each card reads
 * from the session's change history. Pure; the stack component and the
 * layout blob share it.
 */
import { SESSION_TOTAL_TURN_INDEX, type TurnDiffMeta } from '@/utils/turnDiffs'

/** The information cards, in their default order. Mod panes are not here:
 *  they always follow these cards and are neither hidden nor reordered. */
export const SESSION_CARD_IDS = ['outputs', 'changes', 'connectors', 'tasks'] as const
export type SessionCardId = (typeof SESSION_CARD_IDS)[number]

/** The person's choices: `order` names every card once; `hidden` the ones
 *  unticked in the Show menu. */
export type SessionCardPrefs = {
  order: SessionCardId[]
  hidden: SessionCardId[]
  /** The topbar toggle: whether the stack docks at the transcript's corner. */
  shown: boolean
}

export function isSessionCardId(value: unknown): value is SessionCardId {
  return typeof value === 'string' && (SESSION_CARD_IDS as readonly string[]).includes(value)
}

export function defaultSessionCardPrefs(): SessionCardPrefs {
  return { order: [...SESSION_CARD_IDS], hidden: [], shown: true }
}

/**
 * Security: the prefs come from client storage, so anything may be there.
 * Unknown ids and repeats are dropped; a card the stored order does not name
 * (one added after it was written) joins at its default position.
 */
export function sanitizeSessionCardPrefs(raw: unknown): SessionCardPrefs {
  if (typeof raw !== 'object' || raw === null) return defaultSessionCardPrefs()
  const obj = raw as Record<string, unknown>
  const order: SessionCardId[] = []
  if (Array.isArray(obj.order)) {
    for (const id of obj.order) {
      if (isSessionCardId(id) && !order.includes(id)) order.push(id)
    }
  }
  SESSION_CARD_IDS.forEach((id, defaultIndex) => {
    if (order.includes(id)) return
    order.splice(Math.min(defaultIndex, order.length), 0, id)
  })
  const hidden: SessionCardId[] = []
  if (Array.isArray(obj.hidden)) {
    for (const id of obj.hidden) {
      if (isSessionCardId(id) && !hidden.includes(id)) hidden.push(id)
    }
  }
  return { order, hidden, shown: obj.shown !== false }
}

export function setSessionCardHidden(
  prefs: SessionCardPrefs,
  id: SessionCardId,
  hidden: boolean,
): SessionCardPrefs {
  const isHidden = prefs.hidden.includes(id)
  if (isHidden === hidden) return prefs
  return {
    ...prefs,
    hidden: hidden ? [...prefs.hidden, id] : prefs.hidden.filter(each => each !== id),
  }
}

/**
 * Move the card at `from` to `to` among `shown` (the cards drawn now, in
 * order). Cards not drawn keep their slots in `order`, so a card that is
 * empty today comes back where the person last left it.
 */
export function moveShownSessionCard(
  prefs: SessionCardPrefs,
  shown: readonly SessionCardId[],
  from: number,
  to: number,
): SessionCardPrefs {
  if (from === to || from < 0 || to < 0 || from >= shown.length || to >= shown.length) return prefs
  const moved = [...shown]
  const [card] = moved.splice(from, 1)
  moved.splice(to, 0, card)
  const shownSet = new Set(shown)
  let next = 0
  const order = prefs.order.map(id => (shownSet.has(id) ? moved[next++] : id))
  return { ...prefs, order }
}

/** What the Outputs and Changes cards read from a session's change history. */
export type SessionChangeFigures = {
  plusLines: number
  minusLines: number
  /** Files the session created, oldest first, each once. */
  createdFiles: string[]
}

/**
 * Lines are the sum of every turn (the whole-session row, turn 0, is an
 * aggregate and is skipped), matching the composer's session diff chip.
 * Created files come from turn 0 when the history has one (the net result),
 * else from every turn.
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
  const seen = new Set<string>()
  const ordered = [...turns].sort((a, b) => a.turnIndex - b.turnIndex)
  for (const turn of total ? [total] : ordered) {
    for (const file of turn.files) {
      if (!file.fileWasCreated || seen.has(file.filePath)) continue
      seen.add(file.filePath)
      figures.createdFiles.push(file.filePath)
    }
  }
  return figures
}

/** The prefs with the stack toggle set; the same object when unchanged. */
export function setSessionCardsShown(prefs: SessionCardPrefs, shown: boolean): SessionCardPrefs {
  return prefs.shown === shown ? prefs : { ...prefs, shown }
}
