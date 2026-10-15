/**
 * run_js DedicatedWorker entry, bundled standalone and spawned per run from a
 * `data:` URL by the kernel's sandboxed frame (opaque origin, that frame's CSP);
 * torn down when the run settles. Hands `worker.init` and `event.ports[0]` to
 * `runScriptInWorker`. The CSP's `'unsafe-eval'` is only for runJsWorkerCore's
 * AsyncFunction eval.
 */

import type { WorkerInitMessage } from '../workerKernel/kernelProtocol'
import type { RunJsScriptInit } from './runJsProtocol'
import { hardenWorkerRealm } from './hardenWorkerRealm'
import { runScriptInWorker } from './runJsWorkerCore'

const scope = self as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void
}

// Strip the realm's raw-capability surface (network, storage, importScripts,
// nested workers) BEFORE any script can run — see hardenWorkerRealm.ts for the
// list and the honest limits. Module-eval time, so it precedes the first
// message unconditionally.
hardenWorkerRealm(self)

scope.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as WorkerInitMessage | null
  if (!msg || msg.type !== 'worker.init') return
  const peer = event.ports?.[0]
  if (!peer) return
  const init = msg.init as RunJsScriptInit
  runScriptInWorker(init.code, peer, init.workspaceName, init.inputs, init.mode)
})
