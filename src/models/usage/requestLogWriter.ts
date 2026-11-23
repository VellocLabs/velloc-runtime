/**
 * Contract: the usage log's one writer (F-27). `recordRequest` and
 * `recordFileOps` return at once and never throw; what they were given is
 * written later, after everything recorded before it, one transaction at a
 * time. Something that cannot be written is dropped with one log line and
 * nothing else happens: no caller waits for, or learns of, its rows.
 *
 * A request, and a batch of file rows however large, each take one place in a
 * queue of at most `REQUEST_LOG_QUEUE_MAX`: while no bridge transport is
 * attached yet, while the file is being opened, and while an earlier entry is
 * being written. An entry that arrives at a full queue is dropped; the first
 * drop of a run of drops is logged with the count so far. When the file
 * cannot be opened the waiting entries are dropped with one line, and the
 * open is tried again no sooner than `REOPEN_AFTER_MS` later.
 *
 * The file is opened on first use. A file under its earlier name is renamed
 * before any open, its rollback journal first; when both names exist the
 * earlier file is left as it is. A rename that fails opens nothing.
 *
 * The row cap: when the writer first opens the file, and every
 * `ROW_RECHECK_MS` after, the rows of both tables are counted. Above
 * `ROW_CAP` the oldest `TRIM_SPAN_MS` of rows is deleted `TRIM_DELAY_MS`
 * later, and again after each further `TRIM_DELAY_MS` while the count stays
 * above. A delete waits its turn in the queue.
 */
import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../../browser/bridge/browserBridgeProtocol'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import { userDataRoot } from '../../utils/conversationStoragePaths'
import { traceLine } from '../../utils/debugLog'
import { resolveHomeDirViaBridge } from '../../utils/resolveHomeDirViaBridge'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { DAY_MS } from './requestLogSchema'
import { RequestLogStore, type FileOpRow, type RequestLogRow } from './requestLogStore'

export const REQUEST_LOG_QUEUE_MAX = 256
export const REOPEN_AFTER_MS = 60_000

/** Rows of both tables together above which the oldest are deleted. */
export const ROW_CAP = 5_000_000
export const TRIM_DELAY_MS = 5 * 60_000
export const TRIM_SPAN_MS = 7 * DAY_MS
export const ROW_RECHECK_MS = DAY_MS

const LOG_FILE = 'usage.sqlite'
const EARLIER_LOG_FILE = 'requests.sqlite'

/** `<home>/.velloc/usage/usage.sqlite`. */
export function requestLogPath(homeDir: string): string {
  return joinRuntimePath(userDataRoot(homeDir), 'usage', LOG_FILE)
}

type CapStep = 'count' | 'trim'

type Waiting =
  | { row: RequestLogRow; via?: BrowserBridgeTransport }
  | { fileOps: readonly FileOpRow[]; via?: BrowserBridgeTransport }
  | { cap: CapStep }

let attached: BrowserBridgeTransport | undefined
let config: RuntimeConfig | undefined
/** The transport the entry being written arrived on. */
let current: BrowserBridgeTransport | undefined
/** The transport the last written entry went through; a row-cap step, which
 *  names none, falls back to it when no bridge is attached. */
let lastWritten: BrowserBridgeTransport | undefined
let store: RequestLogStore | undefined
let closedUntil = 0
let queue: Waiting[] = []
let draining: Promise<void> | undefined
let dropped = 0
let dropRun = false
/** A reader's own view of the file, per reader bridge. */
let readers = new WeakMap<BrowserBridgeTransport, RequestLogStore>()
/** The move of a file under its earlier name, shared by every open. */
let named: Promise<void> | undefined
let capTimer: ReturnType<typeof setTimeout> | undefined
let capStarted = false
let nextFsRequest = 0

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

function isAborted(error: unknown): boolean {
  return (error as { name?: unknown } | undefined)?.name === 'AbortError'
}

async function homeDir(transport: BrowserBridgeTransport): Promise<string | undefined> {
  // The runtime's own environment names the home when it has one; the host's
  // answer otherwise.
  const fromEnv = config?.getEnv('HOME') ?? config?.getEnv('USERPROFILE')
  return fromEnv || (await resolveHomeDirViaBridge(transport)) || undefined
}

async function fsCall(
  transport: BrowserBridgeTransport,
  action: 'exists' | 'rename',
  payload: Record<string, string>,
): Promise<unknown> {
  nextFsRequest += 1
  const response = (await transport.request({
    id: `usagelog-fs-${nextFsRequest}`,
    route: createBridgeRoute('fs', action),
    payload,
  } as Parameters<BrowserBridgeTransport['request']>[0])) as
    | { ok: true; result: unknown }
    | { ok: false; error: { code: string; message: string } }
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
  return response.result
}

async function moveEarlierFile(transport: BrowserBridgeTransport, home: string): Promise<void> {
  const file = requestLogPath(home)
  const earlier = joinRuntimePath(userDataRoot(home), 'usage', EARLIER_LOG_FILE)
  if ((await fsCall(transport, 'exists', { path: file })) === true) return
  if ((await fsCall(transport, 'exists', { path: earlier })) !== true) return
  // The journal first: it holds the rollback of an unfinished write, and the
  // engine looks for it beside the file under the file's own name.
  if ((await fsCall(transport, 'exists', { path: `${earlier}-journal` })) === true) {
    await fsCall(transport, 'rename', { oldPath: `${earlier}-journal`, newPath: `${file}-journal` })
  }
  await fsCall(transport, 'rename', { oldPath: earlier, newPath: file })
}

