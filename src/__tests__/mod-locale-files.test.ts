/**
 * A mod's text in one file per language (`locales/<tag>.json`, F-25): a provider module's `$.fs.read` reaches only
 * its own plugin directory; a session module reads the same files, only the person's language and English.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { fileModFs } from '../mods/modFs'
import { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import { pluginOwnFileReader } from '../mods/provider/pluginOwnFiles'
import { refuseProviderModuleCall } from '../mods/provider/providerEvents'
import type { RuntimeFs, RuntimeFsStat } from '../utils/fs/runtimeFs'

const open: MessagePort[] = []
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const port of open.splice(0)) port.close()
})
let uniq = 0

/** Files by absolute path; `links` maps a path to where it really is. Every
 *  read is logged. */
function filesFs(files: Record<string, string>, links: Record<string, string> = {}) {
  const reads: string[] = []
  const real = (p: string): string => {
    for (const [from, to] of Object.entries(links)) {
      if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length)
    }
    return p
  }
  const isDir = (p: string) => Object.keys(files).some(f => f.startsWith(`${p}/`))
  const statOf = (p: string): RuntimeFsStat => {
    const t = real(p)
    const file = t in files
    if (!file && !isDir(t)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return {
      size: file ? new TextEncoder().encode(files[t]!).length : 0,
      mtimeMs: 0,
      isFile: () => file,
      isDirectory: () => !file,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isCharacterDevice: () => false,
      isBlockDevice: () => false,
    }
  }
  const fs = {
    stat: async (p: string) => statOf(p),
    lstatSync: (p: string) => statOf(p),
    realpath: async (p: string) => (statOf(p), real(p)),
    readFile: async (p: string) => {
      reads.push(p)
      return files[real(p)]!
    },
    readFileBytes: async (p: string) => new TextEncoder().encode(files[real(p)]!),
  } as unknown as RuntimeFs
  return { fs, reads }
}

const LOCALES = {
  '/plugins/acme/locales/en.json': JSON.stringify({ hello: 'hello {name}', bye: 'goodbye' }),
  '/plugins/acme/locales/zh.json': JSON.stringify({ hello: '你好 {name}' }),
  '/plugins/acme/locales/de.json': JSON.stringify({ hello: 'hallo {name}', bye: 'tschüss' }),
}

/** The loader a mod ships beside its code, in its smallest form: the
 *  person's language, then its language without the region, then English;
 *  only those files are read, and each once per worker. */
const LOADER = `
  const loaded = new Map()
  async function readTable($, tag) {
    try { return JSON.parse(await $.fs.read($.plugin.root + '/locales/' + tag + '.json')) } catch { return undefined }
  }
  async function textsFor($, locale = $.plugin.locale) {
    const tag = typeof locale === 'string' && locale !== '' ? locale.replace(/_/g, '-') : 'en'
    const language = tag.split('-')[0].toLowerCase()
    if (!loaded.has(tag)) loaded.set(tag, (async () => {
      const own = tag === 'en' ? undefined : (await readTable($, tag)) ?? (language !== tag && language !== 'en' ? await readTable($, language) : undefined)
      return { ...(await readTable($, 'en')), ...own }
    })())
    const table = await loaded.get(tag)
    return (key, params = {}) => (table[key] ?? key).replace(/\\{(\\w+)\\}/g, (all, name) => name in params ? String(params[name]) : all)
  }
`

