import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import {
  buildAgentRegistry,
  findAgentDefinition,
  loadLocalAgents,
  parseAgentMarkdown,
} from '../agents/agentRegistry'
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

// Directory entries are inferred from deeper keys (a key `<dir>/<file>` makes
// `<dir>` a directory dirent) so the recursive plugin walk can descend.
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
        out.push(
          makeDirent(firstSegment, entry?.kind === 'file' ? 'file' : 'dir'),
        )
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

describe('parseAgentMarkdown', () => {
  it('parses description, tools, model, and body system prompt', () => {
    const agent = parseAgentMarkdown({
      fallbackName: 'reviewer',
      rawContent:
        '---\ndescription: Reviews code\ntools: Read, Grep\nmodel: sonnet\n---\nYou are a careful reviewer.\n',
      source: 'plugin',
      pluginName: 'alpha',
    })
    expect(agent).not.toBeNull()
    expect(agent?.name).toBe('reviewer')
    expect(agent?.description).toBe('Reviews code')
    expect(agent?.tools).toEqual(['Read', 'Grep'])
    expect(agent?.model).toBe('sonnet')
    expect(agent?.systemPrompt).toBe('You are a careful reviewer.')
    expect(agent?.pluginName).toBe('alpha')
  })

  it('parses a disallowedTools denylist', () => {
    const agent = parseAgentMarkdown({
      fallbackName: 'readonly',
      rawContent:
        '---\ndescription: read only\ndisallowedTools: Edit, Write\n---\nNo writing.\n',
      source: 'plugin',
    })
    expect(agent?.disallowedTools).toEqual(['Edit', 'Write'])
    expect(agent?.tools).toBeUndefined()
  })

  it('prefers a frontmatter name over the filename fallback', () => {
    const agent = parseAgentMarkdown({
      fallbackName: 'file-name',
      rawContent: '---\nname: real-name\n---\nBody.\n',
      source: 'plugin',
    })
    expect(agent?.name).toBe('real-name')
  })

  it('returns null for an empty body', () => {
    const agent = parseAgentMarkdown({
      fallbackName: 'empty',
      rawContent: '---\ndescription: nothing\n---\n',
      source: 'plugin',
    })
    expect(agent).toBeNull()
  })
})

describe('buildAgentRegistry', () => {
  beforeEach(() => resetProcessFs())

  it('loads agents from a directory and drops empty-body files', async () => {
    installProcessFs(
      makeFakeFs({
        '/plugins/alpha/agents/reviewer.md': {
          kind: 'file',
          content: '---\ndescription: Reviews\n---\nReview prompt.\n',
        },
        '/plugins/alpha/agents/empty.md': {
          kind: 'file',
          content: '---\ndescription: none\n---\n',
        },
      }),
    )
    const agents = await buildAgentRegistry([
      { dirPath: '/plugins/alpha/agents', source: 'plugin', pluginName: 'alpha' },
    ])
    // Plugin agents are named `<pluginName>:<name>`; the empty-body file is
    // still dropped.
    expect(agents.map(a => a.name)).toEqual(['alpha:reviewer'])
  })

  it('resolves name collisions first-wins by source order', async () => {
    installProcessFs(
      makeFakeFs({
        '/u/agents/dup.md': {
          kind: 'file',
          content: '---\ndescription: user\n---\nUser body.\n',
        },
        '/p/agents/dup.md': {
          kind: 'file',
          content: '---\ndescription: plugin\n---\nPlugin body.\n',
        },
      }),
    )
    const agents = await buildAgentRegistry([
      { dirPath: '/u/agents', source: 'user' },
      { dirPath: '/p/agents', source: 'plugin', pluginName: 'alpha' },
    ])
    const dup = agents.find(a => a.name === 'dup')
    expect(dup?.source).toBe('user')
  })
})

