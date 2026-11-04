/**
 * Model egress masking (F-39) fails closed and recovers: the realm's home is
 * resolved before masking is settled off, a bad settings file is read again
 * from disk, `/masking` never overwrites a file it could not read, malformed
 * tables are listed without throwing, and masked keys never merge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirectPortBridgeTransport } from '../browser/bridge/DirectPortBridgeTransport'
import { ManagerBootServices, type ManagerBootServicesHost } from '../browser/worker/ManagerBootServices'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import type { NoticeRow } from '../runtime/RuntimeTypes'
import { NoopPlatformCapabilities, createEmptyAppState, createNoopToolUseContext } from '../runtime/testing/noopAdapters'
import { processUserInput } from '../input/submitUserInput'
import { BROWSER_SLASH_COMMANDS } from '../input/slashCommandCatalog'
import { MaskingResidualError } from '../models/masking/egressGuard'
import { MASKING_KNOWN_WAIT_MS, MASKING_READ_RETRY_MS, modelMasking } from '../models/masking/maskingHolder'
import { resetModelMaskingBoot } from '../models/masking/maskingBoot'
import { compileMasking } from '../models/masking/maskingRules'
import { maskPayload, MaskingTally, PayloadMasker } from '../models/masking/maskPayload'
import { wipeSettingsMemos } from '../settings/settingsStore'
import { type RuntimeFs, installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'

vi.mock('../mods/provider/providerModBoot', () => ({ bootProviderMods: async () => {} }))

const RULES = [{ match: 'AcmeCo', alias: 'Northwind' }]
const SETTINGS_PATH = '/home/u/.velloc/settings.json'

function memoryFs(files: Record<string, string>) {
  const store = new Map(Object.entries(files))
  const fs = {
    async readFile(path: string) {
      const text = store.get(path)
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    },
    async mkdir() {},
    async writeFile(path: string, content: string) {
      store.set(path, content)
    },
    async stat() {
      throw new Error('ENOENT')
    },
    async rm() {},
  } as unknown as RuntimeFs
  return { fs, store }
}

/** A manager whose storage is flat (no home) while the host can name one. */
function rig(options: { resolveHome: () => Promise<string | null>; userHome: () => unknown }) {
  const transport = {
    async request(req: { id: string; route: { domain: string; action: string } }) {
      if (req.route.action === 'userHome') {
        const home = options.userHome()
        if (home instanceof Error) throw home
        return { id: req.id, route: req.route, ok: true, result: home }
      }
      return { id: req.id, route: req.route, ok: true, result: {} }
    },
    subscribeEvents: () => () => {},
  } as unknown as DirectPortBridgeTransport
  let n = 0
  const host: ManagerBootServicesHost = {
    getDirectBridgeTransport: () => transport,
    createBridgeRequestId: () => `r-${++n}`,
    getHomeDir: () => null,
    resolveHomeDir: options.resolveHome,
    getHostManifest: () => null,
    storageRoot: () => null,
    spawnHeadlessSession: (() => null) as never,
    deliverRoutineToSession: (() => false) as never,
    canDeliverRoutineToSession: (() => false) as never,
    scheduleSummary: () => {},
    isAnySessionBusy: () => false,
    trace: () => {},
  }
  const services = new ManagerBootServices(host)
  return { services, transport }
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0)
}

afterEach(() => {
  vi.useRealTimers()
  resetProcessFs()
  resetModelMaskingBoot()
  wipeSettingsMemos()
  modelMasking.resetForTest()
  modelMasking.configure(undefined)
})

describe('masking boot with flat storage', () => {
  it('reads the settings of the home sessions use, so masking on stays on', async () => {
    vi.useFakeTimers()
    modelMasking.resetForTest()
    const { fs } = memoryFs({ [SETTINGS_PATH]: JSON.stringify({ version: 1, modelMasking: { enabled: true, rules: RULES } }) })
    const { services, transport } = rig({ resolveHome: async () => '/home/u', userHome: () => '/home/u' })
    vi.spyOn(services, 'getManagerFs').mockReturnValue(fs)
    services.onDirectTransportAttached(transport)
    services.onStorageReady()
    await flush()
    expect(modelMasking.status().state).toBe('active')
  })

  it('stays unknown while the host does not answer, and is settled off only when it answers with no home', async () => {
    vi.useFakeTimers()
    modelMasking.resetForTest()
    let answer: unknown = new Error('no answer')
    const { services, transport } = rig({ resolveHome: async () => null, userHome: () => answer })
    services.onDirectTransportAttached(transport)
    services.onStorageReady()
    await flush()
    expect(modelMasking.status().state).toBe('unknown')
    answer = ''
    await vi.advanceTimersByTimeAsync(MASKING_READ_RETRY_MS)
    await flush()
    expect(modelMasking.status().state).toBe('off')
  })
})

