/**
 * Contract: merge async streams, emitting each value as its source produces it.
 * At most `maxActive` sources are read at a time (the rest admitted in list
 * order); each active source keeps one read outstanding; `undefined` values are
 * dropped; a throwing source ends the stream with that error; stopping early
 * does not close the sources.
 */
type Read<T> = { source: AsyncGenerator<T, void>; result: IteratorResult<T, void> }

export async function* interleaveStreams<T>(
  sources: AsyncGenerator<T, void>[],
  maxActive = Infinity,
): AsyncGenerator<T, void> {
  const queue = sources.slice()
  // Keyed by source; re-inserting after each value moves a source to the back,
  // so sources that are all ready take turns.
  const reads = new Map<AsyncGenerator<T, void>, Promise<Read<T>>>()

  const request = (source: AsyncGenerator<T, void>) => {
    reads.set(
      source,
      source.next().then(result => ({ source, result })),
    )
  }

  const admit = () => {
    const source = queue.shift()
    if (source) request(source)
  }

  for (let started = 0; started < maxActive && queue.length > 0; started++) {
    admit()
  }

  while (reads.size > 0) {
    const { source, result } = await Promise.race(reads.values())
    reads.delete(source)
    if (result.done) {
      admit()
      continue
    }
    request(source)
    if (result.value !== undefined) yield result.value
  }
}
