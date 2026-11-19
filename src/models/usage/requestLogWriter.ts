/**
 * Contract: the request log's one writer (F-27). `recordRequest` returns at once and never throws; the row is
 * written later, after the rows recorded before it, one at a time. A row
 * that cannot be written is dropped with one log line and nothing else
 * happens: no request waits for, or learns of, its row.
 *
 * Rows wait in a queue of at most `REQUEST_LOG_QUEUE_MAX`: while no bridge
 * transport is attached yet, while the file is being opened, and while an
 * earlier row is being written. A row that arrives at a full queue is
 * dropped; the first drop of a run of drops is logged with the count so far.
 * When the file cannot be opened the waiting rows are dropped with one line,
 * and the open is tried again no sooner than `REOPEN_AFTER_MS` later.
 */
import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import { userDataRoot } from '../../utils/conversationStoragePaths'
import { traceLine } from '../../utils/debugLog'
import { resolveHomeDirViaBridge } from '../../utils/resolveHomeDirViaBridge'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { RequestLogStore, type RequestLogRow } from './requestLogStore'

export const REQUEST_LOG_QUEUE_MAX = 256
export const REOPEN_AFTER_MS = 60_000

/** `<home>/.velloc/usage/requests.sqlite`. */
export function requestLogPath(homeDir: string): string {
  return joinRuntimePath(userDataRoot(homeDir), 'usage', 'requests.sqlite')
}

type Waiting = { row: RequestLogRow; via?: BrowserBridgeTransport }

let attached: BrowserBridgeTransport | undefined
let config: RuntimeConfig | undefined
/** The transport the row being written arrived on. */
let current: BrowserBridgeTransport | undefined
let store: RequestLogStore | undefined
let closedUntil = 0
let queue: Waiting[] = []
let draining: Promise<void> | undefined
let dropped = 0
let dropRun = false

function warn(text: string, error?: unknown): void {
  const detail = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`
  traceLine(`[usage] request log: ${text}${detail}`, { level: 'warn' })
}

/** The bridge the log is written through until another is attached. A row
 *  recorded with its own transport is written through that one. */
export function attachRequestLogBridge(transport: BrowserBridgeTransport, runtimeConfig?: RuntimeConfig): void {
  attached = transport
  if (runtimeConfig) config = runtimeConfig
  if (queue.length > 0) drain()
}

async function homeDir(transport: BrowserBridgeTransport): Promise<string | undefined> {
  // The runtime's own environment names the home when it has one; the host's
  // answer otherwise.
  const named = config?.getEnv('HOME') ?? config?.getEnv('USERPROFILE')
  return named || (await resolveHomeDirViaBridge(transport)) || undefined
}

async function openStore(transport: BrowserBridgeTransport): Promise<RequestLogStore> {
  if (store) return store
  const home = await homeDir(transport)
  if (!home) throw new Error('no home directory')
  const opened = new RequestLogStore({
    dbPath: requestLogPath(home),
    transport: () => current ?? attached ?? transport,
  })
  await opened.ensureSchema()
  store = opened
  return opened
}

/** The open log, for a reader. Undefined while no bridge is attached or the
 *  file cannot be opened. */
export async function openRequestLog(): Promise<RequestLogStore | undefined> {
  if (!attached) return undefined
  try {
    return await openStore(attached)
  } catch {
    return undefined
  }
}

async function writeWaiting(): Promise<void> {
  for (;;) {
    const next = queue[0]
    const transport = next?.via ?? attached
    if (!next || !transport) return
    if (Date.now() < closedUntil) {
      queue = []
      return
    }
    let opened: RequestLogStore
    current = transport
    try {
      opened = await openStore(transport)
    } catch (error) {
      current = undefined
      closedUntil = Date.now() + REOPEN_AFTER_MS
      warn(`the file could not be opened, ${queue.length} row(s) dropped`, error)
      queue = []
      return
    }
    queue.shift()
    try {
      await opened.record(next.row)
    } catch (error) {
      warn('a row was not written', error)
    } finally {
      current = undefined
    }
  }
}

function drain(): void {
  if (draining) return
  draining = writeWaiting()
    .catch(error => warn('the writer stopped', error))
    .finally(() => {
      draining = undefined
      if (queue.length > 0 && (queue[0]?.via ?? attached) && Date.now() >= closedUntil) drain()
    })
}

/** Queues one send for writing. `via`: the bridge transport the request ran
 *  on, when the caller has it. */
export function recordRequest(row: RequestLogRow, via?: BrowserBridgeTransport): void {
  try {
    if (Date.now() < closedUntil) return
    if (queue.length >= REQUEST_LOG_QUEUE_MAX) {
      dropped += 1
      if (!dropRun) {
        dropRun = true
        warn(`the queue is full, a row was dropped (${dropped} so far)`)
      }
      return
    }
    dropRun = false
    queue.push({ row, ...(via ? { via } : {}) })
    drain()
  } catch (error) {
    warn('a row was not queued', error)
  }
}

/** Test hooks. */
export function requestLogQueueLength(): number {
  return queue.length
}

export async function requestLogIdle(): Promise<void> {
  while (draining) await draining
}

export function resetRequestLog(): void {
  attached = undefined
  config = undefined
  current = undefined
  store = undefined
  closedUntil = 0
  queue = []
  dropped = 0
  dropRun = false
}
