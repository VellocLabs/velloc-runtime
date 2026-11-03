/**
 * Starts the realm's model egress masking (F-39): the first read of the
 * `modelMasking` section, and the log sink on the runtime's host port.
 *
 * Contract: idempotent per realm; returns false (and does nothing) until a
 * home directory and a host port exist, so the caller retries later.
 */
import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../../browser/bridge/protocol/core'
import { readUserLayer } from '../../settings/settingsStore'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { modelMasking, type ModelMaskingHolder } from './maskingHolder'
import type { MaskingLogSink } from './maskingLog'

export type MaskingBootHost = {
  homeDir: () => string | undefined
  transport: () => BrowserBridgeTransport | undefined
  requestId: () => string
  fs: () => RuntimeFs
}

const ENCODER = new TextEncoder()

/** Appends through the host's `fs.appendFile`; sizes and moves through `fs`. */
export function createMaskingLogSink(host: MaskingBootHost): MaskingLogSink {
  return {
    async append(path, text) {
      const transport = host.transport()
      if (!transport) throw new Error('The host is not connected.')
      const response = await transport.request({
        id: host.requestId(),
        route: createBridgeRoute('fs', 'appendFile'),
        payload: { path, data: ENCODER.encode(text) },
      })
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    },
    async size(path) {
      try {
        return (await host.fs().stat(path)).size
      } catch {
        return undefined
      }
    },
    async rename(from, to) {
      const fs = host.fs()
      if (!fs.rename) throw new Error('This host cannot rename files.')
      await fs.rename(from, to)
    },
    async remove(path) {
      await host.fs().rm(path, { force: true })
    },
  }
}

let started = false

export function startModelMasking(host: MaskingBootHost, holder: ModelMaskingHolder = modelMasking): boolean {
  if (started) return true
  const homeDir = host.homeDir()
  if (!homeDir || !host.transport()) return false
  started = true
  holder.setLogSink(createMaskingLogSink(host))
  void holder.load(async () => (await readUserLayer(homeDir, host.fs())).settings.modelMasking)
  return true
}

/** Test hook. */
export function resetModelMaskingBoot(): void {
  started = false
}
