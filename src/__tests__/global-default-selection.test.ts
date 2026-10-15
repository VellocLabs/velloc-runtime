/**
 * The global default selection (a new session's model + effort) is runtime state: `agent/setModel` writes
 * settings.json `agent.model`, each write is published as `agent.changed`, and every page mirrors it. The
 * two-page rig runs the real runtime path, each page wired as MultiSessionShell wires it.
 */
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { ConnectionHub } from '../browser/runtimeHub/ConnectionHub'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { registerLegacyWebUiCapabilities } from '../browser/runtimeHub/legacyWebUiCapabilities'
import type { RuntimeContext, TopicProvider } from '../browser/runtimeHub/types'
import { topic, type ScopeMode, type TopicId } from '../browser/runtimeProtocol'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import { connectRuntime, createSettingsBridgeOverConnection } from '../browser/runtimeClient'
import { handleAgentBridgeRequest } from '../browser/bridge/adapter/agentBridgeAdapter'
import type { BrowserBridgeRequest } from '../browser/bridge/protocol'
import type { BrowserLlmSelection } from '../browser/bridge/browserBridgeProtocol'
import {
  createGlobalDefaultMirror,
  followGlobalDefault,
  writeGlobalDefault,
} from '../browser/webview/globalDefaultSelection'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const HOME = '/home/test'
const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

function makeMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const fs: Partial<RuntimeFs> = {
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return content
    }),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    }),
    mkdir: vi.fn(async () => {}),
  }
  return { fs: fs as RuntimeFs, files }
}

/** Delta-only, like the hub's settings topics. */
const settingsProvider: TopicProvider = {
  matches: (id: TopicId) => id.startsWith('settings/'),
  authorize: () => true,
  // eslint-disable-next-line require-yield
  async *snapshot() {
    /* no baseline */
  },
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The runtime: the real `agent` adapter, published the way the registration
 *  site publishes it (`broadcastEvent` → `settings/agent`, type `changed`). */
function makeRuntime(initialSettings?: unknown) {
  wipeSettingsMemos()
  const { fs, files } = makeMemoryFs(
    initialSettings ? { [SETTINGS_PATH]: JSON.stringify(initialSettings) } : {},
  )
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  broker.registerProvider(settingsProvider)
  registerLegacyWebUiCapabilities(registry, {
    primeLegacyHandlers: () => {},
    getHandler: () =>
      (async (request: BrowserBridgeRequest) =>
        handleAgentBridgeRequest(request, {
          homeDir: HOME,
          fs,
          broadcastChanged: payload =>
            broker.publish(topic.settings('agent'), payload, { type: 'changed' }),
        })) as never,
  })
  const context: RuntimeContext = {
    fs,
    host: null,
    homeDir: HOME,
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: HOME, fs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'gd', bootstrap: () => undefined })
  return { hub, files }
}

/** One page (a desktop window, or a remote client at `scopeCeiling`), wired
 *  like MultiSessionShell: it mirrors the runtime's value and picks through it. */
async function openPage(runtime: ReturnType<typeof makeRuntime>, clientId: string, scopeCeiling?: ScopeMode) {
  const channel = new MessageChannel()
  runtime.hub.attach(createMessagePortTransport(channel.port1))
  const connection = await connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId, kind: 'desktop-shell' },
    ...(scopeCeiling ? { scopeCeiling } : {}),
  })
  const bridge = createSettingsBridgeOverConnection({ connection: async () => connection, onError: () => {} })
  const page = { current: undefined as BrowserLlmSelection | null | undefined }
  const mirror = createGlobalDefaultMirror(selection => {
    page.current = selection
  })
  const stop = followGlobalDefault(bridge, mirror)
  const pick = (selection: BrowserLlmSelection) =>
    mirror.pick(selection, () => writeGlobalDefault(bridge, selection))
  const close = () => {
    stop()
    bridge.dispose()
    connection.close()
  }
  return { page, pick, bridge, close }
}

const OLD = { providerId: 'anthropic', modelId: 'claude-old', thinkingTier: 'low' }
const NEW = { providerId: 'openai', modelId: 'gpt-new', thinkingTier: 'max' }

