/**
 * Dedicated import Worker entry. Spawned lazily by `workerClient.ts` (from
 * inside the SharedWorker) and fed `ImportWorkerRequest`s over
 * `postMessage`; answers with `ImportWorkerResponse`s. Pure — no fs, no
 * bridge — so a crash here is contained: the client terminates and
 * respawns on the next call.
 */

import { runImportRequest } from './inline'
import type { ImportWorkerRequest } from './protocol'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ImportWorkerRequest>) => void) | null
  postMessage(message: unknown): void
}

scope.onmessage = (event: MessageEvent<ImportWorkerRequest>) => {
  const request = event.data
  if (!request || typeof request !== 'object' || typeof request.id !== 'string') {
    return
  }
  scope.postMessage(runImportRequest(request))
}
