/**
 * Window-realm lifecycle owner of the kernel's DedicatedWorkers: spawn on
 * `worker.spawn`, terminate on `worker.terminate` or a crash; never on the data
 * path. Live workers stay in a `Map` because a collected `Worker` may be closed
 * as an orphan. Kind-agnostic: a profile supplies a spawner per `kind`, and an
 * unserved kind is answered `worker.error`.
 */

import type { WorkerControlToWindow } from './kernelProtocol'

export type WorkerSpawner = (name?: string) => Worker

export type WindowWorkerHostHandle = {
  /** Stop accepting spawns and terminate any live workers. Idempotent. */
  dispose(): void
}

/**
 * Install the host on the window's end of the control channel. Boot calls this
 * once; the returned handle is kept for the page's lifetime.
 */
export function installWindowWorkerHost(
  controlPort: MessagePort,
  spawners: Readonly<Record<string, WorkerSpawner | undefined>>,
): WindowWorkerHostHandle {
  const workers = new Map<string, Worker>()

  const terminate = (key: string): void => {
    const worker = workers.get(key)
    if (!worker) return
    workers.delete(key)
    try {
      worker.terminate()
    } catch {
      /* already gone */
    }
  }

  const reportError = (key: string, message: string): void => {
    try {
      controlPort.postMessage({ type: 'worker.error', key, message })
    } catch {
      /* control channel gone */
    }
  }

  const handler = (event: MessageEvent): void => {
    const msg = event.data as WorkerControlToWindow | null
    if (!msg) return

    if (msg.type === 'worker.terminate') {
      terminate(msg.key)
      return
    }

    if (msg.type === 'worker.spawn') {
      const peer = event.ports?.[0]
      if (!peer) {
        // No data port — nothing the worker could talk over. The kernel will
        // time out; surface the anomaly for DevTools.
        console.warn(
          '[windowWorkerHost] spawn message without a transferred port; ignoring',
        )
        return
      }
      const spawn = Object.prototype.hasOwnProperty.call(spawners, msg.kind)
        ? spawners[msg.kind]
        : undefined
      if (!spawn) {
        reportError(msg.key, `no worker host is installed for kind "${msg.kind}"`)
        return
      }
      let worker: Worker
      try {
        worker = spawn(typeof msg.name === 'string' ? msg.name : undefined)
      } catch (err) {
        // Spawn threw (a host that refuses nested workers, a mis-bundled
        // chunk). We still hold `peer` (transfer didn't happen) — tell the
        // kernel so its run fails fast instead of timing out.
        reportError(msg.key, err instanceof Error ? err.message : String(err))
        return
      }
      worker.onerror = event_ => {
        // Module load failure or an error outside the worker's try/catch.
        terminate(msg.key)
        reportError(
          msg.key,
          (event_ as ErrorEvent)?.message ?? `${msg.kind} worker crashed`,
        )
      }
      workers.set(msg.key, worker)
      // Hand the worker its end of the data pipe + the profile's init. Guard
      // the transfer like spawn() above: a throw here (structured-clone
      // failure, an already-neutered port) must fail the run fast instead of
      // leaving the kernel to wait out its full timeout.
      try {
        worker.postMessage({ type: 'worker.init', init: msg.init }, [peer])
      } catch (err) {
        terminate(msg.key)
        reportError(msg.key, err instanceof Error ? err.message : String(err))
        return
      }
      // Ack the spawn so the kernel clears its spawn-ack deadline (a dead
      // control port never acks — that is the point).
      try {
        controlPort.postMessage({ type: 'worker.spawned', key: msg.key })
      } catch {
        /* control channel gone — the kernel's deadline handles it */
      }
      return
    }
  }

  controlPort.addEventListener('message', handler)
  controlPort.start()

  return {
    dispose: () => {
      controlPort.removeEventListener('message', handler)
      for (const key of [...workers.keys()]) terminate(key)
    },
  }
}
