import { createBrowserRuntimeSharedWorker } from '../browser/webview/createBrowserRuntimeSharedWorker'

// Create the runtime SharedWorker early (before main.tsx) so it loads during the
// boot handshake; the same factory makes it the instance boot later connects
// to. Idempotent; a failure is harmless. Skipped on a remote boot (F-24),
// detected by marker without importing remotePairing.ts.
try {
  const isRemoteBoot =
    globalThis.location?.hash?.includes('rt=') === true ||
    globalThis.sessionStorage?.getItem('nexus.remotePairing') !== null ||
    globalThis.localStorage?.getItem('nexus.remoteDevicePairing') !== null
  if (isRemoteBoot) {
    // Skip: no worker to warm on the remote path.
  } else {
    const worker = createBrowserRuntimeSharedWorker()
    // Establish the connection so the worker's onconnect fires (the manager is
    // constructed) and the worker stays warm until the real boot connects.
    worker.port.start()
    ;(globalThis as { __nexusWarmWorker?: SharedWorker }).__nexusWarmWorker = worker
  }
} catch (err) {
  console.warn('[NexusWarm] shared worker warm-up skipped', err)
}
