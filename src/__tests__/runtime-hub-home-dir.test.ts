/**
 * The runtime hub's writes under `~/.velloc` (F-25 `mods.setOptions`, the
 * settings adapters) anchor on the user's home from the host, whichever
 * client attached, and refuse to write when no home is known.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectPortBridgeTransport } from '../browser/bridge/DirectPortBridgeTransport'
import { connectRuntime, type RuntimeConnection } from '../browser/runtimeClient'
import { RuntimeHub, type RuntimeHubHost } from '../browser/runtimeHub/RuntimeHub'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import { wipeSettingsMemos } from '../settings/settingsStore'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const HOME = '/home/u'
const SETTINGS = `${HOME}/.velloc/settings.json`

/** A host bridge serving `fs` out of a map; every path it was asked to write is recorded. */
function hostBridge(files: Record<string, string> = {}) {
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([k, v]) => [k, ENC.encode(v)]))
  const writes: string[] = []
  const transport = {
    async request(req: unknown) {
      const { route, payload } = req as { route: { action: string }; payload: Record<string, unknown> }
      const path = String(payload.path ?? '').split(String.fromCharCode(92)).join('/')
      switch (route.action) {
        case 'readFile': {
          const v = store.get(path)
          return v ? { ok: true, result: v } : { ok: false, error: { code: 'ENOENT', message: path } }
        }
        case 'writeFile':
          writes.push(path)
          store.set(path, payload.content instanceof Uint8Array ? payload.content : ENC.encode(String(payload.content)))
          return { ok: true, result: undefined }
        case 'mkdir':
          writes.push(path)
          return { ok: true, result: undefined }
        default:
          return { ok: false, error: { code: 'UNSUPPORTED', message: route.action } }
      }
    },
    subscribeEvents: () => () => {},
  } as unknown as DirectPortBridgeTransport
  return {
    transport,
    writes,
    json: (path: string) => {
      const v = store.get(path)
      return v ? (JSON.parse(DEC.decode(v)) as Record<string, unknown>) : undefined
    },
  }
}

function makeHub(bridge: ReturnType<typeof hostBridge>, resolveHomeDir?: () => Promise<string | null>) {
  const reloads = vi.fn()
  let n = 0
  const host: RuntimeHubHost = {
    getDirectBridgeTransport: () => bridge.transport,
    createBridgeRequestId: () => `r-${++n}`,
    applyAgentSettingsToAllSessions: () => {},
    reloadPluginsOnAllSessions: reloads,
    runtimeVersion: 'test',
    ...(resolveHomeDir ? { resolveHomeDir } : {}),
  }
  return { hub: new RuntimeHub(host), reloads }
}

/** Connect a client the way a remote leg does (`attachTransport`), or as a desktop panel port with the given home. */
function connect(hub: RuntimeHub, via: { panelHome: string } | 'remote'): Promise<RuntimeConnection> {
  const channel = new MessageChannel()
  if (via === 'remote') hub.attachTransport(createMessagePortTransport(channel.port1))
  else hub.attachPort(channel.port1, via.panelHome)
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: 'c', kind: 'desktop-shell' },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

describe('runtime hub home directory', () => {
  const hubs: RuntimeHub[] = []
  beforeEach(() => wipeSettingsMemos())
  afterEach(() => {
    for (const hub of hubs.splice(0)) hub.dispose()
  })

  it('writes plugin options under the host home when the panel attached with no home', async () => {
    const bridge = hostBridge()
    // The host answers late: the request must wait for it, not write first.
    const home = deferred<string | null>()
    const { hub, reloads } = makeHub(bridge, () => home.promise)
    hubs.push(hub)
    const conn = await connect(hub, { panelHome: '' })
    const saved = conn.request('mods.setOptions', { plugin: 'nebius@inline', options: { region: 'eu' } })
    await new Promise(r => setTimeout(r, 10))
    expect(bridge.writes).toEqual([])
    home.resolve(HOME)
    await saved
    expect(bridge.json(SETTINGS)?.pluginConfigs).toEqual({ 'nebius@inline': { options: { region: 'eu' } } })
    expect(bridge.writes.every(path => path.startsWith(`${HOME}/`))).toBe(true)
    expect(reloads).toHaveBeenCalledTimes(1)
  })

  it('writes under the host home for a remote-only client', async () => {
    const bridge = hostBridge()
    const { hub } = makeHub(bridge, async () => HOME)
    hubs.push(hub)
    const conn = await connect(hub, 'remote')
    await conn.request('mods.setOptions', { plugin: 'nebius@inline', options: { region: 'us' } })
    expect(bridge.json(SETTINGS)?.pluginConfigs).toEqual({ 'nebius@inline': { options: { region: 'us' } } })
  })

  it('refuses the write when no home is known, writing nothing', async () => {
    const bridge = hostBridge()
    const { hub, reloads } = makeHub(bridge, async () => null)
    hubs.push(hub)
    const conn = await connect(hub, 'remote')
    await expect(
      conn.request('mods.setOptions', { plugin: 'nebius@inline', options: { region: 'eu' } }),
    ).rejects.toThrow(/no folder known/)
    expect(bridge.writes).toEqual([])
    expect(reloads).not.toHaveBeenCalled()
  })

  it('keeps a stored sensitive option the client left blank', async () => {
    const stored = { version: 1, pluginConfigs: { 'nebius@inline': { options: { apiKey: 's3cret', region: 'eu' } } } }
    const bridge = hostBridge({ [SETTINGS]: JSON.stringify(stored) })
    const { hub } = makeHub(bridge, async () => HOME)
    hubs.push(hub)
    const conn = await connect(hub, 'remote')
    await conn.request('mods.setOptions', { plugin: 'nebius@inline', options: { region: 'us' }, keep: ['apiKey'] })
    expect(bridge.json(SETTINGS)?.pluginConfigs).toEqual({
      'nebius@inline': { options: { region: 'us', apiKey: 's3cret' } },
    })
  })
})
