/**
 * F-24: the runtime knows its build entry (hello.client.build, first-writer-wins in RuntimeHub;
 * `runtime.getBuildEntry`, observe), `manifestAssetBase` decides where an entry's chunks resolve, and the remote
 * boot adopts the runtime's update channel (`readRuntimeBuildEntry`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  RUNTIME_PROTOCOL_VERSION,
  type Frame,
  type HelloFrame,
} from '../browser/runtimeProtocol'
import {
  createMessagePortTransport,
  type FrameTransport,
} from '../browser/runtimeTransport'
import { buildKeyFromBuildTime } from '../branding/buildInfo'
import {
  adoptRuntimeChannel,
  currentTemplateChannel,
  runtimeSharedWorkerName,
} from '../branding/updateChannels'
import { readRuntimeBuildEntry } from '../browser/boot/remoteBoot'
import { connectRuntime, type RuntimeConnection } from '../browser/runtimeClient'
import { buildEntryUrl } from '../browser/runtimeHub/buildEntry'
import { manifestAssetBase } from '../glic/manifestAssetBase'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { ConnectionHub } from '../browser/runtimeHub/ConnectionHub'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import {
  installSessionSurface,
  type RuntimeContext,
  type SessionSurfaceHost,
} from '../browser/runtimeHub'
import { hiddenSessionIds, isSessionTypeOffered } from '../browser/webview/sessionVisibility'
import type { WebUiBridgeContext } from '../browser/worker/webUiBridge'
import { getLauncherCatalog } from '../prompting/templateRegistry'

// ---- buildEntryUrl (pure) ----------------------------------------------------

describe('buildEntryUrl', () => {
  const iso = '2026-09-17T10:30:00.000Z'
  const key = buildKeyFromBuildTime(iso)

  it('derives the entry from a production worker asset URL', () => {
    expect(buildEntryUrl('https://beta.velloc.app/v3/assets/worker-abc.js', iso))
      .toBe(`https://beta.velloc.app/v3/b/${key}/`)
  })

  it('returns null on a dev server (no /v<N>/ path)', () => {
    expect(buildEntryUrl('http://localhost:5173/src/browser/worker/agentRuntime.sharedworker.ts', iso))
      .toBeNull()
  })

  it('returns null for an unknown or invalid build stamp', () => {
    expect(buildEntryUrl('https://beta.velloc.app/v3/assets/worker-abc.js', null)).toBeNull()
    expect(buildEntryUrl('https://beta.velloc.app/v3/assets/worker-abc.js', '')).toBeNull()
    expect(buildEntryUrl('https://beta.velloc.app/v3/assets/worker-abc.js', 'garbage')).toBeNull()
  })

  it('returns null for an unparseable worker href', () => {
    expect(buildEntryUrl('not a url', iso)).toBeNull()
  })
})

// ---- hub records bootBuild first-writer-wins ----------------------------------
//
// RuntimeHub.noteHelloBuild is private and fired by ConnectionHub's onHelloBuild
// hook, so this drives REAL hello frames through a ConnectionHub (loopback, as
// runtime-hub.test.ts does) and asserts the value the hook records. The hook
// under test is the predicate RuntimeHub.noteHelloBuild implements — replicated
// here the way RuntimeHub wires it.

function makeContext(): RuntimeContext {
  const webUiBridge: WebUiBridgeContext = {
    homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null,
  }
  return {
    fs: {} as RuntimeFs, host: null, homeDir: '/h',
    publish: () => 0, connections: () => [], webUiBridge,
  }
}

function makeRig() {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const context = makeContext()
  let recorded: string | null = null
  // Mirrors RuntimeHub.noteHelloBuild's gate exactly.
  const onHelloBuild = (hello: HelloFrame) => {
    if (recorded !== null) return
    if (hello.auth.mode !== 'local') return
    if (hello.client.kind !== 'desktop-shell') return
    if (!hello.client.build || !buildKeyFromBuildTime(hello.client.build)) return
    recorded = hello.client.build
  }
  const hub = new ConnectionHub({
    registry, broker, context, runtimeVersion: 't', bootstrap: () => undefined, onHelloBuild,
  })
  return { hub, getBuild: () => recorded }
}

function driveHello(hub: ConnectionHub, client: { kind: string; build?: string }, authMode: 'local' | 'pair' = 'local'): Promise<Frame> {
  const channel = new MessageChannel()
  hub.attach(createMessagePortTransport(channel.port1))
  const transport: FrameTransport = createMessagePortTransport(channel.port2)
  const done = new Promise<Frame>(resolve => {
    const off = transport.onFrame(f => {
      if (f.kind === 'welcome' || f.kind === 'bye') { off(); resolve(f) }
    })
  })
  const hello: HelloFrame = {
    kind: 'hello',
    v: RUNTIME_PROTOCOL_VERSION,
    client: { clientId: 'c', kind: client.kind as never, ...(client.build ? { build: client.build } : {}) },
    auth: authMode === 'local' ? { mode: 'local' } : { mode: 'pair', pairId: 'p' },
  } as HelloFrame
  transport.send(hello)
  return done
}

const ISO_A = '2026-09-17T10:30:00.000Z'
const ISO_B = '2026-09-18T11:31:00.000Z'

// ---- manifestAssetBase (pure) -------------------------------------------------

describe('manifestAssetBase', () => {
  const key = '20260917T103000000Z'

  it("resolves an entry manifest's chunks at the version root, not inside the entry", () => {
    const manifestUrl = `https://beta.velloc.app/v1/b/${key}/assets-manifest.json`
    // What the warmer did before: `stageBuildEntry` copies the manifest into
    // the entry but no chunks, so every one of the ~230 URLs 404s -- on the
    // deploy itself and through the desktop's reverse proxy alike.
    expect(new URL('assets/index-abc.js', manifestUrl).href)
      .toBe(`https://beta.velloc.app/v1/b/${key}/assets/index-abc.js`)
    // What it does now.
    expect(new URL('assets/index-abc.js', manifestAssetBase(manifestUrl)).href)
      .toBe('https://beta.velloc.app/v1/assets/index-abc.js')
    expect(manifestAssetBase(manifestUrl))
      .toBe('https://beta.velloc.app/v1/assets-manifest.json')
  })

  it('rewrites the path only, so the reverse-proxy origin is preserved', () => {
    // A remote client reads the manifest through the desktop's listener (F-24),
    // whose origin is plain http on a LAN address and a port.
    const manifestUrl = `http://192.168.1.10:47615/v1/b/${key}/assets-manifest.json`
    expect(new URL('assets/locales/en-abc.json', manifestAssetBase(manifestUrl)).href)
      .toBe('http://192.168.1.10:47615/v1/assets/locales/en-abc.json')
  })

  it('leaves a version-root manifest alone', () => {
    const manifestUrl = 'https://beta.velloc.app/v1/assets-manifest.json'
    expect(manifestAssetBase(manifestUrl)).toBe(manifestUrl)
    expect(new URL('assets/index-abc.js', manifestAssetBase(manifestUrl)).href)
      .toBe('https://beta.velloc.app/v1/assets/index-abc.js')
    expect(manifestAssetBase('https://beta.velloc.app/v12/assets-manifest.json'))
      .toBe('https://beta.velloc.app/v12/assets-manifest.json')
  })

  it('leaves anything that is not a build entry alone', () => {
    for (const url of [
      // A dev server: no version path, no manifest either.
      'http://localhost:5173/assets-manifest.json',
      // A self-hosted prefix pushes the version deeper -- deliberately
      // unsupported, exactly as buildEntryUrl treats it.
      `https://example.test/app/v1/b/${key}/assets-manifest.json`,
      // `b/<seg>/` has to sit directly under the version segment.
      'https://beta.velloc.app/v1/assets/b/x/assets-manifest.json',
      // Not a URL at all: returned unchanged rather than thrown.
      'not a url',
      '',
    ]) {
      expect(manifestAssetBase(url)).toBe(url)
    }
  })
})

describe('hub records the boot build (first-writer-wins)', () => {
  it('records the first local desktop-shell build', async () => {
    const { hub, getBuild } = makeRig()
    await driveHello(hub, { kind: 'desktop-shell', build: ISO_A })
    expect(getBuild()).toBe(ISO_A)
  })

  it('does not overwrite when a second window reports a different build', async () => {
    // The HTML cache updated between the two windows opening: the second page
    // is build B, the already-running worker is build A. A stays.
    const { hub, getBuild } = makeRig()
    await driveHello(hub, { kind: 'desktop-shell', build: ISO_A })
    await driveHello(hub, { kind: 'desktop-shell', build: ISO_B })
    expect(getBuild()).toBe(ISO_A)
  })

  it('ignores a non-desktop-shell kind, a build that is not a valid key, and a missing build', async () => {
    const { hub, getBuild } = makeRig()
    await driveHello(hub, { kind: 'panel-host', build: ISO_A })
    await driveHello(hub, { kind: 'desktop-shell', build: 'garbage' })
    await driveHello(hub, { kind: 'desktop-shell' })
    expect(getBuild()).toBeNull()
    // …and a later legitimate one still wins (nothing recorded yet).
    await driveHello(hub, { kind: 'desktop-shell', build: ISO_B })
    expect(getBuild()).toBe(ISO_B)
  })

  it('a pair-mode hello is rejected before it can record a build', async () => {
    // The auth gate runs before the hook: a remote `pair` hello never reaches
    // onHelloBuild (it is answered unauthorized off the pairing table).
    const { hub, getBuild } = makeRig()
    const res = await driveHello(hub, { kind: 'browser', build: ISO_A }, 'pair')
    expect(res.kind).toBe('bye')
    expect(getBuild()).toBeNull()
  })
})

// ---- the channel: a remote page takes its runtime's ---------------------------
// A relay-served remote page names no channel; it must adopt the runtime's, or a beta runtime's team sessions are
// hidden. Drives the real hub and session surface into the remote boot's reader.

describe('runtime.getBuildEntry names the channel; the remote boot adopts it', () => {
  const RELAY_PAGE = {
    origin: 'http://192.168.1.10:47615',
    search: '',
    href: 'http://192.168.1.10:47615/',
  }
  const lead = { sessionId: 'lead', templateType: 'team' }
  const mate = { sessionId: 'mate', templateType: 'code', spawnerSessionId: 'lead' }

  afterEach(() => {
    adoptRuntimeChannel(null)
    vi.unstubAllGlobals()
  })

  /** A runtime with the session surface installed (it serves `runtime.*`), or
   *  — `surface: false` — one that predates the action entirely. */
  function makeRuntime(surface = true): ConnectionHub {
    const registry = new CapabilityRegistry()
    const broker = new TopicBroker()
    // getBuildEntry never touches the manager, and nothing else is driven here.
    if (surface) installSessionSurface({ registry, broker, bootBuild: ISO_A }, {} as SessionSurfaceHost)
    return new ConnectionHub({
      registry, broker, context: makeContext(), runtimeVersion: 't', bootstrap: () => undefined,
    })
  }

  /** The least a remote can hold: `observe`. */
  function connectObserve(hub: ConnectionHub): Promise<RuntimeConnection> {
    const channel = new MessageChannel()
    hub.attach(createMessagePortTransport(channel.port1))
    return connectRuntime({
      transport: createMessagePortTransport(channel.port2),
      client: { clientId: 'remote', kind: 'desktop-shell' },
      scopeCeiling: 'observe',
    })
  }

  /** Run the remote boot's read with the RUNTIME's realm in place — the
   *  SharedWorker a `?channel=beta` desktop page named (`null`: the plain
   *  worker). One process holds both realms, so the page's own globals are put
   *  back before anything is asserted about the page. */
  async function readAsRuntimeOn(connection: RuntimeConnection, channel: 'beta' | null) {
    vi.stubGlobal('location', undefined)
    vi.stubGlobal('name', channel ? runtimeSharedWorkerName(channel) : undefined)
    try {
      return await readRuntimeBuildEntry(connection)
    } finally {
      vi.stubGlobal('location', RELAY_PAGE)
      vi.stubGlobal('name', undefined)
    }
  }

  it('a beta runtime makes the remote page beta — the Team launcher, and team sessions shown', async () => {
    vi.stubGlobal('location', RELAY_PAGE)
    // The page on its own: the relay origin names no channel → stable.
    expect(currentTemplateChannel()).toBe('stable')
    expect(isSessionTypeOffered('team')).toBe(false)
    expect([...hiddenSessionIds([lead, mate])].sort()).toEqual(['lead', 'mate'])

    const connection = await connectObserve(makeRuntime())
    const entry = await readAsRuntimeOn(connection, 'beta')
    expect(entry).toMatchObject({ build: ISO_A, channel: 'beta' })

    // The page now agrees with the runtime its sessions run in.
    expect(currentTemplateChannel()).toBe('beta')
    expect(getLauncherCatalog().map(meta => meta.type)).toContain('team')
    expect(isSessionTypeOffered('team')).toBe(true)
    expect(hiddenSessionIds([lead, mate]).size).toBe(0)
    connection.close()
  })

  it('a stable runtime keeps the remote page stable', async () => {
    const connection = await connectObserve(makeRuntime())
    const entry = await readAsRuntimeOn(connection, null)
    expect(entry?.channel).toBe('stable')
    expect(currentTemplateChannel()).toBe('stable')
    expect(getLauncherCatalog().map(meta => meta.type)).not.toContain('team')
    connection.close()
  })

  it('a runtime without the action leaves the page on its own resolution, clearing an earlier adoption', async () => {
    // A retried boot against a different (older) runtime must not keep the
    // channel the previous one reported.
    adoptRuntimeChannel('beta')
    const connection = await connectObserve(makeRuntime(false))
    expect(await readAsRuntimeOn(connection, 'beta')).toBeNull()
    expect(currentTemplateChannel()).toBe('stable')
    connection.close()
  })
})