describe('pluginOwnFileReader — a provider module reads its own files alone', () => {
  const read = pluginOwnFileReader(filesFs({ ...LOCALES, '/plugins/other/secret.json': '{}', '/elsewhere/x.json': '{}' }, {
    '/plugins/acme/locales/out': '/elsewhere',
  }).fs)

  it('reads a file under the plugin directory, by a relative or an absolute path', async () => {
    expect(await read('/plugins/acme', 'locales/zh.json', 'text')).toBe(LOCALES['/plugins/acme/locales/zh.json'])
    expect(await read('/plugins/acme', '/plugins/acme/locales/en.json', 'text')).toBe(LOCALES['/plugins/acme/locales/en.json'])
    expect(await read('/plugins/acme', 'locales/./de.json', 'bytes')).toHaveProperty('base64')
  })

  it('refuses a path that climbs out, an absolute path elsewhere, and a link that leads out', async () => {
    await expect(read('/plugins/acme', '../other/secret.json', 'text')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(read('/plugins/acme', 'locales/../../other/secret.json', 'text')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(read('/plugins/acme', '/plugins/other/secret.json', 'text')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(read('/plugins/acme', '/plugins/acme-evil/x.json', 'text')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(read('/plugins/acme', 'locales/out/x.json', 'text')).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('a missing file rejects ENOENT; a module with no directory or no path is refused', async () => {
    await expect(read('/plugins/acme', 'locales/ja.json', 'text')).rejects.toMatchObject({ name: 'NotFoundError', code: 'ENOENT' })
    await expect(read('', 'locales/en.json', 'text')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(read('/plugins/acme', '', 'text')).rejects.toBeInstanceOf(TypeError)
  })

  it('$.fs is read alone for a provider module', () => {
    expect(refuseProviderModuleCall('fs', 'read')).toBeNull()
    for (const method of ['write', 'list', 'exists', 'stat', 'ancestors']) {
      expect(refuseProviderModuleCall('fs', method)).toMatch(/\$\.fs offers read/)
    }
  })
})

describe('a provider module picks its words from locales/ in the language of the event', () => {
  function providerWorld(readPluginFile?: ReturnType<typeof pluginOwnFileReader>) {
    const runtime = new ProviderModRuntime({
      readModule: async () => `${LOADER}
        export function register(on) {
          on('provider.verify', async ($, e) => {
            const say = await textsFor($, e.locale)
            let escaped
            try { await $.fs.read('../other/secret.json') } catch (error) { escaped = error.name }
            return { ok: false, code: 'auth_unauthorized', message: say('hello', { name: 'Ada' }) + ' / ' + say('bye') + ' / ' + escaped }
          })
        }
        // load ${++uniq}`,
      openWorker: async () => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
        const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
          settle = resolve
        })
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      window: { available: () => true, attached: async () => {} },
      report: () => {},
      ...(readPluginFile ? { readPluginFile } : {}),
    })
    disposers.push(() => runtime.dispose())
    runtime.register('acme', [{ plugin: 'acme', path: '/plugins/acme/providers/acme.js', providers: ['mod.acme.main'] }])
    return runtime
  }

  it('reads the language of the call and English, from its own directory, each once', async () => {
    const files = filesFs({ ...LOCALES, '/plugins/other/secret.json': '{}' })
    const runtime = providerWorld(pluginOwnFileReader(files.fs))
    const first = await runtime.call('mod.acme.main', 'provider.verify', { locale: 'zh-CN' })
    expect(first).toMatchObject({ value: { message: '你好 Ada / goodbye / NotAllowedError' } })
    expect(files.reads.sort()).toEqual(['/plugins/acme/locales/en.json', '/plugins/acme/locales/zh.json'])
    const again = await runtime.call('mod.acme.main', 'provider.verify', { locale: 'zh-CN' })
    expect(again).toMatchObject({ value: { message: '你好 Ada / goodbye / NotAllowedError' } })
    expect(files.reads).toHaveLength(2)
    expect(files.reads.some(path => path.endsWith('de.json'))).toBe(false)
  })

  it('an engine with no reader refuses the call, and the text falls to its keys', async () => {
    const runtime = providerWorld()
    expect(await runtime.call('mod.acme.main', 'provider.verify', { locale: 'de' })).toMatchObject({
      value: { message: 'hello / bye / NotSupportedError' },
    })
  })
})

describe('a session module reads the same files with the same call', () => {
  it('only the window language and English are read', async () => {
    const files = filesFs(LOCALES)
    const reports: string[] = []
    const runtime = new ModRuntime({
      modules: [{ plugin: 'acme', path: '/plugins/acme/hooks/register.js' }],
      readModule: async () => `${LOADER}
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            const say = await textsFor($)
            await $.ui.log(say('hello', { name: 'Ada' }) + ' / ' + say('bye'))
            return next(e)
          })
        }
        // load ${++uniq}`,
      openWorker: async (): Promise<ModWorkerHandle> => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
        const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
          settle = resolve
        })
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      session: { id: () => 's', cwd: () => '/work/project', fs: fileModFs(files.fs, { cwd: '/work/project' }) },
      locale: 'de-AT',
      report: line => reports.push(line),
    })
    disposers.push(() => runtime.dispose())
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toContain('acme: hallo Ada / tschüss')
    expect(files.reads.sort()).toEqual(['/plugins/acme/locales/de.json', '/plugins/acme/locales/en.json'])
  })
})
