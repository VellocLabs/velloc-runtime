import type { ToolCallContext } from '../toolkit/toolCallContext'
import { fsForContext } from '../utils/fs/runtimeFs'
import { isFsNotFoundError } from '../utils/fsTransportFailure'

export interface MutationFileState {
  readonly kind: 'file' | 'missing'
  /** SHA-256 of raw file bytes; missing paths use the literal "missing". */
  readonly digest: string
  readonly content?: string
}
export interface MutationFileSnapshot { readonly path: string; readonly state: MutationFileState }
export interface ObservedWorkspaceMutation {
  readonly ref: string
  readonly paths: readonly string[]
  readonly operation: 'write' | 'move' | 'unlink'
  readonly changes: readonly { readonly path: string; readonly before: MutationFileState; readonly after: MutationFileState }[]
}
export type WorkspaceMutationObserver = (mutation: ObservedWorkspaceMutation, context: ToolCallContext, signal: AbortSignal) => Promise<void> | void
type ObserverOptions = { runtimeConfig?: object }
interface Registration {
  observe: WorkspaceMutationObserver
  pending: Array<{ mutation: ObservedWorkspaceMutation; context: ToolCallContext }>
  active: boolean
  disposed: boolean
  controller?: AbortController
}
const observers = new WeakMap<object, Registration>()
const suppressed = new WeakMap<ToolCallContext, number>()
const keyOf = (options: ObserverOptions) => options.runtimeConfig ?? options
const MAX_PENDING = 32
const MAX_FILE_BYTES = 128 * 1024
const OBSERVATION_TIMEOUT_MS = 60_000

/** Security: suppression belongs to the exact host context, never model arguments. */
export async function withSuppressedWorkspaceMutations<T>(context: ToolCallContext, task: () => Promise<T>): Promise<T> {
  suppressed.set(context, (suppressed.get(context) ?? 0) + 1)
  try { return await task() } finally {
    const remaining = suppressed.get(context)! - 1
    if (remaining) suppressed.set(context, remaining)
    else suppressed.delete(context)
  }
}

/** Contract: one observer per runtime; disposal cancels queued and active observations. */
export function registerWorkspaceMutationObserver(options: ObserverOptions, observe: WorkspaceMutationObserver): () => void {
  const key = keyOf(options)
  const previous = observers.get(key)
  if (previous) { previous.disposed = true; previous.pending.length = 0; previous.controller?.abort() }
  const registration: Registration = { observe, pending: [], active: false, disposed: false }
  observers.set(key, registration)
  return () => {
    registration.disposed = true
    registration.pending.length = 0
    registration.controller?.abort()
    if (observers.get(key) === registration) observers.delete(key)
  }
}

async function drain(registration: Registration): Promise<void> {
  if (registration.active || registration.disposed) return
  registration.active = true
  try {
    while (!registration.disposed && registration.pending.length) {
      const item = registration.pending.shift()!
      const controller = new AbortController()
      registration.controller = controller
      const timer = setTimeout(() => controller.abort(), OBSERVATION_TIMEOUT_MS)
      try {
        // Keep the slot until settlement even after timeout; an ignored abort cannot leak parallel tasks.
        if (!controller.signal.aborted) await registration.observe(item.mutation, item.context, controller.signal)
      } catch { /* Observation cannot change the committed tool outcome. */ }
      finally { clearTimeout(timer) }
    }
  } finally { registration.active = false; registration.controller = undefined }
}

async function snapshotFile(context: ToolCallContext, path: string): Promise<MutationFileSnapshot | undefined> {
  const fs = fsForContext(context)
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return undefined
    const bytes = await fs.readFileBytes(path, MAX_FILE_BYTES + 1)
    if (bytes.length !== stat.size || bytes.length > MAX_FILE_BYTES) return undefined
    const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
    const digest = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    let content: string | undefined
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* Binary evidence retains its byte digest only. */ }
    return Object.freeze({ path, state: Object.freeze({ kind: 'file', digest, ...(content === undefined ? {} : { content }) }) })
  } catch (error) {
    if (isFsNotFoundError(error)) return Object.freeze({ path, state: Object.freeze({ kind: 'missing', digest: 'missing' }) })
    return undefined
  }
}

/** Contract: capture immediately before a permission-approved mutation; uncertain or oversized states fail closed. */
export async function captureWorkspaceMutation(context: ToolCallContext, paths: readonly string[]): Promise<readonly MutationFileSnapshot[] | undefined> {
  try {
    const registration = observers.get(keyOf(context.options))
    if (suppressed.has(context) || !registration || registration.disposed || registration.pending.length >= MAX_PENDING) return undefined
    if (!paths.length || paths.length > 32 || paths.some(path => !path || path.includes('\0'))) return undefined
    const snapshots = await Promise.all([...new Set(paths)].map(path => snapshotFile(context, path)))
    return snapshots.every((item): item is MutationFileSnapshot => item !== undefined) ? Object.freeze(snapshots) : undefined
  } catch { return undefined }
}

/** Security: invoke only after confirmed disk success, never from model output or tool prose. */
export async function observeWorkspaceMutation(context: ToolCallContext, operation: ObservedWorkspaceMutation['operation'], before: readonly MutationFileSnapshot[] | undefined): Promise<void> {
  try {
    if (!before?.length || suppressed.has(context)) return
    const after = await captureWorkspaceMutation(context, before.map(item => item.path))
    if (!after) return
    const changes = before.flatMap((item, index) => {
      const current = after[index]
      if (!current || current.path !== item.path || (current.state.kind === item.state.kind && current.state.digest === item.state.digest)) return []
      return [Object.freeze({ path: item.path, before: item.state, after: current.state })]
    })
    if (!changes.length) return
    const registration = observers.get(keyOf(context.options))
    if (!registration || registration.disposed || suppressed.has(context) || registration.pending.length >= MAX_PENDING) return
    const mutation = Object.freeze({ ref: crypto.randomUUID(), operation, paths: Object.freeze(changes.map(change => change.path)), changes: Object.freeze(changes) })
    registration.pending.push({ mutation, context })
    void Promise.resolve().then(() => drain(registration)).catch(() => undefined)
  } catch { /* Snapshot or observation failure must not change a successful tool result. */ }
}