describe('the settings re-read', () => {
  for (const [name, bad] of [
    ['malformed JSON', '{ not json'],
    ['an unsupported version', JSON.stringify({ version: 99, modelMasking: { enabled: false } })],
  ] as const) {
    it(`recovers once ${name} is fixed, with no cache to clear`, async () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      modelMasking.resetForTest()
      const { fs, store } = memoryFs({ [SETTINGS_PATH]: bad })
      const { services, transport } = rig({ resolveHome: async () => '/home/u', userHome: () => '/home/u' })
      vi.spyOn(services, 'getManagerFs').mockReturnValue(fs)
      services.onDirectTransportAttached(transport)
      await flush()
      expect(modelMasking.status().state).toBe('unknown')
      store.set(SETTINGS_PATH, JSON.stringify({ version: 1, modelMasking: { enabled: true, rules: RULES } }))
      await vi.advanceTimersByTimeAsync(MASKING_READ_RETRY_MS)
      await flush()
      expect(modelMasking.status().state).toBe('active')
    })
  }

  it('a read that lands after a /masking change does not undo it', async () => {
    modelMasking.resetForTest()
    let land!: (value: { enabled: boolean }) => void
    const pending = modelMasking.load(() => new Promise(resolve => (land = resolve)))
    modelMasking.configure({ enabled: true, rules: RULES })
    land({ enabled: false })
    await pending
    expect(modelMasking.status().state).toBe('active')
  })

  it('a stream waiting on an unknown state is released after a bounded wait', async () => {
    vi.useFakeTimers()
    modelMasking.resetForTest()
    let released = false
    void modelMasking.whenKnown().then(() => (released = true))
    await vi.advanceTimersByTimeAsync(MASKING_KNOWN_WAIT_MS - 1)
    expect(released).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(released).toBe(true)
    expect(() => modelMasking.openStream({ streamId: 's', provider: 'p', model: 'm' })).toThrow()
  })
})

function makeContext() {
  const context = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'sess',
    cwd: '/w',
    projectRoot: '/proj',
    commands: [],
  })
  context.options.homeDir = '/home/u'
  context.messages = []
  return context
}

async function run(input: string) {
  const out = await processUserInput(
    { input, context: makeContext() },
    {
      hostBridge: {} as unknown as BrowserHostBridge,
      runtimeConfig: new BrowserRuntimeConfig(),
      supportedSlashCommands: [...BROWSER_SLASH_COMMANDS],
      settingsHomeDir: '/home/u',
    },
  )
  const row = out.messages.find(m => m.type === 'system') as unknown as NoticeRow & { message: string }
  return { text: row.message, row }
}

describe('/masking over a settings file it cannot read', () => {
  it('refuses to write, and leaves every other section in place', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const original = JSON.stringify({ version: 99, providers: { a: { api_key: 'k' } } })
    const { fs, store } = memoryFs({ [SETTINGS_PATH]: original })
    installProcessFs(fs)
    const { text, row } = await run('/masking off')
    expect(store.get(SETTINGS_PATH)).toBe(original)
    expect(text).toContain('The settings file cannot be read')
    const keys = (row.i18nContent ?? []).flatMap(part => ('key' in part ? [part.key] : []))
    expect(keys).toContain('slash.out.masking.error.settingsUnreadable')
  })
})

describe('/masking with a malformed saved table', () => {
  for (const [name, rules, count] of [
    ['a null entry', [null, { match: 'AcmeCo', alias: 'Northwind' }], 2],
    ['an object', { match: 'AcmeCo' }, 0],
    ['a string', 'AcmeCo', 0],
  ] as const) {
    it(`${name}: rules and test answer without throwing, and the count is not characters`, async () => {
      installProcessFs(memoryFs({}).fs)
      modelMasking.configure({ enabled: false, rules })
      expect(modelMasking.status().ruleCount).toBe(count)
      const listed = await run('/masking rules')
      expect(listed.text.length).toBeGreaterThan(0)
      if (Array.isArray(rules)) expect(listed.text).toContain('#1 not a rule')
      else expect(listed.text).toContain('The saved rules cannot be used.')
      const tested = await run('/masking test AcmeCo')
      expect(tested.text).toContain('The saved rules cannot be used.')
    })
  }

  it('/masking test fences a text holding backticks', async () => {
    installProcessFs(memoryFs({}).fs)
    modelMasking.configure({ enabled: false, rules: RULES })
    const { text } = await run('/masking test a ``` AcmeCo')
    expect(text).toContain('````\na ``` Northwind\n````')
  })
})

describe('masked object keys', () => {
  it('refuse the request instead of merging two keys into one', () => {
    const masking = compileMasking(RULES)
    const payload = {
      messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'Edit', args: { AcmeCo: 1, Northwind: 2 } }] }],
    }
    expect(() => maskPayload(payload as never, new PayloadMasker(masking, new MaskingTally(false))))
      .toThrow(MaskingResidualError)
  })

  it('distinct keys are still masked', () => {
    const masking = compileMasking(RULES)
    const payload = { messages: [{ role: 'user', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'E', args: { AcmeCo: 1, other: 2 } }] }] }
    const out = maskPayload(payload as never, new PayloadMasker(masking, new MaskingTally(false)))
    expect((out.messages[0]!.content as any[])[0].args).toEqual({ Northwind: 1, other: 2 })
  })
})
