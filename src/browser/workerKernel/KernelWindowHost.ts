/**
 * Security: the window's one install of the sandboxed worker host, listing every
 * kind the kernel can spawn:
 *   runjs   one worker per SuperEdit / SuperShell call (`runJs/runJs.worker`)
 *   mod     one long-lived worker per loaded hooks module (`mods/mod.worker`)
 * Each kind is bundled to one module handed in as text
 * (`virtual:isolated-worker-sources`) and spawned from a `data:` URL in a
 * sandboxed frame of its own, so each has its own policy: only run_js's carries
 * `'unsafe-eval'` (F-25). `installSandboxedWorkerHosts` demultiplexes the one
 * control port over the frames.
 */

import {
  modSpawnerFrameSrcdoc,
  modWorkerUrl,
  runJsWorkerUrl,
  spawnerFrameSrcdoc,
} from 'virtual:isolated-worker-sources'
import { MOD_WORKER_KIND } from '../../mods/modTypes'
import { RUN_JS_WORKER_KIND } from '../runJs/runJsProtocol'
import {
  installSandboxedWorkerHosts,
  type SandboxedWorkerHostHandle,
  type SandboxedWorkerHostOptions,
} from './SandboxedWorkerHost'

export type KernelWindowHostHandle = SandboxedWorkerHostHandle

/**
 * Install the host on the window's end of the control channel. Boot calls this
 * once; the returned handle is kept for the page's lifetime.
 *
 * `seams` is for tests (a fake document / window).
 */
export function installKernelWindowHost(
  controlPort: MessagePort,
  seams: Pick<SandboxedWorkerHostOptions, 'document' | 'window' | 'readyTimeoutMs'> = {},
): KernelWindowHostHandle {
  return installSandboxedWorkerHosts(controlPort, {
    frames: [
      { srcdoc: spawnerFrameSrcdoc, workerUrls: { [RUN_JS_WORKER_KIND]: runJsWorkerUrl } },
      { srcdoc: modSpawnerFrameSrcdoc, workerUrls: { [MOD_WORKER_KIND]: modWorkerUrl } },
    ],
    ...seams,
  })
}
