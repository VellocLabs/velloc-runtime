/**
 * Provider mods (F-27): the status table on the runtime protocol. The topic is
 * readable at `observe`, both actions are `control` and refuse a scoped
 * connection; the runtime reads the store, a client names only a provider and
 * a job, and a job runs only through the job seam.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import { CapabilityRegistry, ConnectionHub, TopicBroker, type RuntimeContext } from '../browser/runtimeHub'
import { connectRuntime, type RuntimeConnection } from '../browser/runtimeClient'
import { registerProviderStatusCapability } from '../browser/runtimeHub/providerStatusCapability'
import { fileModStore, resetModStoresForTests } from '../mods/modStore'
import { runProviderJobNow, setProviderJobRunner } from '../mods/provider/providerJobSeam'
import type { ProviderStatusView } from '../mods/provider/providerStatusManifest'
import {
  providerStatusState,
  refreshProviderStatus,
  resetProviderStatusForTests,
  setProviderStatusSources,
  type ProviderStatusSubject,
} from '../mods/provider/providerStatusService'
import { PROVIDER_STATUS_TOPIC, type ProviderStatusState } from '../mods/provider/providerStatusState'

const VIEW: ProviderStatusView = {
  source: { store: 'status' },
  fields: [
    { key: 'state', label: 'Status', format: 'badge' },
    { key: 'lastError', label: 'Last error', format: 'text' },
  ],
  actions: [{ label: 'Probe now', job: 'probe' }],
}

const ID = 'mod.acme.main'

function memoryFs() {
  const files = new Map<string, string>()
  return {
    files,
    readFile: async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return text
    },
    writeFile: async (path: string, data: string) => {
      files.set(path, data)
    },
    ensureDir: async () => {},
  }
}

function makeRig(subjects: ProviderStatusSubject[] = [{ providerId: ID, plugin: 'acme', view: VIEW }]) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const fs = memoryFs()
  const store = (plugin: string) => fileModStore('/h/.velloc/mods', plugin, fs)
  const read = vi.fn((plugin: string, key: string) => store(plugin).get(key))
  const live = { subjects }
  setProviderStatusSources({ subjects: () => live.subjects, read, now: () => 1000 })
  registerProviderStatusCapability(registry, broker)
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'ps', bootstrap: () => undefined })
  return { registry, hub, store, read, live }
}

async function connect(rig: ReturnType<typeof makeRig>, scopeCeiling?: 'control' | 'observe'): Promise<RuntimeConnection> {
  const channel = new MessageChannel()
  rig.hub.attach(createMessagePortTransport(channel.port1))
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: 'c', kind: 'desktop-shell' },
    ...(scopeCeiling ? { scopeCeiling } : {}),
  })
}

function watch(connection: RuntimeConnection) {
  const seen: ProviderStatusState[] = []
  connection.subscribe<ProviderStatusState>(PROVIDER_STATUS_TOPIC, event => seen.push(event.payload))
  return seen
}

afterEach(() => {
  resetProviderStatusForTests()
  setProviderJobRunner(undefined)
  resetModStoresForTests()
})

describe('providerStatus on the runtime protocol', () => {
  it('declares both actions control', () => {
    const { registry } = makeRig()
    for (const act of ['refresh', 'runJob']) expect(registry.resolve('providerStatus', act)!.spec.scope).toBe('control')
  })

  it('an observer reads the table, freshly read on subscribe, and is refused both actions', async () => {
    const rig = makeRig()
    await rig.store('acme').set('status', { state: { text: 'Healthy', tone: 'ok' }, lastError: 'HTTP 503' })
    const observer = await connect(rig, 'observe')
    const seen = watch(observer)
    await vi.waitFor(() => expect(seen.at(-1)?.[ID]).toBeDefined())
    expect(seen.at(-1)![ID]).toMatchObject({
      readAt: 1000,
      rows: [
        { key: 'state', kind: 'value', cell: { format: 'badge', text: 'Healthy', tone: 'ok' } },
        { key: 'lastError', kind: 'value', cell: { format: 'text', text: 'HTTP 503' } },
      ],
      actions: [{ job: 'probe', label: 'Probe now' }],
    })
    await expect(observer.request('providerStatus.refresh', { providerId: ID })).rejects.toMatchObject({ code: 'forbidden_scope' })
    await expect(observer.request('providerStatus.runJob', { providerId: ID, job: 'probe' })).rejects.toMatchObject({ code: 'forbidden_scope' })
    expect(observer.can('providerStatus', 'runJob')).toBe(false)
  })

  it('a write to the view\'s store key is published without a client asking; another key is not read', async () => {
    const rig = makeRig()
    const control = await connect(rig, 'control')
    const seen = watch(control)
    await vi.waitFor(() => expect(seen.at(-1)?.[ID]?.empty).toBe(true))
    const reads = rig.read.mock.calls.length
    await rig.store('acme').set('unrelated', { state: 'x' })
    await rig.store('other-plugin').set('status', { state: 'x' })
    expect(rig.read.mock.calls.length).toBe(reads)
    await rig.store('acme').set('status', { state: 'Degraded' })
    await vi.waitFor(() =>
      expect(seen.at(-1)?.[ID]?.rows[0]).toMatchObject({ cell: { format: 'badge', text: 'Degraded', tone: 'neutral' } }),
    )
    await rig.store('acme').delete('status')
    await vi.waitFor(() => expect(seen.at(-1)?.[ID]?.empty).toBe(true))
  })

  it('refresh validates its payload and answers the entry; an unknown provider answers null', async () => {
    const rig = makeRig()
    const control = await connect(rig, 'control')
    await expect(control.request('providerStatus.refresh', {})).rejects.toMatchObject({ code: 'bad_payload' })
    await expect(control.request('providerStatus.refresh', { providerId: 'x'.repeat(200) })).rejects.toMatchObject({ code: 'bad_payload' })
    await rig.store('acme').set('status', { lastError: 'boom' })
    const entry = await control.request<{ rows: unknown[] }>('providerStatus.refresh', { providerId: ID })
    expect(entry.rows[1]).toMatchObject({ cell: { text: 'boom' } })
    expect(await control.request('providerStatus.refresh', { providerId: 'mod.none.x' })).toBeNull()
    await expect(control.request('providerStatus.nope', { providerId: ID })).rejects.toMatchObject({ code: 'unknown_route' })
  })

  it('a failed store read is an entry with an error and no values, not a rejection', async () => {
    const rig = makeRig()
    rig.read.mockRejectedValueOnce(new Error('disk gone'))
    const entry = await refreshProviderStatus(ID)
    expect(entry).toMatchObject({ error: true, rows: [{ key: 'state' }, { key: 'lastError' }] })
    expect(JSON.stringify(entry)).not.toContain('disk gone')
    expect(entry?.empty).toBeUndefined()
    expect(entry?.rows.every(row => row.kind === 'value' && row.cell === undefined)).toBe(true)
  })

  it('one read per provider at a time; requests made during it share exactly one more read', async () => {
    const rig = makeRig()
    let release!: () => void
    rig.read.mockImplementationOnce(() => new Promise(resolve => (release = () => resolve(undefined))))
    const first = refreshProviderStatus(ID)
    const during = [refreshProviderStatus(ID), refreshProviderStatus(ID), refreshProviderStatus(ID)]
    expect(rig.read).toHaveBeenCalledTimes(1)
    await rig.store('acme').set('status', { lastError: 'written during the read' })
    release()
    const answers = await Promise.all([first, ...during])
    expect(rig.read).toHaveBeenCalledTimes(2)
    for (const entry of answers) expect(entry?.rows[1]).toMatchObject({ cell: { text: 'written during the read' } })
  })

  it('a provider that leaves is dropped from the table', async () => {
    const rig = makeRig()
    await refreshProviderStatus(ID)
    expect(providerStatusState()[ID]).toBeDefined()
    rig.live.subjects = []
    expect(await refreshProviderStatus(ID)).toBeUndefined()
    expect(providerStatusState()).toEqual({})
  })

  it('runJob answers "unavailable" while no job runner is installed, and runs nothing', async () => {
    const rig = makeRig()
    const control = await connect(rig, 'control')
    expect(await control.request('providerStatus.runJob', { providerId: ID, job: 'probe' })).toEqual({ outcome: 'unavailable' })
    expect(await runProviderJobNow(ID, 'probe')).toBe('unavailable')
  })

  it('runJob passes only a job the view offers to the runner, and relays its outcome', async () => {
    const rig = makeRig()
    const runner = vi.fn(async () => 'started' as const)
    setProviderJobRunner(runner)
    const control = await connect(rig, 'control')
    expect(await control.request('providerStatus.runJob', { providerId: ID, job: 'probe' })).toEqual({ outcome: 'started' })
    expect(runner).toHaveBeenCalledWith(ID, 'probe')
    await expect(control.request('providerStatus.runJob', { providerId: ID, job: 'wipe' })).rejects.toMatchObject({ code: 'bad_payload' })
    await expect(control.request('providerStatus.runJob', { providerId: 'mod.none.x', job: 'probe' })).rejects.toMatchObject({ code: 'bad_payload' })
    await expect(control.request('providerStatus.runJob', { providerId: ID })).rejects.toMatchObject({ code: 'bad_payload' })
    expect(runner).toHaveBeenCalledTimes(1)
    runner.mockRejectedValueOnce(new Error('runner broke'))
    expect(await control.request('providerStatus.runJob', { providerId: ID, job: 'probe' })).toEqual({ outcome: 'unavailable' })
  })

  it('a later subscriber is served the table as it stands, without another read', async () => {
    const rig = makeRig()
    await rig.store('acme').set('status', { state: 'Healthy' })
    const first = watch(await connect(rig, 'control'))
    await vi.waitFor(() => expect(first.at(-1)?.[ID]).toBeDefined())
    const reads = rig.read.mock.calls.length
    const second = watch(await connect(rig, 'observe'))
    await vi.waitFor(() => expect(second.at(-1)?.[ID]?.rows[0]).toMatchObject({ cell: { text: 'Healthy' } }))
    expect(rig.read.mock.calls.length).toBe(reads)
  })

  it('a provider that declares no view has no entry', async () => {
    const rig = makeRig([])
    const control = await connect(rig, 'control')
    const seen = watch(control)
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen.at(-1)).toEqual({})
    expect(rig.read).not.toHaveBeenCalled()
  })
})