describe('global default selection — runtime-owned, mirrored by every page', () => {
  it('a topbar pick in one window updates the other window’s default', async () => {
    const runtime = makeRuntime({ version: 1, agent: { model: OLD } })
    const a = await openPage(runtime, 'window-a')
    const b = await openPage(runtime, 'window-b')
    await until(() => a.page.current !== undefined && b.page.current !== undefined, 'boot seeds')
    expect(b.page.current).toEqual(OLD)

    a.pick(NEW)
    // The picking page shows its pick at once (optimistic).
    expect(a.page.current).toEqual(NEW)
    // The OTHER page follows the runtime's published value — it no longer
    // keeps the one it read at boot.
    await until(() => b.page.current?.modelId === NEW.modelId, 'window B to mirror the pick')
    expect(b.page.current).toEqual(NEW)
    expect(a.page.current).toEqual(NEW)
    expect(JSON.parse(runtime.files.get(SETTINGS_PATH)!).agent.model).toEqual(NEW)

    // And back the other way: B's pick reaches A.
    b.pick(OLD)
    await until(() => a.page.current?.modelId === OLD.modelId, 'window A to mirror B’s pick')
    a.close()
    b.close()
  })

  it('a remote control client picks, and an observe client hears it but may not write', async () => {
    const runtime = makeRuntime()
    const desktop = await openPage(runtime, 'desktop')
    const remote = await openPage(runtime, 'remote', 'control')
    const viewer = await openPage(runtime, 'viewer', 'observe')
    await until(() => desktop.page.current === null && viewer.page.current === null, 'boot seeds (none saved)')

    remote.pick(NEW)
    await until(
      () => desktop.page.current?.modelId === NEW.modelId && viewer.page.current?.modelId === NEW.modelId,
      'desktop and viewer to mirror the remote pick',
    )

    // `agent.setModel` is `control`: the observe client's write is refused,
    // and its optimistic pick falls back to what the runtime last published.
    await expect(writeGlobalDefault(viewer.bridge, OLD)).rejects.toThrow(/forbidden_scope/)
    viewer.pick(OLD)
    await until(() => viewer.page.current?.modelId === NEW.modelId, 'refused pick to fall back')
    expect(JSON.parse(runtime.files.get(SETTINGS_PATH)!).agent.model).toEqual(NEW)
    desktop.close()
    remote.close()
    viewer.close()
  })
})

describe('createGlobalDefaultMirror — ordering', () => {
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
  const X = { providerId: 'p', modelId: 'x' }
  const Y = { providerId: 'p', modelId: 'y' }
  const Z = { providerId: 'p', modelId: 'z' }

  it('holds the echoes of its own in-flight picks — picking X then Y never flashes back to X', async () => {
    const applied: Array<string | null> = []
    const mirror = createGlobalDefaultMirror(s => applied.push(s?.modelId ?? null))
    const wx = deferred()
    const wy = deferred()
    mirror.pick(X, () => wx.promise)
    mirror.pick(Y, () => wy.promise)
    mirror.receive(X) // X's echo lands while Y is still being written
    wx.resolve()
    await Promise.resolve()
    mirror.receive(Y)
    wy.resolve()
    await wy.promise
    await Promise.resolve()
    expect(applied).toEqual(['x', 'y', 'y'])
  })

  it('a change another client published during the flight wins once the flight settles', async () => {
    const applied: Array<string | null> = []
    const mirror = createGlobalDefaultMirror(s => applied.push(s?.modelId ?? null))
    const w = deferred()
    mirror.pick(X, () => w.promise)
    mirror.receive(X)
    mirror.receive(Z) // another window wrote after ours
    w.resolve()
    await w.promise
    await Promise.resolve()
    expect(applied.at(-1)).toBe('z')
  })

  it('a failed write falls back to the last published value', async () => {
    const applied: Array<string | null> = []
    const mirror = createGlobalDefaultMirror(s => applied.push(s?.modelId ?? null))
    mirror.seed(Z)
    const w = deferred()
    mirror.pick(X, () => w.promise)
    w.reject(new Error('disk full'))
    await w.promise.catch(() => {})
    await Promise.resolve()
    expect(applied).toEqual(['z', 'x', 'z'])
  })

  it('the boot read is only a seed: a published change or a pick made first wins', () => {
    const applied: Array<string | null> = []
    const mirror = createGlobalDefaultMirror(s => applied.push(s?.modelId ?? null))
    mirror.receive(Y)
    mirror.seed(X)
    expect(applied).toEqual(['y'])

    const picked: Array<string | null> = []
    const other = createGlobalDefaultMirror(s => picked.push(s?.modelId ?? null))
    other.pick(Y, () => new Promise(() => {}))
    other.seed(X)
    expect(picked).toEqual(['y'])
  })
})
