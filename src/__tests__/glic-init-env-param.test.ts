import { afterEach, describe, expect, it } from 'vitest'
import {
  buildGlicInitPayload,
  readRuntimeScopeCeilingFromUrl,
} from '../browser/boot/nexusBoot'
import { SCOPE_MODES } from '../browser/runtimeProtocol/frames'

// Production glic has no OS env — RuntimeConfig reads only the injected
// `env` record. URL query params are the toggle channel, read into
// `env` by buildGlicInitPayload. These tests pin that wiring so a future
// refactor can't silently break the allow-listed env params (`?e2eTrace=1`
// etc.). (The per-skill `defer<Skill>` params were removed — deferral is
// template-only now.)

const realLocation = globalThis.location

function setSearch(search: string | undefined): void {
  if (search === undefined) {
    delete (globalThis as { location?: unknown }).location
    return
  }
  Object.defineProperty(globalThis, 'location', {
    value: { search },
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  if (realLocation) {
    Object.defineProperty(globalThis, 'location', {
      value: realLocation,
      configurable: true,
      writable: true,
    })
  } else {
    setSearch(undefined)
  }
})

describe('buildGlicInitPayload — env from query params', () => {
  it('reads the allow-listed params from the glic URL into env', () => {
    setSearch('?e2eTrace=1&e2eEnableExtractMemories=0&e2eProviderMaxRetries=2')
    const payload = buildGlicInitPayload({})
    expect(payload.env?.e2eTrace).toBe('1')
    expect(payload.env?.e2eEnableExtractMemories).toBe('0')
    expect(payload.env?.e2eProviderMaxRetries).toBe('2')
  })

  it('leaves env empty when the params are absent', () => {
    setSearch('?cwd=/x')
    const payload = buildGlicInitPayload({})
    expect(payload.env?.e2eTrace).toBeUndefined()
    expect(payload.env?.promptOverrides).toBeUndefined()
  })

  it('ignores an empty param value', () => {
    setSearch('?e2eTrace=')
    const payload = buildGlicInitPayload({})
    expect(payload.env?.e2eTrace).toBeUndefined()
  })

  it('caller-provided initPayload.env overrides the URL param', () => {
    setSearch('?e2eTrace=1')
    const payload = buildGlicInitPayload({
      initPayload: { env: { e2eTrace: '0' } },
    })
    expect(payload.env?.e2eTrace).toBe('0')
  })
})

// `?rtScope=` is how NEXUS_E2E_SCOPE reaches the page's own runtime connection
// (`hello.scopeCeiling`). A mode the parser drops sends no ceiling, and the hub
// then grants the desktop's `full`: the scoped e2e run quietly becomes an
// unscoped one. That is how `manager` went ungated after the ladder learned it.
describe('readRuntimeScopeCeilingFromUrl', () => {
  it('reads every sub-full mode on the scope ladder', () => {
    const subFull = SCOPE_MODES.filter(mode => mode !== 'full')
    expect(subFull).toEqual(['observe', 'control', 'manager'])
    for (const mode of subFull) {
      setSearch(`?e2eTrace=1&rtScope=${mode}`)
      expect(readRuntimeScopeCeilingFromUrl()).toBe(mode)
    }
  })

  it('returns no ceiling for full, an unknown value, or no param', () => {
    for (const search of ['?rtScope=full', '?rtScope=admin', '?rtScope=', '?cwd=/x']) {
      setSearch(search)
      expect(readRuntimeScopeCeilingFromUrl()).toBeUndefined()
    }
    setSearch(undefined)
    expect(readRuntimeScopeCeilingFromUrl()).toBeUndefined()
  })
})
