/**
 * Imperative "show me this transcript line" helper for the thread. The walk is driven entirely by line
 * ordinals, never by matching text.
 */

import { COLLAPSIBLE_CARD_TRIGGER_SLOTS } from './collapsibleCardSlots'
import { requestRowPin } from './rowPinRequests'
import { pointSearchArrowAt } from './searchArrow'
import { emphasizeTerm } from './searchEmphasis'

/**
 * Which reveal owns the markers: each call takes a token and checks it before touching the DOM, so an
 * older walk cannot stamp over a newer one.
 */
let revealGeneration = 0

/** Attempts before the reveal gives up and says so. */
const MAX_REVEAL_ATTEMPTS = 12

/**
 * Frames to wait for a just-expanded container to render its children.
 *
 * Kept modest because the walk can open several levels and pays this at
 * each one: a generous budget turned a deep hit into a multi-second
 * reveal, long enough for the flash it eventually set to have expired
 * before the user looked.
 */
const EXPAND_SETTLE_FRAMES = 8

export const SEARCH_HIT_FLASH_MS = 5000

/**
 * One frame — or 50 ms, whichever comes first.
 *
 * The timeout is not belt and braces, it is the whole point: a window
 * that is occluded, minimised, or in a background tab stops delivering
 * animation frames altogether, and the reveal would suspend mid-walk with
 * the jump already consumed — a click that silently does nothing.
 */
export function nextFrame(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 16)
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    requestAnimationFrame(finish)
    setTimeout(finish, 50)
  })
}

/**
 * Releases the viewport's stick-to-bottom pin, which undoes programmatic `scrollTop` writes; a -1 wheel
 * delta counts as a user gesture without moving the viewport.
 */
function releaseStickToBottom(viewport: HTMLElement): void {
  const view = viewport.ownerDocument.defaultView
  if (!view) return
  viewport.dispatchEvent(
    new view.WheelEvent('wheel', {
      deltaY: -1,
      bubbles: true,
      cancelable: true,
    }),
  )
}

/**
 * Every collapsible card trigger the reveal may open: an allow-list, never a `-trigger` suffix match,
 * since `.click()` on an action or overlay trigger (a message's Fork button) would run it.
 */
const CARD_TRIGGER_SLOTS = [
  'collapsible-trigger',
  ...COLLAPSIBLE_CARD_TRIGGER_SLOTS,
] as const

const TRIGGER_SELECTOR = CARD_TRIGGER_SLOTS.map(
  slot => `[data-slot="${slot}"][data-state="closed"]`,
).join(',')

/**
 * Opens one collapsed container. Returns false if there was nothing to
 * open.
 */
export function expandContainer(container: HTMLElement): boolean {
  const trigger = container.matches(TRIGGER_SELECTOR)
    ? container
    : container.querySelector<HTMLElement>(TRIGGER_SELECTOR)
  if (!trigger) return false
  trigger.click()
  return true
}

/** Containers opened in one sweep of a level; small, since each expansion re-renders a subtree. */
const MAX_SWEEP_PER_LEVEL = 4

/**
 * Opens every closed container directly reachable within `scope`.
 *
 * The targeted descent follows containers that DECLARE a range. A card
 * that declares none is a dead end even when the line is inside it, so
 * when the targeted step finds nothing this sweeps the level open and
 * lets the descent resume — bounded, and only once per level.
 */
export function expandAllWithin(scope: HTMLElement): number {
  let opened = 0
  for (const trigger of scope.querySelectorAll<HTMLElement>(TRIGGER_SELECTOR)) {
    if (opened >= MAX_SWEEP_PER_LEVEL) break
    trigger.click()
    opened += 1
  }
  return opened
}

export const MAX_FLASH_VIEWPORT_RATIO = 0.45

/**
 * Height of `el` if it is small enough to flash, else 0.
 *
 * The highlight is a full-bleed band, so stamping it on a long message
 * does not read as "the match is here" — it reads as the page flashing.
 */
function flashableHeight(el: HTMLElement): number {
  const view = el.ownerDocument.defaultView
  const limit = (view?.innerHeight ?? 0) * MAX_FLASH_VIEWPORT_RATIO
  const height = el.getBoundingClientRect().height
  return height > 0 && height <= limit ? height : 0
}

