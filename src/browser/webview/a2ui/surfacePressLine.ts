/**
 * The line a surface's presses wait in (F-40): one press is delivered at a
 * time, in the order the presses were made. A press made while an earlier
 * one is still being answered waits its turn instead of being lost.
 *
 * Contract: `deliver` returns a promise when the press must be answered
 * before the next one goes, and nothing when the next may go at once. A
 * delivery that throws or rejects does not stop the line. `clear` discards
 * the presses still waiting; the one being answered is not interrupted.
 */
export type SurfacePressLine<Press> = {
  press: (press: Press) => void
  clear: () => void
  /** Presses waiting behind the one being answered. */
  waiting: () => number
}

export function createSurfacePressLine<Press>(deliver: (press: Press) => Promise<unknown> | void): SurfacePressLine<Press> {
  const queue: Press[] = []
  let answering = false

  const advance = () => {
    while (!answering && queue.length > 0) {
      const next = queue.shift() as Press
      let answer: Promise<unknown> | void
      try {
        answer = deliver(next)
      } catch (error) {
        console.error('[a2ui] failed to deliver a surface press', error)
        continue
      }
      if (!answer) continue
      answering = true
      const done = () => {
        answering = false
        advance()
      }
      answer.then(done, done)
    }
  }

  return {
    press(press) {
      queue.push(press)
      advance()
    },
    clear() {
      queue.length = 0
    },
    waiting: () => queue.length,
  }
}
