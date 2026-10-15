import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import { loadLocalPromptCommands } from '../skillLibrary/skillDiscovery'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFsEntry,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'

type FakeEntry = { kind: 'file'; content: string } | { kind: 'dir' }

function makeDirent(name: string, kind: 'file' | 'dir'): RuntimeFsEntry {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  }
}

function makeFakeFs(tree: Record<string, FakeEntry>): RuntimeFs {
  return {
    ...unconfiguredFs,
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const seen = new Set<string>()
      const out: RuntimeFsEntry[] = []
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        const firstSegment = key.slice(prefix.length).split('/')[0]!
        if (!firstSegment || seen.has(firstSegment)) continue
        seen.add(firstSegment)
        const entry = tree[`${prefix}${firstSegment}`]
        out.push(makeDirent(firstSegment, entry?.kind === 'file' ? 'file' : 'dir'))
      }
      if (out.length === 0 && !Object.keys(tree).some(k => k.startsWith(prefix))) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return out
    },
    async readFile(path: string): Promise<string> {
      const entry = tree[path]
      if (!entry || entry.kind !== 'file') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return entry.content
    },
  } as RuntimeFs
}

afterEach(() => resetProcessFs())

describe('loadLocalPromptCommands with plugin skill dirs', () => {
  beforeEach(() => resetProcessFs())

  it('namespaces plugin skills so a same-named local skill no longer shadows them', async () => {
    installProcessFs(
      makeFakeFs({
        // Project skill named "shared" — stays bare-named.
        '/workspace/.velloc/skills': { kind: 'dir' },
        '/workspace/.velloc/skills/shared': { kind: 'dir' },
        '/workspace/.velloc/skills/shared/SKILL.md': {
          kind: 'file',
          content: '---\ndescription: Project shared\n---\nProject body.\n',
        },
        // Plugin skills: "shared" (now alpha:shared, no longer dropped)
        // and "unique" (alpha:unique).
        '/plugins/alpha/skills': { kind: 'dir' },
        '/plugins/alpha/skills/shared': { kind: 'dir' },
        '/plugins/alpha/skills/shared/SKILL.md': {
          kind: 'file',
          content: '---\ndescription: Plugin shared\n---\nPlugin body.\n',
        },
        '/plugins/alpha/skills/unique': { kind: 'dir' },
        '/plugins/alpha/skills/unique/SKILL.md': {
          kind: 'file',
          content: '---\ndescription: Plugin unique\n---\nUnique body.\n',
        },
      }),
    )

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      pluginSkillDirs: [
        { dirPath: '/plugins/alpha/skills', pluginName: 'alpha', kind: 'skills' },
      ],
    })

    const shared = commands.find(c => c.name === 'shared')
    const pluginShared = commands.find(c => c.name === 'alpha:shared')
    const unique = commands.find(c => c.name === 'alpha:unique')

    expect(shared?.source).toBe('project')
    expect(shared?.description).toBe('Project shared')
    // The prefix means BOTH survive — the silent drop is gone.
    expect(pluginShared?.source).toBe('plugin')
    expect(pluginShared?.description).toBe('Plugin shared')
    expect(unique?.source).toBe('plugin')
    expect(unique?.loadedFrom).toBe('plugin')
    expect(unique?.pluginName).toBe('alpha')
    // No bare-named plugin entries remain.
    expect(commands.find(c => c.name === 'unique')).toBeUndefined()
  })

  it('commands tree: SKILL.md suppresses sibling .md files and the leaf dir is not recursed', async () => {
    installProcessFs(
      makeFakeFs({
        '/plugins/alpha/commands': { kind: 'dir' },
        '/plugins/alpha/commands/research': { kind: 'dir' },
        '/plugins/alpha/commands/research/deep-dive': { kind: 'dir' },
        '/plugins/alpha/commands/research/deep-dive/SKILL.md': {
          kind: 'file',
          content: '---\ndescription: Deep dive\n---\nDive.\n',
        },
        // Sibling .md in the same skill dir — suppressed by SKILL.md.
        '/plugins/alpha/commands/research/deep-dive/notes.md': {
          kind: 'file',
          content: 'Loose notes.\n',
        },
        // Subdir of a skill dir — not scanned (leaf container).
        '/plugins/alpha/commands/research/deep-dive/inner': { kind: 'dir' },
        '/plugins/alpha/commands/research/deep-dive/inner/extra.md': {
          kind: 'file',
          content: 'Hidden.\n',
        },
      }),
    )

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      includeBundled: false,
      pluginSkillDirs: [
        { dirPath: '/plugins/alpha/commands', pluginName: 'alpha', kind: 'commands' },
      ],
    })
    const names = commands.map(c => c.name)

    expect(names).toContain('alpha:research:deep-dive')
    expect(names.filter(n => n.includes('notes'))).toEqual([])
    expect(names.filter(n => n.includes('extra'))).toEqual([])
  })

  it('two plugins shipping the same nested command name both survive', async () => {
    installProcessFs(
      makeFakeFs({
        '/plugins/alpha/commands': { kind: 'dir' },
        '/plugins/alpha/commands/deploy.md': {
          kind: 'file',
          content: '---\ndescription: Alpha deploy\n---\nA.\n',
        },
        '/plugins/beta/commands': { kind: 'dir' },
        '/plugins/beta/commands/deploy.md': {
          kind: 'file',
          content: '---\ndescription: Beta deploy\n---\nB.\n',
        },
      }),
    )

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      includeBundled: false,
      pluginSkillDirs: [
        { dirPath: '/plugins/alpha/commands', pluginName: 'alpha', kind: 'commands' },
        { dirPath: '/plugins/beta/commands', pluginName: 'beta', kind: 'commands' },
      ],
    })

    expect(commands.find(c => c.name === 'alpha:deploy')?.description).toBe(
      'Alpha deploy',
    )
    expect(commands.find(c => c.name === 'beta:deploy')?.description).toBe(
      'Beta deploy',
    )
  })
})
