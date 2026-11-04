/**
 * Contract: starts the realm's model egress masking (F-39): the first read of
 * the `modelMasking` section, and the log sink on the runtime's host port.
 * Idempotent per realm; returns false (and does nothing) until a
 * home directory and a host port exist, so the caller retries later. A
 * settings file that exists but cannot be read, parsed or understood leaves
 * masking `unknown` (requests refused) and is read again from disk, never
 * from a cache. `settleWithoutSettings` is only for a host that reports no
 * home directory at all: there is no settings file, so masking is off.
 */
import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../../browser/bridge/protocol/core'
import { readLayerFresh } from '../../settings/settingsStore'
import { resolveProviderUserAgent } from '../../config/providerUserAgent'
import { runtimeProviderConfigs } from '../drivers/runtimeProviders'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { MaskingHostError, modelMasking, type ModelMaskingHolder } from './maskingHolder'
import type { MaskingLogSink } from './maskingLog'

export type MaskingBootHost = {
  homeDir: () => string | undefined
  transport: () => BrowserBridgeTransport | undefined
  requestId: () => string
  fs: () => RuntimeFs
}

const ENCODER = new TextEncoder()

/** Appends through the host's `fs.appendFile`; sizes, reads and rewrites through `fs`. */
export function createMaskingLogSink(host: MaskingBootHost): MaskingLogSink {
  return {
    async append(path, text) {
      const transport = host.transport()
      if (!transport) throw new MaskingHostError('hostDisconnected')
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
    async read(path) {
      try {
        return await host.fs().readFile(path, { encoding: 'utf8' })
      } catch {
        return undefined
      }
    },
    async write(path, text) {
      await host.fs().writeFile(path, text, { encoding: 'utf8' })
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
  holder.setPresetUserAgentResolver(providerId => resolveProviderUserAgent(providerId, runtimeProviderConfigs()[providerId]))
  void holder.load(async () => {
    const result = await readLayerFresh('userSettings', { homeDir }, host.fs())
    return result.unread ? 'unreadable' : result.settings.modelMasking
  })
  return true
}

/** A host with no home directory, so no settings file: masking is off (it cannot be on). */
export function settleWithoutSettings(holder: ModelMaskingHolder = modelMasking): void {
  if (started) return
  if (holder.status().state === 'unknown') holder.configure(undefined)
}

/** Test hook. */
export function resetModelMaskingBoot(): void {
  started = false
}
