/**
 * The bridge's native / worker split (`protocol/core.ts`) matches what each side serves: native = C++, declared
 * under `src/custom_browser/browser/nexus/api/declarations/<dir>/` (P-3); worker = the SharedWorker's JS adapters.
 * The declaration-directory check is skipped without the sibling C++ checkout.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  NATIVE_CAPABILITIES,
  NATIVE_CAPABILITY_DECLARATION_DIRS,
  WORKER_CAPABILITIES,
  type BrowserBridgeCapability,
  type NativeCapability,
  type WorkerCapability,
} from '../browser/bridge/protocol/core'
import { NEXUS_DIRECT_BRIDGE_CAPABILITIES } from '../browser/bridge/directBridgeCapabilities'
import { LEGACY_WEBUI_CAPABILITIES } from '../browser/runtimeHub/legacyWebUiCapabilities'

const sorted = (values: Iterable<string>): string[] => [...values].sort()

function findDeclarationsDir(): string | null {
  // One level up from the main checkout, four from a worktree — walk.
  let dir = join(__dirname, '..', '..')
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(
      dir, 'src', 'custom_browser', 'browser', 'nexus', 'api', 'declarations',
    )
    if (existsSync(candidate)) return candidate
    dir = join(dir, '..')
  }
  return null
}

describe('NativeCapabilityMap / WorkerCapabilityMap', () => {
  it('the two halves are disjoint and together make the whole map (type level)', () => {
    expectTypeOf<Extract<NativeCapability, WorkerCapability>>().toEqualTypeOf<never>()
    expectTypeOf<NativeCapability | WorkerCapability>().toEqualTypeOf<BrowserBridgeCapability>()
    expectTypeOf<(typeof NATIVE_CAPABILITIES)[number]>().toEqualTypeOf<NativeCapability>()
    expectTypeOf<(typeof WORKER_CAPABILITIES)[number]>().toEqualTypeOf<WorkerCapability>()
  })

  it('the exported lists are disjoint at runtime too', () => {
    const native = new Set<string>(NATIVE_CAPABILITIES)
    expect(WORKER_CAPABILITIES.filter(c => native.has(c))).toEqual([])
  })

  it('every native capability is routed over the direct C++ port, and nothing else is', () => {
    // NEXUS_DIRECT_BRIDGE_CAPABILITIES mirrors the guest port's
    // RegisterCapability(...) list. Native == that list exactly.
    expect(sorted(NATIVE_CAPABILITIES)).toEqual(sorted(NEXUS_DIRECT_BRIDGE_CAPABILITIES))
  })

  it('the worker half is exactly what the SharedWorker adapters serve', () => {
    // LEGACY_WEBUI_CAPABILITIES is the hub's table of the worker's
    // registerWebUiBridgeHandler(...) capabilities.
    expect(sorted(WORKER_CAPABILITIES)).toEqual(sorted(Object.keys(LEGACY_WEBUI_CAPABILITIES)))
  })

  it('native capabilities map one-to-one onto the C++ api/declarations/ directories', () => {
    const declarationsDir = findDeclarationsDir()
    if (!declarationsDir) {
      console.warn('[native-capability-map] no sibling src/custom_browser checkout — skipped')
      return
    }
    const onDisk = readdirSync(declarationsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    const mapped = Object.values(NATIVE_CAPABILITY_DECLARATION_DIRS).filter(
      (dir): dir is string => dir !== null,
    )
    // No two capabilities claim one directory.
    expect(new Set(mapped).size).toBe(mapped.length)
    expect(sorted(mapped)).toEqual(sorted(onDisk))
  })
})
