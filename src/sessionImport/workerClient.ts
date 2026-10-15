/**
 * Client for the dedicated import Worker: spawned on demand, torn down after
 * `idleMs`, terminated on a request timeout. Without `Worker` it runs inline
 * (`mode`). If the Worker errors, in-flight requests re-run inline, so
 * `ArrayBuffer` payloads are cloned, never transferred.
 */

import type { ImportWorkerRequest, ImportWorkerResponse } from './protocol'

export type ImportWorkerClientOptions = {
  /** Per-request timeout (ms). Default 120 s. */
  timeoutMs?: number
  /** Idle time before the Worker is terminated (ms). Default 60 s. */
  idleMs?: number
  /** Test seam: how to construct the Worker. Default spawns
   *  `./sessionImport.worker.ts` as a module worker. */
  spawn?: () => Worker
  /** Test seam: the inline fallback (loaded lazily by default so the main
   *  SharedWorker chunk does not carry the converter). */
  runInline?: (request: ImportWorkerRequest) => Promise<ImportWorkerResponse>
}

type Pending = {
  /** Kept so a Worker crash (`onerror`) can re-run the request inline rather
   *  than hard-failing it — see {@link ImportWorkerClient.recoverInline}. */
  request: ImportWorkerRequest
  resolve(response: ImportWorkerResponse): void
  timer: ReturnType<typeof setTimeout>
}

function defaultSpawn(): Worker {
  return new Worker(new URL('./sessionImport.worker.ts', import.meta.url), {
    type: 'module',
    name: 'nexus-session-import',
  })
}

async function defaultRunInline(
  request: ImportWorkerRequest,
): Promise<ImportWorkerResponse> {
  const { runImportRequest } = await import('./inline')
  return runImportRequest(request)
}

export class ImportWorkerClient {
  private worker: Worker | null = null
  private readonly pending = new Map<string, Pending>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly timeoutMs: number
  private readonly idleMs: number
  private readonly spawn: () => Worker
  private readonly runInline: (
    request: ImportWorkerRequest,
  ) => Promise<ImportWorkerResponse>
  /** 'worker' once a Worker has been spawned successfully, 'inline' after a
   *  spawn failure (sticky — no point retrying every call), null before the
   *  first request. */
  mode: 'worker' | 'inline' | null = null
  /** Why the spawn failed, when `mode === 'inline'` was forced by a throw.
   *  Diagnostics only (surfaced on `listSessions.spawnError`). */
  spawnError: string | null = null

  constructor(options: ImportWorkerClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.idleMs = options.idleMs ?? 60_000
    this.spawn = options.spawn ?? defaultSpawn
    this.runInline = options.runInline ?? defaultRunInline
  }

  async request(request: ImportWorkerRequest): Promise<ImportWorkerResponse> {
    const worker = this.ensureWorker()
    if (!worker) {
      return this.runInline(request)
    }
    return new Promise<ImportWorkerResponse>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        // A hung parser: kill the Worker so it cannot wedge later calls.
        this.terminate()
        resolve({
          id: request.id,
          ok: false,
          error: {
            code: 'timeout',
            message: `Import request ${request.kind} timed out after ${this.timeoutMs}ms`,
          },
        })
      }, this.timeoutMs)
      this.pending.set(request.id, { request, resolve, timer })
      try {
        // Structured-clone (no transfer): recoverInline may need to re-read the
        // payload bytes in this thread, which a transferred buffer forbids.
        worker.postMessage(request)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(request.id)
        resolve({
          id: request.id,
          ok: false,
          error: {
            code: 'post_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
      this.touchIdle()
    })
  }

  /** Tear the Worker down; in-flight requests resolve as errors. */
  terminate(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const worker = this.worker
    this.worker = null
    if (worker) {
      try {
        worker.terminate()
      } catch {
        /* already gone */
      }
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({
        id,
        ok: false,
        error: { code: 'terminated', message: 'Import worker terminated' },
      })
    }
    this.pending.clear()
  }

  private ensureWorker(): Worker | null {
    if (this.mode === 'inline') return null
    if (this.worker) return this.worker
    // No `typeof Worker` gate here: the default spawn throws a ReferenceError
    // where Worker is undefined, which is the same "fall back inline" path as
    // a host that refuses nested workers — and an injected spawn still runs.
    try {
      const worker = this.spawn()
      worker.onmessage = (event: MessageEvent<ImportWorkerResponse>) => {
        this.settleReply(event.data)
      }
      worker.onerror = () => {
        // The Worker crashed (an error outside `runImportRequest`'s try/catch —
        // e.g. an OOM kill) or its module never loaded (a mis-bundled worker
        // chunk in a packaged build). Don't hard-fail the in-flight requests
        // with `terminated`: recover them inline so the import still completes.
        this.recoverInline()
      }
      this.worker = worker
      this.mode = 'worker'
      return worker
    } catch (error) {
      this.mode = 'inline'
      this.spawnError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      console.warn('[sessionImport] import Worker spawn failed; running inline:', this.spawnError)
      return null
    }
  }

  /**
   * A Worker crash / load failure: tear the Worker down, switch to inline mode
   * (sticky — a Worker that errored once is not trusted again, matching the
   * spawn-failure path), and re-run every in-flight request inline. This is
   * safe because `runImportRequest` is pure and bounded, and the payloads were
   * cloned (not transferred) so their bytes are still readable here.
   */
  private recoverInline(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const worker = this.worker
    this.worker = null
    this.mode = 'inline'
    if (worker) {
      try {
        worker.terminate()
      } catch {
        /* already gone */
      }
    }
    const pending = Array.from(this.pending.values())
    this.pending.clear()
    for (const entry of pending) {
      clearTimeout(entry.timer)
      void this.runInline(entry.request).then(
        response => entry.resolve(response),
        error =>
          entry.resolve({
            id: entry.request.id,
            ok: false,
            error: {
              code: 'convert_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      )
    }
  }

  private settleReply(response: ImportWorkerResponse): void {
    if (!response || typeof response.id !== 'string') return
    const entry = this.pending.get(response.id)
    if (!entry) return
    this.pending.delete(response.id)
    clearTimeout(entry.timer)
    entry.resolve(response)
    this.touchIdle()
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.terminate()
      else this.touchIdle()
    }, this.idleMs)
  }
}
