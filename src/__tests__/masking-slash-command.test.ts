import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import type { NoticeRow } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { type RuntimeFs, installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'
import { wipeSettingsMemos } from '../settings/settingsStore'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { processUserInput } from '../input/submitUserInput'
import { BROWSER_SLASH_COMMANDS } from '../input/slashCommandCatalog'
import { modelMasking } from '../models/masking/maskingHolder'

const RULES = [
  { match: 'AcmeCo', alias: 'Northwind' },
  { match: 'widget', alias: 'beacon' },
]

/** A map-backed fs: what the command reads, and the settings file it writes. */
function stubFs(files: Record<string, string>) {
  const store = new Map(Object.entries(files))
  const writes: string[] = []
  installProcessFs({
    async readFile(path: string) {
      const text = store.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    async mkdir() {},
    async writeFile(path: string, content: string) {
      store.set(path, content)
      writes.push(path)
    },
  } as unknown as RuntimeFs)
  const settings = () => {
    const path = writes.at(-1)
    return path ? (JSON.parse(store.get(path)!) as { modelMasking?: Record<string, unknown> }) : undefined
  }
  return { writes, settings }
}

function makeContext(): ToolCallContext {
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

const runtimeConfig = new BrowserRuntimeConfig()

async function run(input: string, settingsHomeDir: string | undefined = '/home/u') {
  const out = await processUserInput(
    { input, context: makeContext() },
    {
      hostBridge: {} as unknown as BrowserHostBridge,
      runtimeConfig,
      supportedSlashCommands: [...BROWSER_SLASH_COMMANDS],
      settingsHomeDir,
    },
  )
  const row = out.messages.find(m => m.type === 'system') as unknown as NoticeRow & { message: string }
  return { out, text: row.message, row }
}

afterEach(() => {
  resetProcessFs()
  wipeSettingsMemos()
  modelMasking.configure(undefined)
})

describe('/masking', () => {
  it('reports the state, with every line from the catalog', async () => {
    stubFs({})
    const { out, text, row } = await run('/masking')
    expect(out.shouldQuery).toBe(false)
    expect(text).toContain('Masking is off (0 rules saved).')
    expect(text).toContain('Replacement log: off.')
    const keys = (row.i18nContent ?? []).flatMap(part => ('key' in part ? [part.key] : []))
    expect(keys).toEqual(['slash.out.masking.statusOff', 'slash.out.masking.statusNoLog'])
  })

  it('loads rules from a file relative to the working directory, saves them and applies them at once', async () => {
    const fs = stubFs({ '/w/rules.json': JSON.stringify({ rules: RULES }) })
    const loaded = await run('/masking rules rules.json')
    expect(loaded.text).toContain('Loaded 2 rules from /w/rules.json.')
    expect(fs.settings()?.modelMasking).toEqual({ rules: RULES })
    expect(modelMasking.status()).toMatchObject({ enabled: false, ruleCount: 2 })
    expect(modelMasking.current()).toBeUndefined()

    const on = await run('/masking on')
    expect(on.text).toContain('Masking is on with 2 rules.')
    expect(fs.settings()?.modelMasking).toMatchObject({ enabled: true })
    expect(modelMasking.current()?.maskText('AcmeCo widget').text).toBe('Northwind beacon')

    const off = await run('/masking off')
    expect(off.text).toContain('Masking is off.')
    expect(modelMasking.current()).toBeUndefined()
  })

  it('reads only the rules from a file, and says which other fields it ignored', async () => {
    const fs = stubFs({
      '/w/rules.json': JSON.stringify({ rules: RULES, enabled: true, logPath: '/logs/m.log', logDetail: 'context' }),
    })
    const loaded = await run('/masking rules rules.json')
    expect(loaded.text).toContain('ignored: enabled, logPath, logDetail')
    expect(fs.settings()?.modelMasking).toEqual({ rules: RULES })
    expect(modelMasking.status()).toMatchObject({ enabled: false, state: 'off' })
  })

  it('reports while the settings are not read yet that requests are held', async () => {
    stubFs({})
    modelMasking.resetForTest()
    const { text, row } = await run('/masking')
    expect(text).toContain('not read yet')
    expect((row.i18nContent ?? []).some(part => 'key' in part && part.key === 'slash.out.masking.statusUnknown')).toBe(true)
  })

  it('shows the last error from the catalog', async () => {
    stubFs({})
    modelMasking.resetForTest()
    await modelMasking.load(async () => 'unreadable')
    const { text, row } = await run('/masking')
    expect(text).toContain('Last error: The settings file cannot be read')
    const keys = (row.i18nContent ?? []).flatMap(part => ('key' in part ? [part.key] : []))
    expect(keys).toContain('slash.out.masking.error.settingsUnreadable')
    modelMasking.resetForTest()
  })

  it('accepts inline JSON', async () => {
    const fs = stubFs({})
    const { text } = await run(`/masking rules ${JSON.stringify(RULES)}`)
    expect(text).toContain('Loaded 2 rules.')
    expect(fs.settings()?.modelMasking).toEqual({ rules: RULES })
  })

  it('rejects a table that is not reversible and changes nothing', async () => {
    const fs = stubFs({})
    const { text } = await run('/masking rules [{"match":"a","alias":"x"},{"match":"b","alias":"x"}]')
    expect(text).toContain('The rules were not saved.')
    expect(text).toContain('Rule 2 has the same alias as rule 1')
    expect(fs.writes).toEqual([])
    expect(modelMasking.status().ruleCount).toBe(0)
  })

  it('reports an unreadable file and invalid JSON', async () => {
    stubFs({ '/w/bad.json': '{nope' })
    expect((await run('/masking rules /w/missing.json')).text).toContain('Cannot read /w/missing.json')
    expect((await run('/masking rules bad.json')).text).toContain('The rules are not valid JSON')
  })

  it('refuses to turn on without rules', async () => {
    const fs = stubFs({})
    const { text } = await run('/masking on')
    expect(text).toContain('Cannot turn masking on: there are no rules.')
    expect(fs.writes).toEqual([])
  })

  it('sets and clears the log, and its detail', async () => {
    const fs = stubFs({})
    expect((await run('/masking log logs/m.log')).text).toContain('Replacements are logged to /w/logs/m.log (counts).')
    expect(fs.settings()?.modelMasking).toEqual({ logPath: '/w/logs/m.log' })
    expect((await run('/masking log detail context')).text).toContain('24 characters')
    expect(fs.settings()?.modelMasking).toEqual({ logPath: '/w/logs/m.log', logDetail: 'context' })
    expect((await run('/masking log off')).text).toContain('The replacement log is off.')
    expect(fs.settings()?.modelMasking).toEqual({ logDetail: 'context' })
  })

  it('previews masking without sending anything', async () => {
    stubFs({})
    await run(`/masking rules ${JSON.stringify(RULES)}`)
    const { text, out } = await run('/masking test the AcmeCo widget, widget')
    expect(out.shouldQuery).toBe(false)
    expect(text).toContain('the Northwind beacon, beacon')
    expect(text).toContain('#1 × 1')
    expect(text).toContain('#2 × 2')
  })

  it('lists the saved rules', async () => {
    stubFs({})
    await run(`/masking rules ${JSON.stringify(RULES)}`)
    const { text } = await run('/masking rules')
    expect(text).toContain('Masking rules (2)')
    expect(text).toContain('#1 `AcmeCo` → `Northwind`')
  })

  it('lists a rule holding a backtick in a code span that still closes', async () => {
    stubFs({})
    await run(`/masking rules ${JSON.stringify([{ match: 'a`b', alias: 'x' }])}`)
    const { text } = await run('/masking rules')
    expect(text).toContain('#1 ``a`b`` → `x`')
  })

  it('says where it cannot save', async () => {
    stubFs({})
    const { text } = await run('/masking off', '')
    expect(text).toContain('This host has no settings file')
  })

  it('shows usage for anything else, and is listed in /help', async () => {
    stubFs({})
    expect((await run('/masking frobnicate')).text).toContain('Usage: /masking')
    expect((await run('/help')).text).toContain('/masking')
  })
})
