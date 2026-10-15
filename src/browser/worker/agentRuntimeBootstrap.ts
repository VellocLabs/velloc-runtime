/**
 * agentRuntimeBootstrap — pure init-step helpers for AgentRuntimeWorker's runInit: trace emitter,
 * storage backend resolution, resume projectRoot restore, boot-stage reporter + keepalive.
 */
import {
  setCallModelEmitter,
  setCallModelLogEnabled,
} from '../../engine/turn/callModelTrace'
import type { CallModelTraceEmitter } from '../../engine/turn/callModelTrace'
import { BridgeFsConversationStorageBackend } from '../storage/BridgeFsSessionStorage'
import { SqliteSessionMetaStore } from '../storage/SqliteSessionMetaStore'
import type { BrowserConversationStorageBackend } from '../../sessions/sessionStore'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'

export type BootStage = 'connectingTools' | 'restoring'

/**
 * Install the `[NexusCallModelTrace]` stream (`?logCallModel=1`; off in production) over the
 * `worker.debugLog` channel, one text line per event.
 */
export function installCallModelTraceEmitter(
  emitDebugLogInfo: (message: string) => void,
): () => void {
  const traceEmitter: CallModelTraceEmitter = (event, data) => {
    // Render fields as `key=value` pairs space-separated. JSON
    // values for non-primitive fields keep arrays/objects
    // representable on one line, which matters for fields like
    // `chunkTypes: ['message_start', 'content_block_delta']`.
    const fields = Object.entries(data)
      .map(([k, v]) => {
        if (
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean'
        ) {
          return `${k}=${v}`
        }
        try {
          return `${k}=${JSON.stringify(v)}`
        } catch {
          return `${k}=<unserializable>`
        }
      })
      .join(' ')
    // Use a plain string message NOT a `data` object — the webview handler
    // picks `data` if present and prints it as an object; only when `data`
    // is undefined does it fall back to `console.info(message)`, which
    // renders one text line per call.
    emitDebugLogInfo(`[NexusCallModelTrace] ${event} ${fields}`)
  }
  // Lease stack: the emitter and the enable flag
  // are REALM-GLOBAL (shared by every session in the SharedWorker), and
  // each closure captures ONE worker's emit channel. Plain
  // last-writer-wins lost the ORIGINAL owner: a nested runtime (a
  // sub-agent or routine whose payload inherited the flag) overwrote the
  // parent's emitter and, on ITS dispose, cleared the global — silencing
  // the still-alive parent. The stack restores the most recent surviving
  // lease instead; the last lease out turns the stream off.
  const lease: CallModelLease = { emitter: traceEmitter }
  callModelLeases.push(lease)
  applyTopCallModelLease()
  return () => {
    const index = callModelLeases.indexOf(lease)
    if (index === -1) return
    const wasTop = index === callModelLeases.length - 1
    callModelLeases.splice(index, 1)
    // A non-top (older) lease leaving changes nothing observable — only
    // re-apply when the ACTIVE emitter just left (avoids the spurious
    // counter reset + 'enabled' line a blind re-apply would emit).
    if (wasTop) applyTopCallModelLease()
  }
}

type CallModelLease = { emitter: CallModelTraceEmitter }

/** Install order = ownership order; the TOP lease drives the global
 *  emitter. Realm-global by design — this mirrors the
 *  realm-global flag it manages. */
const callModelLeases: CallModelLease[] = []

function applyTopCallModelLease(): void {
  const top = callModelLeases[callModelLeases.length - 1]
  if (top) {
    setCallModelEmitter(top.emitter)
    setCallModelLogEnabled(true)
  } else {
    setCallModelEmitter(undefined)
    setCallModelLogEnabled(false)
  }
}

/** Resolve the conversation-storage backend for an init: an injected test
 *  backend wins; else a bridge-fs backend when the payload names a storage
 *  path; else undefined (in-memory). Takes the SCOPE-BOUND transport view
 *  so the backend's requests carry the scope's generation. */
export function resolveStorageBackend(
  payload: AgentRuntimeWorkerInitPayload,
  bridgeTransport: BrowserBridgeTransport,
  injected?: BrowserConversationStorageBackend,
): BrowserConversationStorageBackend | undefined {
  if (injected) {
    return injected
  }
  if (!payload.sessionStoragePath) {
    return undefined
  }
  // Grouped layout stamps the single meta DB's path; when present the backend
  // routes all session-meta ops to the sqlite store (on this scope-bound
  // transport, so its requests carry the scope generation), and never writes
  // `meta.json`. Absent (flat layout) → the worker reuses the shared backend
  // via the injected path instead, so this branch's store-less backend is only
  // the in-memory/legacy fallback.
  const metaStore = payload.sessionMetaDbPath
    ? new SqliteSessionMetaStore({
        transport: bridgeTransport,
        dbPath: payload.sessionMetaDbPath,
      })
    : undefined
  return new BridgeFsConversationStorageBackend({
    transport: bridgeTransport,
    basePath: payload.sessionStoragePath,
    metaStore,
  })
}

/**
 * Resume restore: read a bound session's `projectRoot` from its own persisted summary, AWAITED, before
 * createAgentRuntime. No-op for sessions that never bound a folder.
 */
export async function resolveResumeProjectRoot(
  payload: AgentRuntimeWorkerInitPayload,
  backend: BrowserConversationStorageBackend | undefined,
): Promise<AgentRuntimeWorkerInitPayload> {
  if (
    !payload.projectRoot &&
    payload.sessionId &&
    backend?.loadSessionSummary
  ) {
    try {
      const summary = await backend.loadSessionSummary(payload.sessionId)
      if (summary?.projectRoot) {
        return { ...payload, projectRoot: summary.projectRoot }
      }
    } catch {
      // best-effort; a code session falls back to the forced folder picker.
    }
  }
  return payload
}

/**
 * Boot-welcome milestones from inside the runtime build plus a keepalive that re-emits the current
 * stage on an interval (liveness only); `clear()` once the build resolves. Primary boot session only.
 */
export function createBootStageReporter(
  enabled: boolean,
  sessionId: string | undefined,
  broadcast: (stage: BootStage, sessionId: string) => void,
): { onBootStage?: (stage: BootStage) => void; clear: () => void } {
  if (!enabled || !sessionId) {
    return { onBootStage: undefined, clear: () => {} }
  }
  // Latest stage the runtime build reported — re-broadcast by the keepalive
  // so the boot-welcome fallback keeps resetting through the long,
  // stage-boundary-less phases of createBrowserRuntime.
  let lastBootStage: BootStage | null = null
  const onBootStage = (stage: BootStage) => {
    lastBootStage = stage
    broadcast(stage, sessionId)
  }
  const keepAlive = setInterval(() => {
    if (lastBootStage) {
      broadcast(lastBootStage, sessionId)
    }
  }, 3_000)
  return {
    onBootStage,
    clear: () => clearInterval(keepAlive),
  }
}
