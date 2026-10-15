import { describe, expect, it } from 'vitest'
import { interleaveStreams } from '../utils/async/interleaveStreams'

// Merging several async streams into one, as the tool runner does for a batch
// of read-only tool calls: values arrive as soon as any source produces them,
// optionally with a limit on how many sources run at once.

async function* fromList<T>(items: T[], log?: string[], name = '?') {
  for (const item of items) {
    log?.push(`${name}:pull`)
    yield item
  }
  log?.push(`${name}:end`)
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

async function collect<T>(stream: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = []
  for await (const value of stream) out.push(value)
  return out
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('interleaveStreams', () => {
  it('yields nothing for no sources', async () => {
    expect(await collect(interleaveStreams<number>([]))).toEqual([])
  })

  it('round-robins sources that are always ready', async () => {
    const merged = interleaveStreams([
      fromList(['a1', 'a2', 'a3']),
      fromList(['b1', 'b2']),
      fromList(['c1']),
    ])
    expect(await collect(merged)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3'])
  })

  it('delivers values in the order the sources produce them', async () => {
    const slow = deferred()
    const fast = deferred()
    async function* first() {
      await slow.promise
      yield 'slow'
    }
    async function* second() {
      await fast.promise
      yield 'fast'
    }
    const merged = collect(interleaveStreams([first(), second()]))
    fast.resolve()
    await tick()
    slow.resolve()
    expect(await merged).toEqual(['fast', 'slow'])
  })

  it('skips undefined values but keeps reading that source', async () => {
    const merged = interleaveStreams<number | undefined>([
      fromList([undefined, 1, undefined, 2]),
    ])
    expect(await collect(merged)).toEqual([1, 2])
  })

  it('starts at most maxActive sources and admits the next when one ends', async () => {
    const log: string[] = []
    const merged = interleaveStreams(
      [
        fromList([1, 2], log, 'a'),
        fromList([3], log, 'b'),
        fromList([4], log, 'c'),
      ],
      2,
    )
    expect(await collect(merged)).toEqual([1, 3, 2, 4])
    expect(log.indexOf('c:pull')).toBeGreaterThan(log.indexOf('b:end'))
  })

  it('runs sources one after another with maxActive 1', async () => {
    const merged = interleaveStreams(
      [fromList([1, 2]), fromList([3, 4]), fromList([5])],
      1,
    )
    expect(await collect(merged)).toEqual([1, 2, 3, 4, 5])
  })

  it('yields nothing when maxActive is 0', async () => {
    expect(await collect(interleaveStreams([fromList([1])], 0))).toEqual([])
  })

  it('asks a source for its next value before handing the current one out', async () => {
    const log: string[] = []
    const merged = interleaveStreams([fromList([1, 2], log, 'a')])
    expect((await merged.next()).value).toBe(1)
    await tick()
    expect(log).toEqual(['a:pull', 'a:pull'])
    await merged.return(undefined)
  })

  it('surfaces a source failure to the consumer', async () => {
    async function* broken(): AsyncGenerator<number, void> {
      yield 1
      throw new Error('source broke')
    }
    await expect(collect(interleaveStreams([broken()]))).rejects.toThrow(
      'source broke',
    )
  })

  it('does not close the sources when the consumer stops early', async () => {
    let closed = false
    async function* source() {
      try {
        yield 1
        yield 2
        await new Promise(() => {})
      } finally {
        closed = true
      }
    }
    const merged = interleaveStreams([source()])
    await merged.next()
    await merged.return(undefined)
    await tick()
    expect(closed).toBe(false)
  })
})
