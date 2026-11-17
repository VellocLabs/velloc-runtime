/**
 * Who wrote a chain's answer, read off its dispatch trace (F-25): the
 * plugins whose hook answered something other than what it heard from
 * beneath, outermost first.
 */

import type { TraceEntry } from './modTypes'

/**
 * Walking up from core, a hook that returned an answer of its own (`returned`
 * or `caught`) is an author when nothing ran beneath it or `same` says its
 * answer differs from the one beneath; a hook that passed its `next` on, or
 * failed and was kept over, wrote nothing.
 */
export function answerAuthorsOf(
  entries: readonly TraceEntry[],
  same: (answer: unknown, heard: unknown) => boolean,
): string[] {
  const authors: string[] = []
  let heard: { value: unknown } | undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.outcome === 'passed' && heard !== undefined) continue
    if (entry.outcome !== 'returned' && entry.outcome !== 'caught' && entry.outcome !== 'passed') continue
    if (entry.plugin !== 'engine' && (heard === undefined || !same(entry.returned, heard.value))) {
      if (!authors.includes(entry.plugin)) authors.unshift(entry.plugin)
    }
    heard = { value: entry.returned }
  }
  return authors
}
