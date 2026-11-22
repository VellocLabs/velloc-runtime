/**
 * The realm's runtime factory carries a background module's sinks to the runtime (F-40).
 */
import { describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }))

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

import { createAppBackgroundRuntime } from '../mods/app/appBackgroundRuntimeFactory'

describe('the app background runtime factory', () => {
  it('forwards the reseed sink a background module calls', () => {
    const reseed = vi.fn(async () => {})
    createAppBackgroundRuntime({ homeDir: 'C:/home', fs: {} as never, transport: () => null, report: () => {}, reseed })
    expect(captured.options?.reseed).toBe(reseed)
  })
})