/** The first thing inside `el` small enough to flash — its heading line. */
function firstFlashableWithin(el: HTMLElement): HTMLElement | null {
  for (const child of el.children) {
    if (!(child instanceof HTMLElement)) continue
    if (flashableHeight(child) > 0) return child
    const deeper = firstFlashableWithin(child)
    if (deeper) return deeper
  }
  return null
}

/** The smallest part of `el` that shows `term`, for when `el` itself is too tall to flash. */
function partShowing(el: HTMLElement, term: string): HTMLElement | null {
  const wanted = term.trim().toLowerCase()
  if (wanted.length === 0) return null
  let best: HTMLElement | null = null
  for (const child of el.querySelectorAll<HTMLElement>('*')) {
    if ((child.textContent ?? '').toLowerCase().includes(wanted) === false) continue
    if (flashableHeight(child) <= 0) continue
    if (!best || child.getBoundingClientRect().height < best.getBoundingClientRect().height) {
      best = child
    }
  }
  return best
}

/** What the last reveal managed to do, stamped on the thread root as `data-search-reveal`. */
export type RevealOutcome = 'running' | 'line' | 'quiet' | 'missing'

function markOutcome(root: HTMLElement, outcome: RevealOutcome): void {
  root.setAttribute('data-search-reveal', outcome)
}

/** Flashes the element the reveal settled on. */
function flashElement(el: HTMLElement, term?: string): void {
  el.setAttribute('data-search-hit', 'true')
  // The arrow points at the flashed element and tracks it; the keyword is
  // bolded within it. All clear together. This is the fallback path (a
  // hit whose part carries no line); the precise part path does the same
  // in useRevealSelf.
  const cancelArrow = pointSearchArrowAt(el, SEARCH_HIT_FLASH_MS)
  const cancelEmphasis = emphasizeTerm(el, term, SEARCH_HIT_FLASH_MS)
  setTimeout(() => {
    el.removeAttribute('data-search-hit')
    cancelArrow()
    cancelEmphasis()
  }, SEARCH_HIT_FLASH_MS)
}

/** Marks the row the reveal landed in, so a check can confirm the target. */
function markTargetRow(row: HTMLElement): void {
  row.setAttribute('data-search-target', 'true')
  setTimeout(() => {
    row.removeAttribute('data-search-target')
  }, SEARCH_HIT_FLASH_MS)
}

/**
 * The container within `scope` whose declared range covers `ordinal`: the last one starting at or before
 * it, honouring a declared end so a line between two containers is not attributed to the earlier one.
 */
export function containerClaiming(
  scope: HTMLElement,
  ordinal: number,
): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestFrom = -1
  for (const el of scope.querySelectorAll<HTMLElement>('[data-line-from]')) {
    const from = Number(el.dataset.lineFrom)
    if (!Number.isFinite(from) || from > ordinal) continue
    const rawTo = el.dataset.lineTo
    if (rawTo !== undefined && rawTo !== '') {
      const to = Number(rawTo)
      if (Number.isFinite(to) && to < ordinal) continue
    }
    if (from > bestFrom) {
      best = el
      bestFrom = from
    }
  }
  return best
}

/**
 * The element rendering transcript line `ordinal` inside `row`, opening containers on the way down:
 * leaves carry `data-line-ordinal`, containers declare `data-line-from` / `data-line-to` even when collapsed.
 */
/** Levels the descent will open; each costs a settle wait. */
const MAX_DESCEND_DEPTH = 6

/**
 * Wall-clock budget for one reveal, a ceiling rather than a cost. Past it the walk settles on the best
 * place reached, always at least the right row.
 */
const REVEAL_BUDGET_MS = 6000

