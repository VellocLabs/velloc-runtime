/** `work`'s value, or a timeout after `ms`: the work is left to settle on its
 *  own and its late outcome is dropped. */
export type Deadline<T> = { timedOut: false; value: T } | { timedOut: true }

export function withinMs<T>(work: Promise<T>, ms: number): Promise<Deadline<T>> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms)
    work.then(
      value => {
        clearTimeout(timer)
        resolve({ timedOut: false, value })
      },
      () => {
        clearTimeout(timer)
        resolve({ timedOut: true })
      },
    )
  })
}
