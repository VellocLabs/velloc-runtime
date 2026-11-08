/**
 * `$.app` in an app's background module worker (F-40). The state is held by
 * the runtime; `update` and `set` diff a copy here and cross as patches, one
 * call at a time, so what the module sees and what is published never part.
 */

import { diffJson } from './appStateDiff'

export type WorkerAppCall = (method: string, args: unknown[]) => Promise<unknown>

const clone = (value: unknown): unknown => {
  if (value === undefined) return undefined
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as unknown
  }
}

export function makeWorkerAppNoun(call: WorkerAppCall): unknown {
  let known: { value: unknown } | undefined
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task)
    chain = run.catch(() => undefined)
    return run
  }
  const fetchState = async (): Promise<unknown> => {
    const state = (await call('state', [])) as { value: unknown }
    known = { value: state.value }
    return state.value
  }
  const commit = async (before: unknown, next: unknown): Promise<unknown> => {
    const patches = diffJson(before, next)
    if (patches.length > 0) {
      try {
        await call('publish', [patches])
      } catch (error) {
        known = undefined
        throw error
      }
    }
    known = { value: next }
    return next
  }
  const state = Object.freeze({
    get: () => serial(fetchState),
    update: (fn: unknown) =>
      serial(async () => {
        if (typeof fn !== 'function') throw new TypeError('$.app.state.update(fn): fn is not a function')
        const before = known ? known.value : await fetchState()
        const draft = clone(before ?? {})
        const returned = (await (fn as (draft: unknown) => unknown)(draft)) as unknown
        return commit(before, returned === undefined ? draft : returned)
      }),
    set: (value: unknown) =>
      serial(async () => {
        const before = known ? known.value : await fetchState()
        return commit(before, value)
      }),
  })
  return Object.freeze({
    state,
    publish: (patches: unknown) =>
      serial(async () => {
        known = undefined
        return call('publish', [patches])
      }),
  })
}