export async function descendToOrdinal(
  row: HTMLElement,
  ordinal: number,
  deadline = Number.POSITIVE_INFINITY,
): Promise<HTMLElement | null> {
  let scope: HTMLElement = row
  let deepest: HTMLElement | null = null
  // Levels already swept open, so a level is never swept twice.
  const sweptHere = new Set<HTMLElement>()
  // The budget bounds opening and waiting, never the synchronous lookups: past the deadline the walk still
  // looks, and merely stops opening things.
  const outOfTime = () => Date.now() > deadline
  for (let depth = 0; depth < MAX_DESCEND_DEPTH; depth++) {
    // A row that was re-rendered out from under us cannot be walked any
    // further; whatever we reached before that is the answer.
    if (!scope.isConnected) return deepest
    // A leaf carrying the exact line ends the walk. Prefer the DEEPEST
    // one: a card and the block inside it can both carry the line, and
    // the block is what the user asked to see.
    const exact = [
      ...scope.querySelectorAll<HTMLElement>(`[data-line-ordinal="${ordinal}"]`),
    ]
    const leaf = exact.at(-1)
    if (leaf && leaf !== scope) {
      deepest = leaf
      // Children that carry the line mean this is not the innermost
      // thing yet. A COLLAPSED card has none visible — so try opening it
      // before concluding it is a leaf, or the walk stops on the wrapper
      // and the user sees the card flash instead of their line. Out of
      // time, the card itself is the answer — it is the right place.
      const opened =
        leaf.querySelector('[data-line-ordinal]') || outOfTime()
          ? false
          : expandContainer(leaf)
      if (opened) {
        for (let wait = 0; wait < EXPAND_SETTLE_FRAMES; wait++) {
          await nextFrame()
          if (outOfTime()) break
          if (leaf.querySelector(`[data-line-ordinal="${ordinal}"]`)) break
        }
      }
      if (!leaf.querySelector('[data-line-ordinal]')) return leaf
      scope = leaf
      continue
    }

    let claimant = containerClaiming(scope, ordinal)
    if (!claimant || claimant === scope) {
      // Nothing here declares the line — but a container that declares
      // NOTHING can still be hiding it. Not every card carries a range
      // (only those built from a tool-call part do), so its labelled
      // grandchildren are invisible until it is opened. Open what is
      // closed at this level and look again; this is the difference
      // between reaching the leaf and stopping on its grandparent.
      if (scope === row && !sweptHere.has(scope) && !outOfTime()) {
        sweptHere.add(scope)
        const opened = expandAllWithin(scope)
        if (opened > 0) {
          for (let wait = 0; wait < EXPAND_SETTLE_FRAMES; wait++) {
            await nextFrame()
            if (outOfTime()) break
            if (scope.querySelector(`[data-line-ordinal="${ordinal}"]`)) break
          }
          claimant = containerClaiming(scope, ordinal)
          if (
            scope.querySelector(`[data-line-ordinal="${ordinal}"]`) ||
            (claimant && claimant !== scope)
          ) {
            continue
          }
        }
      }
    }
    if (!claimant || claimant === scope) {
      // Nothing declares the line from here. Opening everything re-renders too much of the thread for reveals
      // to meet their budget; the bounded level sweep above is the compromise.
      return deepest ?? (scope === row ? null : scope)
    }
    deepest = claimant
    // Out of time: settle on the claimant — the right place, unopened —
    // rather than start an expansion whose render we will not wait for.
    if (outOfTime()) return deepest
    if (expandContainer(claimant)) {
      for (let wait = 0; wait < EXPAND_SETTLE_FRAMES; wait++) {
        await nextFrame()
        if (outOfTime()) break
        if (claimant.querySelector(`[data-line-ordinal="${ordinal}"]`)) break
      }
    }
    scope = claimant
  }
  return deepest
}

/**
 * Reveals transcript line `ordinal` inside `root`; resolves true when the row was shown. `index` is the
 * owning row's thread index, needed to mount a culled row.
 */
/**
 * Mounts row `index` and marks it when the part reveals itself; no DOM walk then, which would race the
 * re-render of the container just opened.
 */
export async function revealRowForPart(
  root: HTMLElement,
  index: number,
): Promise<boolean> {
  // Same supersession guard as revealThreadMessage: two rapid jumps race
  // on the row loop, and without this an older one could mark its row
  // over the newer one's after the newer had already landed.
  const generation = ++revealGeneration
  const superseded = () => generation !== revealGeneration
  markOutcome(root, 'running')
  requestRowPin(index)
  const viewport =
    root.querySelector<HTMLElement>('.aui-thread-viewport') ??
    root.querySelector<HTMLElement>('[data-slot="thread-viewport"]')
  if (viewport) releaseStickToBottom(viewport)
  for (let attempt = 0; attempt < MAX_REVEAL_ATTEMPTS; attempt++) {
    if (superseded()) return false
    const row = root.querySelector<HTMLElement>(
      `[data-message-index="${index}"]`,
    )
    if (row) {
      // Bring the row on screen as a baseline. The part scrolls itself
      // once it renders — but it may need a beat to open, and landing the
      // user on the right message meanwhile is better than leaving them
      // where they were.
      row.scrollIntoView({ block: 'center' })
      await nextFrame()
      if (superseded()) return false
      markTargetRow(row)
      markOutcome(root, 'line')
      return true
    }
    await nextFrame()
  }
  if (!superseded()) markOutcome(root, 'missing')
  return false
}

