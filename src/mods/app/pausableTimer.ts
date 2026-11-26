/**
 * Contract: a wall clock that can stand still. A hook's budget is the
 * module's own time: while the platform asks the person something on the
 * hook's behalf, its timers are paused and go on from where they were.
 */

/** A timer whose remaining time stands still between `pause` and `resume`. */
export type PausableTimer = { pause(): void; resume(): void; stop(): void }

export function pausableTimer(fire: () => void, ms: number, now: () => number = Date.now): PausableTimer {
  let left = ms
  let began = now()
  let pauses = 0
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(fire, left)
  let stopped = false
  return {
    pause() {
      if (stopped) return
      pauses += 1
      if (pauses !== 1 || timer === undefined) return
      clearTimeout(timer)
      timer = undefined
      left = Math.max(0, left - (now() - began))
    },
    resume() {
      if (stopped || pauses === 0) return
      pauses -= 1
      if (pauses !== 0) return
      began = now()
      timer = setTimeout(fire, left)
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

/** Runs `work` with the given timers standing still. */
export function whilePaused<T>(timers: ReadonlySet<PausableTimer>, work: () => Promise<T>): Promise<T> {
  const paused = [...timers]
  for (const timer of paused) timer.pause()
  const resume = (): void => {
    for (const timer of paused) timer.resume()
  }
  const waited = Promise.resolve().then(work)
  waited.then(resume, resume)
  return waited
}
