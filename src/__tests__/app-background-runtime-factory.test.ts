/**
 * The realm's runtime factory carries a background module's sinks to the runtime (F-40).
 */
import { describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  instanceOptions: undefined as Record<string, unknown> | undefined,
  folder: { reload: async () => {}, relist: async () => {}, dispose: () => {} },
}))

vi.mock('../mods/app/AppBackgroundRuntime', async importOriginal => {
  const actual = await importOriginal<typeof import('../mods/app/AppBackgroundRuntime')>()
  return {
    ...actual,
    AppBackgroundRuntime: class {
      constructor(options: Record<string, unknown>) {
        captured.options = options
      }
    },
  }
})

vi.mock('../mods/app/appProviderCalls', async importOriginal => {
  const actual = await importOriginal<typeof import('../mods/app/appProviderCalls')>()
  return { ...actual, createReloadFolder: () => captured.folder }
})

vi.mock('../mods/provider/providerInstanceCallsRuntime', () => ({
  createRuntimeInstanceCalls: (options: Record<string, unknown>) => {
    captured.instanceOptions = options
    return {}
  },
}))

import { createAppBackgroundRuntime } from '../mods/app/appBackgroundRuntimeFactory'

describe('the app background runtime factory', () => {
  it('forwards the reseed sink a background module calls', () => {
    const reseed = vi.fn(async () => {})
    createAppBackgroundRuntime({ homeDir: 'C:/home', fs: {} as never, transport: () => null, report: () => {}, reseed })
    expect(captured.options?.reseed).toBe(reseed)
  })

  it('relists after an instance change through the folder entry that opens no window, and the app reloads through the folded one', () => {
    createAppBackgroundRuntime({ homeDir: 'C:/home', fs: {} as never, transport: () => null, report: () => {} })
    expect(captured.instanceOptions?.relist).toBe(captured.folder.relist)
    expect((captured.options?.providerCalls as { reload?: unknown } | undefined)?.reload).toBe(captured.folder.reload)
  })
})