export async function revealThreadMessage(
  root: HTMLElement,
  index: number,
  ordinal?: number,
  /**
   * The matched text, used ONLY to choose what to highlight inside an
   * element the line already selected. It never decides WHERE to go —
   * that is the line's job, and letting text decide the destination is
   * the bug this design replaced.
   */
  term?: string,
): Promise<boolean> {
  const generation = ++revealGeneration
  const superseded = () => generation !== revealGeneration
  const deadline = Date.now() + REVEAL_BUDGET_MS
  const viewport =
    root.querySelector<HTMLElement>('.aui-thread-viewport') ??
    root.querySelector<HTMLElement>('[data-slot="thread-viewport"]')
  markOutcome(root, 'running')
  // Mount the target row before anything else. Virtualization culls
  // distant rows to spacers, so the row a hit lives in usually has no DOM
  // node when this starts — and then there is nothing to walk into,
  // nothing to expand, and nothing to flash. Scrolling toward it is not a
  // reliable way to mount it (the viewport fights back, re-segmentation
  // is async); pinning is the mechanism the virtualizer already uses to
  // keep interacted-with rows alive.
  requestRowPin(index)
  if (viewport) releaseStickToBottom(viewport)

  for (let attempt = 0; attempt < MAX_REVEAL_ATTEMPTS; attempt++) {
    if (superseded()) return false
    const row = root.querySelector<HTMLElement>(
      `[data-message-index="${index}"]`,
    )
    if (!row) {
      await nextFrame()
      continue
    }
    // Bring the row on screen before walking into it: a distant row
    // carries `content-visibility: auto`, so its contents are not laid
    // out and every rect inside it is stale.
    row.scrollIntoView({ block: 'center' })
    await nextFrame()
    await nextFrame()

    const found =
      ordinal === undefined
        ? null
        : await descendToOrdinal(row, ordinal, deadline)
    const flashable = found
      ? flashableHeight(found) > 0
        ? found
        : ((term ? partShowing(found, term) : null) ??
          firstFlashableWithin(found) ??
          // Nothing smaller inside can be justified — but when the walk
          // ended ON the line itself (the element carries the ordinal, it
          // is not a container standing for a range), the leaf IS the hit
          // and marking it is never wrong, only bigger than the cap. That
          // is a plain-text element with no children to pick from — a
          // long user message in a short window. Going quiet here left
          // the user with a click that did nothing visible.
          (found.dataset.lineOrdinal === String(ordinal) ? found : null))
      : null
    // Marked AFTER the walk, not before: expanding several levels takes
    // time, and a marker set up front can expire while the walk is still
    // going — leaving a finished reveal that looks like it never ran.
    if (superseded()) return false
    // Re-resolve the row: expanding a card re-renders the subtree, and
    // the element captured before the walk can be detached by now.
    // Marking a detached node marks nothing at all — the reveal reports
    // success while the user sees no landing.
    const settledRow =
      root.querySelector<HTMLElement>(`[data-message-index="${index}"]`) ?? row
    markTargetRow(settledRow)
    const settle =
      flashable && flashable.isConnected
        ? flashable
        : found && found.isConnected
          ? found
          : settledRow
    settle.scrollIntoView({ block: 'center' })
    await nextFrame()
    if (flashable && flashable.isConnected) {
      flashElement(flashable, term)
      markOutcome(root, 'line')
    } else {
      // Landed in the right row but could not justify a line. Say so
      // rather than flashing something arbitrary: pointing at the wrong
      // line is worse than pointing at nothing, and it is what made every
      // hit in a row look identical.
      markOutcome(root, 'quiet')
    }
    return true
  }
  if (!superseded()) markOutcome(root, 'missing')
  return false
}
