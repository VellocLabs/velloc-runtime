/**
 * Provider mods (PM-3) — the plugin loader surfaces a manifest's providers on
 * the active plugin (module paths resolved and checked), and the boot scan
 * finds the person's enabled and disabled plugins and hands them to the host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFs,
  type RuntimeFsEntry,
  type RuntimeFsStat,
} from '../utils/fs/runtimeFs'
import { assemblePluginAt } from '../pluginHost/loadPlugins'
import { describePluginError } from '../pluginHost/pluginModel'
import { scanProviderPlugins } from '../mods/provider/providerModBoot'
import { getProviderModHost } from '../mods/provider/providerModHost'
import { resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { resetCustomProviderRecords } from '../config/customProviderRegistry'

type FakeEntry = { kind: 'file'; content: string } | { kind: 'dir' }

function makeDirent(name: string, kind: 'file' | 'dir'): RuntimeFsEntry {
  return { name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => false }
}

function makeFakeFs(tree: Record<string, FakeEntry>): RuntimeFs {
  const exists = (path: string): boolean => {
    if (tree[path]) return true
    const prefix = path.endsWith('/') ? path : `${path}/`
    return Object.keys(tree).some(key => key.startsWith(prefix))
  }
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return {
    ...unconfiguredFs,
    async stat(path: string): Promise<RuntimeFsStat> {
      if (!exists(path)) throw enoent()
      return {} as RuntimeFsStat
    },
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const seen = new Set<string>()
      const out: RuntimeFsEntry[] = []
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        const first = key.slice(prefix.length).split('/')[0]!
        if (!first || seen.has(first)) continue
        seen.add(first)
        out.push(makeDirent(first, tree[`${prefix}${first}`]?.kind === 'file' ? 'file' : 'dir'))
      }
      if (out.length === 0 && !exists(path)) throw enoent()
      return out
    },
    async readFile(path: string): Promise<string> {
      const entry = tree[path]
      if (!entry || entry.kind !== 'file') throw enoent()
      return entry.content
    },
  } as RuntimeFs
}

const PROVIDER = {
  providerApi: 1,
  displayName: 'Zen',
  defaultBaseUrl: 'https://opencode.ai/zen/v1',
  domains: ['opencode.ai'],
  format: 'openai-chat',
  credentials: { methods: ['apiKey'] },
  module: './providers/zen.ts',
}

function pluginTree(root: string, manifest: Record<string, unknown>, files: string[]): Record<string, FakeEntry> {
  const tree: Record<string, FakeEntry> = {
    [root]: { kind: 'dir' },
    [`${root}/.claude-plugin/plugin.json`]: { kind: 'file', content: JSON.stringify(manifest) },
  }
  for (const file of files) tree[`${root}/${file}`] = { kind: 'file', content: '// module' }
  return tree
}

afterEach(() => {
  resetProcessFs()
  getProviderModHost().dispose()
  resetModProviderDefinitions()
  resetCustomProviderRecords()
})

describe('assemblePluginAt — providers', () => {
  beforeEach(() => resetProcessFs())
  const ROOT = '/plugins/opencode'

  it('surfaces providers with their ids and absolute module paths', async () => {
    installProcessFs(makeFakeFs(pluginTree(ROOT, { name: 'opencode', providers: { zen: PROVIDER, go: { ...PROVIDER, module: './providers/go.ts' } } }, ['providers/zen.ts', 'providers/go.ts'])))
    const { plugin, errors } = await assemblePluginAt(ROOT, 'user:/plugins/opencode', true, 'opencode')
    expect(errors).toEqual([])
    expect(plugin.providers?.map(p => [p.id, p.modulePath])).toEqual([
      ['mod.opencode.zen', `${ROOT}/providers/zen.ts`],
      ['mod.opencode.go', `${ROOT}/providers/go.ts`],
    ])
    // They are not hook modules: a plugin lists those elsewhere.
    expect(plugin.hookModules).toBeUndefined()
  })

  it('reports a provider whose module is missing and leaves it out, keeping the others', async () => {
    installProcessFs(makeFakeFs(pluginTree(ROOT, { name: 'opencode', providers: { zen: PROVIDER, go: { ...PROVIDER, module: './providers/go.ts' } } }, ['providers/go.ts'])))
    const { plugin, errors } = await assemblePluginAt(ROOT, 'user:/plugins/opencode', true, 'opencode')
    expect(plugin.providers?.map(p => p.id)).toEqual(['mod.opencode.go'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ type: 'path-not-found', component: 'providers', plugin: 'opencode' })
    expect(describePluginError(errors[0]!)).toMatch(/providers\/zen\.ts/)
  })

  it('has no providers when the manifest has none, or all are refused', async () => {
    installProcessFs(makeFakeFs(pluginTree(ROOT, { name: 'opencode', providers: { zen: { ...PROVIDER, providerApi: 7 } } }, ['providers/zen.ts'])))
    const { plugin, errors } = await assemblePluginAt(ROOT, 'user:/plugins/opencode', true, 'opencode')
    expect(plugin.providers).toBeUndefined()
    expect(errors.map(describePluginError).join('\n')).toMatch(/providers\.zen\.providerApi: 7 is not supported/)
  })
})

describe('scanProviderPlugins', () => {
  const HOME = '/home/u'
  const tree = (): Record<string, FakeEntry> => ({
    ...pluginTree(`${HOME}/.velloc/plugins/opencode`, { name: 'opencode', providers: { zen: PROVIDER } }, ['providers/zen.ts']),
    ...pluginTree(`${HOME}/.velloc/plugins/idle`, { name: 'idle', providers: { zen: PROVIDER } }, ['providers/zen.ts']),
    [`${HOME}/.velloc/enabled-plugins.json`]: { kind: 'file', content: JSON.stringify({ enabledPlugins: ['opencode'] }) },
  })

  it("reads the person's plugins, the enabled apart from the disabled, from the user scope", async () => {
    const scan = await scanProviderPlugins({ homeDir: HOME, fs: makeFakeFs(tree()) })
    expect(scan.enabled.map(p => p.name)).toEqual(['opencode'])
    expect(scan.disabled.map(p => p.name)).toEqual(['idle'])
    expect(scan.enabled[0]!.providers?.map(p => p.id)).toEqual(['mod.opencode.zen'])
    expect(scan.enabled[0]!.source.startsWith('user:')).toBe(true)
  })

  it('does not look in a project: the project scope is not read', async () => {
    const fs = makeFakeFs({
      ...tree(),
      ...pluginTree('/proj/.velloc/plugins/projonly', { name: 'projonly', providers: { zen: PROVIDER } }, ['providers/zen.ts']),
    })
    const scan = await scanProviderPlugins({ homeDir: HOME, fs })
    expect([...scan.enabled, ...scan.disabled].map(p => p.name)).not.toContain('projonly')
  })
})