/** Resolves once the file is under its own name, or was never under another.
 *  A failed move is tried again by the next open. */
function fileNamed(transport: BrowserBridgeTransport, home: string): Promise<void> {
  named ??= moveEarlierFile(transport, home).catch(error => {
    named = undefined
    throw error
  })
  return named
}

async function openStore(transport: BrowserBridgeTransport): Promise<RequestLogStore> {
  if (store) return store
  const home = await homeDir(transport)
  if (!home) throw new Error('no home directory')
  await fileNamed(transport, home)
  const opened = new RequestLogStore({
    dbPath: requestLogPath(home),
    transport: () => current ?? attached ?? transport,
  })
  await opened.ensureSchema()
  store = opened
  if (!capStarted) {
    capStarted = true
    queue.push({ cap: 'count' })
    drain()
  }
  return opened
}

/** The open log, for a reader. `via`: the reader's own bridge, which every
 *  read then goes through; without it, the attached one. Undefined with no
 *  bridge at all, or when the file cannot be opened. */
export async function openRequestLog(via?: BrowserBridgeTransport): Promise<RequestLogStore | undefined> {
  try {
    if (!via) return attached ? await openStore(attached) : undefined
    let reader = readers.get(via)
    if (!reader) {
      const home = await homeDir(via)
      if (!home) return undefined
      await fileNamed(via, home)
      reader = new RequestLogStore({ dbPath: requestLogPath(home), transport: () => via })
      readers.set(via, reader)
    }
    await reader.ensureSchema()
    return reader
  } catch {
    return undefined
  }
}

function armCap(step: CapStep, delayMs: number): void {
  if (capTimer !== undefined) clearTimeout(capTimer)
  capTimer = setTimeout(() => {
    capTimer = undefined
    queue.push({ cap: step })
    drain()
  }, delayMs)
  // A pending check must not keep a process alive.
  ;(capTimer as { unref?: () => void }).unref?.()
}

/** Counts the rows, after deleting the oldest for `trim`, and arms the next step. */
async function capStep(opened: RequestLogStore, step: CapStep): Promise<void> {
  try {
    if (step === 'trim' && !(await opened.trimOldest(TRIM_SPAN_MS))) {
      armCap('count', ROW_RECHECK_MS)
      return
    }
    const over = (await opened.rowCount()) > ROW_CAP
    armCap(over ? 'trim' : 'count', over ? TRIM_DELAY_MS : ROW_RECHECK_MS)
  } catch (error) {
    warn('the row cap was not checked', error)
    armCap('count', ROW_RECHECK_MS)
  }
}

/** Drops the waiting entries. A row-cap step among them comes again later. */
function dropWaiting(entries: Waiting[]): void {
  if (entries.some(entry => 'cap' in entry)) armCap('count', ROW_RECHECK_MS)
  queue = queue.filter(entry => !entries.includes(entry))
}

/** The transport an entry is written through; undefined while there is none. */
function transportOf(entry: Waiting): BrowserBridgeTransport | undefined {
  if ('cap' in entry) return attached ?? lastWritten
  return entry.via ?? attached
}

async function writeWaiting(): Promise<void> {
  for (;;) {
    const next = queue[0]
    const transport = next && transportOf(next)
    if (next && !transport && 'cap' in next && queue.length > 1) {
      // A row-cap step with no bridge must not hold back rows that name theirs.
      dropWaiting([next])
      continue
    }
    if (!next || !transport) return
    if (Date.now() < closedUntil) {
      dropWaiting(queue)
      return
    }
    let opened: RequestLogStore
    current = transport
    try {
      opened = await openStore(transport)
    } catch (error) {
      current = undefined
      if (isAborted(error)) {
        // The bridge the row came on was closed with its client; the file is not at fault.
        dropWaiting([next])
        warn('a row was dropped, its bridge is closed')
        if (attached === transport) attached = undefined
        if (lastWritten === transport) lastWritten = undefined
        continue
      }
      closedUntil = Date.now() + REOPEN_AFTER_MS
      warn(`the file could not be opened, ${queue.length} row(s) dropped`, error)
      dropWaiting(queue)
      return
    }
    queue.shift()
    try {
      if ('row' in next) await opened.record(next.row)
      else if ('fileOps' in next) await opened.recordFileOps(next.fileOps)
      else await capStep(opened, next.cap)
      lastWritten = transport
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
      const next = queue[0]
      if (next && transportOf(next) && Date.now() >= closedUntil) drain()
    })
}

function enqueue(entry: Waiting): void {
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
    queue.push(entry)
    drain()
  } catch (error) {
    warn('a row was not queued', error)
  }
}

/** Queues one send for writing. `via`: the bridge transport the request ran
 *  on, when the caller has it. */
export function recordRequest(row: RequestLogRow, via?: BrowserBridgeTransport): void {
  enqueue({ row, ...(via ? { via } : {}) })
}

/** Queues file rows for writing in one transaction: all of them, or none.
 *  `via` as for `recordRequest`. */
export function recordFileOps(rows: readonly FileOpRow[], via?: BrowserBridgeTransport): void {
  if (rows.length === 0) return
  enqueue({ fileOps: [...rows], ...(via ? { via } : {}) })
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
  lastWritten = undefined
  store = undefined
  closedUntil = 0
  queue = []
  dropped = 0
  dropRun = false
  readers = new WeakMap()
  named = undefined
  if (capTimer !== undefined) clearTimeout(capTimer)
  capTimer = undefined
  capStarted = false
}
