import { describe, it, expect } from 'vitest'
import {
  buildGlicInitPayload,
  DEFAULT_NEXUS_RUNTIME_CWD,
  DEFAULT_NEXUS_SESSION_STORAGE_PATH,
  resolveWorkerTraceFlags,
  shouldEnableModelUploadTrace,
} from '../browser/boot/nexusBoot'

// `buildGlicInitPayload` is the only piece of `nexusBoot.ts` that is
// safe to unit-test in isolation — the surrounding `prepareNexusBoot` /
// `nexusBootAndRender` paths run real postMessage handshakes and React
// imports, so they're better covered by e2e tests. The earlier
// `glic-integration.test.ts` covered `PostMessageBridgeTransport`,
// `GlicWebClientAdapter`, and `performGlicBootstrap`, all of which were
// retired with the JS-side `glic` capability — only this small payload
// builder test remains.
describe('buildGlicInitPayload', () => {
  it('defaults Nexus mode to relative storage paths', () => {
    const payload = buildGlicInitPayload({})

    expect(payload.cwd).toBe(DEFAULT_NEXUS_RUNTIME_CWD)
    expect(payload.sessionStoragePath).toBe(
      DEFAULT_NEXUS_SESSION_STORAGE_PATH,
    )
    expect(payload.hostMode).toBe('nexus')
    expect(payload.toolPreset).toBe('nexus')
    // No projectRoot by default → createBrowserRuntime applies the shared
    // `${cwd}/.velloc/workspace/` sandbox (agent/chat behaviour).
    expect(payload.projectRoot).toBeUndefined()
  })

  it('preserves explicit cwd and session storage overrides', () => {
    const payload = buildGlicInitPayload({
      initPayload: {
        cwd: '/custom-cwd',
        projectRoot: '/custom-project',
        sessionStoragePath: '/custom-sessions',
        sessionId: 'session-123',
        toolPreset: 'glic',
      },
    })

    expect(payload.cwd).toBe('/custom-cwd')
    expect(payload.projectRoot).toBe('/custom-project')
    expect(payload.sessionStoragePath).toBe('/custom-sessions')
    expect(payload.sessionId).toBe('session-123')
    expect(payload.toolPreset).toBe('glic')
  })

  // Anchor for `code` sessions: the host binds a real project folder per
  // session. buildGlicInitPayload must carry `projectRoot`
  // through so createBrowserRuntime anchors cwd === projectRoot to the
  // real directory instead of the shared `${cwd}/.velloc/workspace/`
  // sandbox. Without the pass-through this value is silently dropped and
  // every session — including `code` — falls back to the sandbox.
  it('threads a per-session projectRoot override through the payload', () => {
    const withRoot = buildGlicInitPayload({
      initPayload: {projectRoot: '/home/peijun/projects/foo'},
    })
    expect(withRoot.projectRoot).toBe('/home/peijun/projects/foo')

    // Absent → undefined so createBrowserRuntime applies the sandbox default.
    expect(buildGlicInitPayload({}).projectRoot).toBeUndefined()
  })
})

// The debug system is opt-in everywhere, including dev builds: without an explicit URL flag no model payloads are
// retained and no span rings collect (`?trace=1` / `?log=1` / `/debug trace on`). The boot path pushes the guest's
// build time to the boot-welcome overlay via `ui.buildInfo`, skipped when the build time is absent.

// The guest reports real boot milestones to the boot-welcome overlay via `ui.bootProgress` (`rendering`,
// `sessions`, `opening`, `finalizing`), additive and ignore-if-absent like `buildInfo`.

describe('shouldEnableModelUploadTrace', () => {
  it('is FALSE with no explicit opt-in, even in DEV builds', () => {
    expect(import.meta.env.DEV).toBe(true) // guard: the premise of this pin
    expect(shouldEnableModelUploadTrace()).toBe(false)
  })
})

// The about-page "Verbose logging" (agent.log) and "Trace overlay" (agent.trace)
// toggles must take effect in the WORKER realm in RELEASE, not just the
// page-side bus/overlay. resolveWorkerTraceFlags ORs the persisted settings into
// the URL-derived worker trace gates.
describe('resolveWorkerTraceFlags', () => {
  const noUrl = {} as { logCallModel?: boolean; traceModelRequests?: boolean }
  const off = { log: false, trace: false }

  it('leaves both gates off when nothing asks for them (default release user)', () => {
    expect(
      resolveWorkerTraceFlags(noUrl, off, { enableBus: false }),
    ).toEqual({ logCallModel: false, traceModelRequests: false })
  })

  it('"Verbose logging" (agent.log) enables BOTH the console trace and payload capture', () => {
    // enableBus is true whenever log OR trace is set (see combineTracerSignals).
    expect(
      resolveWorkerTraceFlags(noUrl, { log: true, trace: false }, { enableBus: true }),
    ).toEqual({ logCallModel: true, traceModelRequests: true })
  })

  it('"Trace overlay" (agent.trace) enables payload capture but NOT the noisy console trace', () => {
    expect(
      resolveWorkerTraceFlags(noUrl, { log: false, trace: true }, { enableBus: true }),
    ).toEqual({ logCallModel: false, traceModelRequests: true })
  })

  it('URL params still win on their own (dev opt-in), ORed with settings', () => {
    expect(
      resolveWorkerTraceFlags(
        { logCallModel: true, traceModelRequests: true },
        off,
        { enableBus: false },
      ),
    ).toEqual({ logCallModel: true, traceModelRequests: true })
  })
})
