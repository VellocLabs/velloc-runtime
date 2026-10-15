/**
 * `AppUpdateHost` over the runtime's own host port (F-30). Every call
 * resolves the current transport, so a replaced port does not strand the
 * long-lived service. Bytes are pulled with `network.streamRead` (the pulls
 * are the backpressure) and appended chunk by chunk; nothing marks the file
 * as downloaded from the internet.
 */
import type { BrowserHostManifest } from '../browser/bridge/protocol/manifest'
import type { BrowserBridgeTransport } from '../browser/bridge/protocol/core'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import { createNativePrimitives, type NativePrimitives } from '../browser/bridge/nativePrimitives'
import { createBrowserFsOperations } from '../utils/BrowserFsOperations'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { AppUpdateHost } from './AppUpdateService'
import { joinPath } from './AppUpdateService'

export type BridgeAppUpdateHostDeps = {
  transport: () => BrowserBridgeTransport | null
  manifest: () => Pick<BrowserHostManifest, 'capabilities' | 'primitives'> | null
  createRequestId: () => string
}

/** Primitives the service cannot run without. */
export const APP_UPDATE_PRIMITIVES = [
  'fs.paths',
  'network.streamOpen',
  'shell.spawn.persist',
  'shell.persistentList',
] as const

const READ_WAIT_MS = 30_000
const READ_MAX_BYTES = 4 * 1024 * 1024
const DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024

export function createBridgeAppUpdateHost(deps: BridgeAppUpdateHostDeps): AppUpdateHost {
  const transport = (): BrowserBridgeTransport => {
    const current = deps.transport()
    if (!current) throw new Error('the host port is not attached')
    return current
  }
  const primitives = (): NativePrimitives =>
    createNativePrimitives({
      transport: transport(),
      createRequestId: deps.createRequestId,
      manifest: deps.manifest() ?? undefined,
    })
  // One fs per port; paths here are absolute, so its cwd never matters.
  const fsByPort = new WeakMap<BrowserBridgeTransport, RuntimeFs>()
  const fs = (): RuntimeFs => {
    const port = transport()
    let ops = fsByPort.get(port)
    if (!ops) {
      ops = createBrowserFsOperations({ transport: port, createRequestId: deps.createRequestId, initialCwd: '.' })
      fsByPort.set(port, ops)
    }
    return ops
  }

  async function request<T>(capability: string, action: string, payload: unknown): Promise<T> {
    const response = (await transport().request({
      id: deps.createRequestId(),
      route: createBridgeRoute(capability as never, action as never),
      payload: payload as never,
    })) as { ok: true; result: T } | { ok: false; error: { code: string; message: string } }
    if (!response.ok) throw new Error(`${capability}.${action}: ${response.error.code}: ${response.error.message}`)
    return response.result
  }

  /** Open a GET and hand each chunk to `sink` until the body ends. */
  async function pull(url: string, maxBytes: number, sink: (chunk: Uint8Array) => Promise<void>): Promise<number> {
    const network = primitives().network
    const head = await network.streamOpen({ url, method: 'GET', body: new Uint8Array(0), maxResponseBytes: maxBytes })
    if (head.status !== 200) {
      await network.streamCancel(head.streamId).catch(() => undefined)
      return head.status
    }
    try {
      for (;;) {
        const read = await network.streamRead(head.streamId, { waitMs: READ_WAIT_MS, maxBytes: READ_MAX_BYTES })
        if (read.chunk?.byteLength) await sink(read.chunk)
        if (read.errorCode) throw new Error(`download failed: ${read.errorCode}${read.errorMessage ? ` ${read.errorMessage}` : ''}`)
        if (read.done) return head.status
      }
    } catch (error) {
      await network.streamCancel(head.streamId).catch(() => undefined)
      throw error
    }
  }

  return {
    async currentVersion() {
      const info = await request<{ appVersion?: string }>('appInfo', 'getVersionInfo', {})
      if (!info.appVersion) throw new Error('the host reported no version')
      return info.appVersion
    },
    async updateRoot() {
      const { cache } = await primitives().fs.paths()
      if (!cache) throw new Error('the host has no local cache directory')
      return joinPath(joinPath(cache, 'Velloc'), 'Update')
    },
    async fetchText(url, maxBytes) {
      const parts: Uint8Array[] = []
      const status = await pull(url, maxBytes, async chunk => {
        parts.push(chunk)
      })
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
      let offset = 0
      for (const part of parts) {
        bytes.set(part, offset)
        offset += part.byteLength
      }
      return { status, text: new TextDecoder().decode(bytes) }
    },
    async download(url, path) {
      await fs().rm(path, { force: true })
      // Each append is awaited: the host runs unsequenced appends in any order.
      const status = await pull(url, DOWNLOAD_MAX_BYTES, chunk =>
        request('fs', 'appendFile', { path, data: chunk }).then(() => undefined),
      )
      if (status !== 200) throw new Error(`package request answered ${status}`)
    },
    async mkdir(path) {
      await fs().mkdir(path)
    },
    async remove(path) {
      await fs().rm(path, { force: true })
    },
    async rename(from, to) {
      const rename = fs().rename
      if (!rename) throw new Error('the host cannot rename files')
      await rename(from, to)
    },
    async readText(path) {
      try {
        return await fs().readFile(path, { encoding: 'utf8' })
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return null
        throw error
      }
    },
    async writeText(path, text) {
      await fs().writeFile(path, text)
    },
    async startInstall(script, logPath) {
      const { persistentId } = await primitives().shell.spawnPersistent({
        shell: 'powershell',
        command: script,
        logPath,
        closeStdin: true,
      })
      return persistentId
    },
    async installRunning(id) {
      const record = (await primitives().shell.persistentList()).find(each => each.id === id)
      return record ? record.running : null
    },
    async relaunch() {
      await request('appInfo', 'relaunch', {})
    },
  }
}