describe('findAgentDefinition', () => {
  it('returns a definition only when it carries a systemPrompt', () => {
    const full = {
      name: 'a',
      description: 'd',
      systemPrompt: 'sp',
      source: 'plugin' as const,
    }
    expect(findAgentDefinition([full], 'a')?.systemPrompt).toBe('sp')
    expect(findAgentDefinition([{ name: 'b' }], 'b')).toBeUndefined()
    expect(findAgentDefinition([full], 'missing')).toBeUndefined()
  })
})

describe('loadLocalAgents', () => {
  beforeEach(() => resetProcessFs())

  function agentFile(description: string): FakeEntry {
    return { kind: 'file', content: `---\ndescription: ${description}\n---\nBody.\n` }
  }

  it('loads project agents from <cwd>/.velloc/agents', async () => {
    installProcessFs(
      makeFakeFs({
        '/workspace/.velloc/agents/reviewer.md': agentFile('Project reviewer'),
      }),
    )
    const agents = await loadLocalAgents({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
    })
    expect(agents.map(a => a.name)).toEqual(['reviewer'])
    expect(agents[0]?.source).toBe('project')
  })

  it('walks ~/.velloc/agents and ~/.claude/agents; .velloc wins collisions', async () => {
    installProcessFs(
      makeFakeFs({
        '/home/u/.velloc/agents/shared.md': agentFile('From nexus home'),
        '/home/u/.velloc/agents/only-nexus.md': agentFile('Only nexus'),
        '/home/u/.claude/agents/shared.md': agentFile('Shadowed'),
        '/home/u/.claude/agents/only-claude.md': agentFile('Only claude'),
      }),
    )
    const agents = await loadLocalAgents({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/u' } }),
    })
    expect(agents.map(a => a.name).sort()).toEqual([
      'only-claude',
      'only-nexus',
      'shared',
    ])
    const shared = agents.find(a => a.name === 'shared')
    expect(shared?.description).toBe('From nexus home')
    expect(shared?.source).toBe('user')
  })

  it('namespaces plugin agents so a same-named project agent no longer shadows them', async () => {
    installProcessFs(
      makeFakeFs({
        '/workspace/.velloc/agents/dup.md': agentFile('Project copy'),
        '/plugins/alpha/agents/dup.md': agentFile('Plugin copy'),
        '/plugins/alpha/agents/only-plugin.md': agentFile('Only plugin'),
      }),
    )
    const agents = await loadLocalAgents({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      pluginAgentDirs: [{ dirPath: '/plugins/alpha/agents', pluginName: 'alpha' }],
    })
    const dup = agents.find(a => a.name === 'dup')
    expect(dup?.source).toBe('project')
    expect(dup?.description).toBe('Project copy')
    // Plugin agents are named `<pluginName>:<name>`, so both the former
    // collision and the unique agent surface.
    expect(agents.map(a => a.name).sort()).toEqual([
      'alpha:dup',
      'alpha:only-plugin',
      'dup',
    ])
    expect(agents.find(a => a.name === 'alpha:dup')?.description).toBe(
      'Plugin copy',
    )
  })

  it('recurses plugin agents/ subdirectories; frontmatter name is the base segment', async () => {
    installProcessFs(
      makeFakeFs({
        '/plugins/alpha/agents/team/reviewer.md': {
          kind: 'file',
          content:
            '---\nname: reviewer-pro\ndescription: Nested reviewer\n---\nBody.\n',
        },
      }),
    )
    const agents = await loadLocalAgents({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      pluginAgentDirs: [{ dirPath: '/plugins/alpha/agents', pluginName: 'alpha' }],
    })
    // A frontmatter `name` replaces only the BASE segment; the plugin prefix
    // and directory namespace still apply.
    expect(agents.map(a => a.name)).toEqual(['alpha:team:reviewer-pro'])
    expect(agents[0]?.pluginName).toBe('alpha')
  })

  it('returns an empty list when no agent dirs exist', async () => {
    installProcessFs(makeFakeFs({}))
    const agents = await loadLocalAgents({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/u' } }),
    })
    expect(agents).toEqual([])
  })
})
