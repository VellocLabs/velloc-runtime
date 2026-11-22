/**
 * `$.app` in an app's script worker (F-40). The worker holds the state: it
 * is read from the runtime once, then every read is answered here and every
 * change is applied here and sent on as a numbered batch of patches, one at
 * a time. The holder outlives a hook, so each hook's `$.app` shares it.
 */

import type { AppDataPatch } from '../../browser/runtimeProtocol/modApps'
import { APP_PATCH_BATCH_MAX, APP_STATE_MAX_BYTES, appStateText, applyAppPatches, checkAppPatches, diffJson, utf8Length } from './appStateDiff'

/** The method of `app` the runtime calls in the worker for the state's text. */
export const APP_STATE_TEXT_METHOD = 'stateText'

export type WorkerAppCall = (method: string, args: unknown[]) => Promise<unknown>

export type WorkerAppState = {
  /** `$.app` for one hook; `call` reaches the runtime on that hook's behalf. */
  noun(call: WorkerAppCall): unknown
  /** The state as text and the batch it stands at; `{ unloaded: true }` before the first read. */
  text(): Promise<{ text: string; seq: number } | { unloaded: true }>
}

const clone = <T>(value: T): T => {
  if (value === undefined) return value
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

export function makeWorkerAppState(): WorkerAppState {
  /** Never an object the module holds, so an in-place edit of one never changes it. */
  let held: { value: unknown; seq: number } | undefined
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task)
    chain = run.catch(() => undefined)
    return run
  }
  const load = async (call: WorkerAppCall): Promise<{ value: unknown; seq: number }> => {
    if (held) return held
    const state = (await call('state', [])) as { value: unknown; version?: number }
    held = { value: state.value, seq: typeof state.version === 'number' ? state.version : 0 }
    return held
  }
  /** Applies the batch here, then sends it; throws before either when the batch is refused. */
  const commit = async (call: WorkerAppCall, patches: readonly AppDataPatch[]): Promise<number> => {
    const now = held!
    if (patches.length === 0) return now.seq
    const bytes = utf8Length(JSON.stringify(patches))
    if (bytes > APP_STATE_MAX_BYTES) throw new RangeError(`$.app.publish(patches): the batch is ${bytes} bytes; at most ${APP_STATE_MAX_BYTES}`)
    const seq = now.seq + 1
    held = { value: applyAppPatches(now.value, clone(patches)), seq }
    await call('publish', [patches, seq])
    return seq
  }
  /** A change wider than one batch takes goes as the whole state. */
  const batchOf = (before: unknown, next: unknown): AppDataPatch[] => {
    const diff = diffJson(before, next)
    return diff.length > APP_PATCH_BATCH_MAX ? [{ path: '', value: next }] : diff
  }

  const noun = (call: WorkerAppCall): unknown => {
    const state = Object.freeze({
      get: () => serial(async () => clone((await load(call)).value)),
      update: (fn: unknown) =>
        serial(async () => {
          if (typeof fn !== 'function') throw new TypeError('$.app.state.update(fn): fn is not a function')
          const before = (await load(call)).value
          const draft = clone(before ?? {})
          const returned = (await (fn as (draft: unknown) => unknown)(draft)) as unknown
          const next = returned === undefined ? draft : returned
          await commit(call, batchOf(before, next))
          return next
        }),
      set: (value: unknown) =>
        serial(async () => {
          const before = (await load(call)).value
          await commit(call, batchOf(before, value))
          return value
        }),
    })
    return Object.freeze({
      state,
      publish: (patches: unknown) =>
        serial(async () => {
          const refused = checkAppPatches(patches)
          if (refused) throw new TypeError(refused)
          const before = (await load(call)).value
          // Sent as the diff, not as given: `-` and array removals become the replacements every reader applies alike.
          const next = applyAppPatches(before, clone(patches as readonly AppDataPatch[]))
          return { version: await commit(call, batchOf(before, next)) }
        }),
      /** A count on the app's topbar icon; `null` clears it. Checked by the runtime. */
      badge: (count: unknown) => call('badge', [count]),
      /** Whether the module is at work: the app's topbar icon shows it while true. Checked by the runtime. */
      busy: (on: unknown) => call('busy', [on]),
      /** A headless agent run in the app's folder: `{ ok: true, text }` or `{ ok: false, reason }`. Not serialized with the state. */
      analyze: (request: unknown) => call('analyze', [request]),
      /** The app on the pages: `open` shows it, `close` closes its pane; `{ client }` names one page. Resolves once asked. */
      view: Object.freeze({
        open: (options?: unknown) => call('view', ['open', options]),
        close: (options?: unknown) => call('view', ['closed', options]),
      }),
      /** The plugin's seed copied over the app's folder again, `config.json` and the data kept, and the page rebuilt. Resolves once the new page is live; rejects with `AppBuildError` when it does not build. */
      reseed: () => call('reseed', []),
    })
  }

  return {
    noun,
    // The value and its batch number are replaced together, so this never waits for a change in hand.
    text: async () => (held ? { text: appStateText(held.value), seq: held.seq } : { unloaded: true as const }),
  }
}
