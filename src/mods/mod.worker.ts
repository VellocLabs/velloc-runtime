/**
 * Security: the mod DedicatedWorker entry. Spawned by the kernel's sandboxed frame, so
 * it has an opaque origin under `default-src 'none'`; it hardens the realm, then hands
 * the data port to `installModWorkerHost`. The module text arrives as `mod.load` and
 * is imported as a `data:` module, the one import the policy allows.
 */

import { hardenWorkerRealm } from '../browser/runJs/hardenWorkerRealm'
import type { WorkerInitMessage } from '../browser/workerKernel/kernelProtocol'
import { installModWorkerHost } from './ModWorkerHost'

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

// Before any module code can run: strip the realm's raw capabilities
// (network, storage, nested workers). Everything a mod may reach is `$`.
hardenWorkerRealm(self)

let installed = false
scope.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as WorkerInitMessage | null
  if (installed || !msg || msg.type !== 'worker.init') return
  const peer = event.ports?.[0]
  if (!peer) return
  installed = true
  installModWorkerHost(peer)
})
