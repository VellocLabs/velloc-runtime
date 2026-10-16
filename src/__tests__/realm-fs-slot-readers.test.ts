/**
 * Session-scoped fs readers never read the realm-global `processFs()` slot (last-writer-wins across all runtimes in
 * the SharedWorker). Each test installs a disposed fs in the slot and hands the reader the session's own; the source
 * guard at the bottom pins the plumbing-only call sites.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  unconfiguredFs,
  fsForContext,
  installProcessFs,
  resetProcessFs,
  type RuntimeFsEntry,
  type RuntimeFs,
  type RuntimeFsStat,
} from '../utils/fs/runtimeFs'
import {
  copyPlanFileForFork,
  ensurePlanDirectoryExists,
  getPlanFilePathForSession,
  planFileExists,
} from '../utils/planFiles'
import { resolvePlanText } from '../permissions/planApproval'
import { discoverInstructionFiles, gatherInstructionDocs } from '../memory/instructionFiles'
import { buildMemorySystemPrompt } from '../memory/memoryPrompt'
import { listMemoryFiles } from '../memory/memoryManifest'
import { loadRecallNotes } from '../memory/relevantRecall'
import {
  lastTidyStamp,
  stampTidyDone,
  claimTidyLease,
} from '../memory/consolidate/runLock'
import {
  enabledModelsFor,
  loadProviderTrustMap,
  resolveChildProvider,
} from '../team/sessionTrust'
import { surveyProviderCatalog } from '../team/providerCatalog'
import { wipeSettingsMemos } from '../settings/settingsStore'
import * as webFetch from '../toolkit/builtin/webFetch/fetchHelpers'
import { loadLocalPromptCommands } from '../skillLibrary/skillDiscovery'
import { loadLocalAgents } from '../agents/agentRegistry'
import { visitMarkdownFiles } from '../pluginHost/markdownTree'
import { gatherPlugins } from '../pluginHost/loadPlugins'
import {
  loadEffectiveEnabledPlugins,
  patchEnabledPlugin,
  saveEnabledPlugins,
} from '../pluginHost/enabledStore'
import { getEnabledPluginsConfigPath } from '../pluginHost/pluginPaths'
import {
  copyLocalPluginDirectory,
  mkdirParents,
} from '../input/pluginInstallCommands'
import { loadMCPConfig, saveMCPConfig } from '../mcp/config'
import { getStoredTokens, setStoredTokens } from '../mcp/auth'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { engineWorld } from './engine-replay/harness/world'
import { memoryFs } from './engine-replay/harness/fs'

const DISPOSED = 'Runtime scope was disposed.'

/** What the slot holds after the runtime that wrote it last was disposed. */
const disposedFs = new Proxy({} as RuntimeFs, {
  get: () => () => {
    throw new Error(DISPOSED)
  },
})

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
}

function fileStat(size: number, mtimeMs: number, dir = false): RuntimeFsStat {
  return {
    size,
    mtimeMs,
    isFile: () => !dir,
    isDirectory: () => dir,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isCharacterDevice: () => false,
    isBlockDevice: () => false,
  } as RuntimeFsStat
}

/** In-memory session fs: files by absolute path; directories are implicit. */
function sessionFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const dirs = new Set<string>()
  const isDir = (path: string) => {
    const prefix = path.endsWith('/') ? path : `${path}/`
    return dirs.has(path) || [...files.keys()].some(k => k.startsWith(prefix))
  }
  const fs: RuntimeFs = {
    ...unconfiguredFs,
    async readFile(path) {
      const hit = files.get(path)
      if (hit === undefined) throw enoent(path)
      return hit
    },
    readFileSync(path) {
      const hit = files.get(path)
      if (hit === undefined) throw enoent(path)
      return hit
    },
    async writeFile(path, content) {
      files.set(
        path,
        typeof content === 'string' ? content : new TextDecoder().decode(content),
      )
    },
    async mkdir(path) {
      dirs.add(path.replace(/\/+$/, ''))
    },
    async unlink(path) {
      files.delete(path)
    },
    async stat(path) {
      const hit = files.get(path)
      if (hit !== undefined) return fileStat(hit.length, 1_000)
      if (isDir(path)) return fileStat(0, 1_000, true)
      throw enoent(path)
    },
    existsSync(path) {
      return files.has(path) || isDir(path)
    },
    async readdir(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const seen = new Map<string, RuntimeFsEntry>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const [first, ...rest] = key.slice(prefix.length).split('/')
        if (!first || seen.has(first)) continue
        const dir = rest.length > 0
        seen.set(first, {
          name: first,
          isFile: () => !dir,
          isDirectory: () => dir,
          isSymbolicLink: () => false,
        })
      }
      if (seen.size === 0 && !isDir(path)) throw enoent(path)
      return [...seen.values()]
    },
  } as RuntimeFs
  return { fs, files }
}

function makeRuntimeConfig(env: Record<string, string> = {}): RuntimeConfig {
  return {
    getEnv: (name: string) => env[name],
    flagOn: (name: string) => {
      const v = env[name]
      return v === '1' || v === 'true' || v === 'yes'
    },
    now: () => 1_700_000_000_000,
    createUUID: () => 'uuid',
    createTimestamp: () => '2026-09-27T00:00:00.000Z',
    getMaxStructuredOutputRetries: () => 5,
  }
}

function ctx(options: Record<string, unknown>): ToolCallContext {
  return { options } as unknown as ToolCallContext
}

beforeEach(() => {
  installProcessFs(disposedFs)
  wipeSettingsMemos()
})

afterEach(() => {
  resetProcessFs()
  wipeSettingsMemos()
})

describe('fsForContext', () => {
  it("returns the context's own fs over the realm-global slot", () => {
    const { fs } = sessionFs()
    expect(fsForContext(ctx({ fsOperations: fs }))).toBe(fs)
  })

  it('falls back to the slot only when the context carries no fs', () => {
    expect(fsForContext(ctx({}))).toBe(disposedFs)
  })
})

describe('plan files', () => {
  const cwd = '/work'
  const sessionId = 's-1'
  const planPath = getPlanFilePathForSession(cwd, sessionId)

  it('planFileExists sees the plan on the session fs', async () => {
    const { fs } = sessionFs({ [planPath]: '# plan' })
    await expect(
      planFileExists(ctx({ cwd, sessionId, fsOperations: fs })),
    ).resolves.toBe(true)
  })

  it('ensurePlanDirectoryExists creates the dir on the session fs', async () => {
    const { fs } = sessionFs()
    const mkdirs: string[] = []
    const recording = { ...fs, mkdir: async (p: string) => void mkdirs.push(p) }
    await ensurePlanDirectoryExists(
      ctx({ cwd, sessionId, fsOperations: recording }),
    )
    expect(mkdirs).toHaveLength(1)
  })

  it('resolvePlanText reads the existing plan through the session fs', async () => {
    const { fs } = sessionFs({ [planPath]: '# the plan' })
    await expect(
      resolvePlanText(ctx({ cwd, sessionId, fsOperations: fs }), {}),
    ).resolves.toBe('# the plan')
  })

  it('copyPlanFileForFork copies through the fork runtime fs', async () => {
    const { fs, files } = sessionFs({ [planPath]: '# carried' })
    await expect(copyPlanFileForFork(cwd, sessionId, 's-2', fs)).resolves.toBe(
      true,
    )
    expect(files.get(getPlanFilePathForSession(cwd, 's-2'))).toBe('# carried')
  })
})

describe('instruction files and memory', () => {
  it('gatherInstructionDocs loads AGENTS.md through the session fs', async () => {
    const { fs } = sessionFs({ '/home/u/.velloc/AGENTS.md': 'user-tier rules' })
    const found = await gatherInstructionDocs({
      cwd: '/home/u/project',
      homeDir: '/home/u',
      fs,
      runtimeConfig: makeRuntimeConfig({ VELLOC_MEMORY: 'off' }),
    })
    expect(found.map(f => f.content).join('\n')).toContain('user-tier rules')
  })

  it('discoverInstructionFiles walks the caller fs', async () => {
    const { fs } = sessionFs({ '/home/u/.velloc/AGENTS.md': 'x' })
    const found = await discoverInstructionFiles({
      cwd: '/home/u/project',
      homeDir: '/home/u',
      fs,
    })
    expect(found.length).toBeGreaterThan(0)
  })

  it('buildMemorySystemPrompt resolves and creates the memory dir on the session fs', async () => {
    const { fs } = sessionFs()
    const mkdirs: string[] = []
    const recording = { ...fs, mkdir: async (p: string) => void mkdirs.push(p) }
    const prompt = await buildMemorySystemPrompt({
      cwd: '/home/u/project',
      projectRoot: '/home/u/project',
      homeDir: '/home/u',
      fs: recording,
      runtimeConfig: makeRuntimeConfig(),
    })
    expect(prompt).toBeTruthy()
    expect(mkdirs.length).toBeGreaterThan(0)
  })

  it('listMemoryFiles and loadRecallNotes read the session fs', async () => {
    const { fs } = sessionFs({
      '/mem/topic.md': '---\nname: topic\ndescription: a topic\n---\nbody text',
    })
    const headers = await listMemoryFiles('/mem', new AbortController().signal, fs)
    expect(headers.map(h => h.filePath)).toContain('/mem/topic.md')

    const surfaced = await loadRecallNotes(
      [{ path: '/mem/topic.md', mtimeMs: 1_000 }],
      fs,
    )
    expect(surfaced).toHaveLength(1)
    expect(surfaced[0]!.content).toContain('body text')
  })

  it('the periodic-tidy consolidation lock round-trips on the session fs', async () => {
    const { fs } = sessionFs()
    await expect(claimTidyLease('/mem', 'holder', fs)).resolves.toBe(0)
    await stampTidyDone('/mem', fs)
    await expect(lastTidyStamp('/mem', fs)).resolves.toBeGreaterThan(0)
  })
})

describe('team provider trust', () => {
  const settingsJson = JSON.stringify({
    version: 1,
    providers: {
      activeProviderId: 'anthropic',
      configs: { anthropic: { apiKey: 'k', enabledModels: ['m-1'] } },
    },
  })

  it('resolveChildProvider / enabledModelsFor / loadProviderTrustMap read the session fs', async () => {
    const { fs } = sessionFs({ '/home/u/.velloc/settings.json': settingsJson })
    const child = await resolveChildProvider('/home/u', undefined, undefined, fs)
    expect(child).toMatchObject({ providerId: 'anthropic', known: true })
    await expect(enabledModelsFor('/home/u', 'anthropic', fs)).resolves.toEqual([
      'm-1',
    ])
    const trust = await loadProviderTrustMap('/home/u', fs)
    expect(trust('anthropic')).toBe('trusted')
  })

  it('surveyProviderCatalog reads settings through the context fs', async () => {
    const { fs } = sessionFs({ '/home/u/.velloc/settings.json': settingsJson })
    const catalog = await surveyProviderCatalog(
      ctx({ homeDir: '/home/u', fsOperations: fs }),
    )
    expect(catalog.providers.map(p => p.id)).toContain('anthropic')
  })
})

describe('WebFetch persistence', () => {
  it('writes the overflow markdown through deps.fs', async () => {
    const { fs, files } = sessionFs()
    const longHtml = `<html><body>${'<p>word word word</p>'.repeat(20_000)}</body></html>`
    webFetch.forgetFetchedPages()
    const result = await webFetch.capturePageAsMarkdown(
      'https://example.test/realm-slot',
      new AbortController(),
      {
        network: {
          httpGet: async () => ({
            status: 200,
            statusText: 'OK',
            finalUrl: 'https://example.test/realm-slot',
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: new TextEncoder().encode(longHtml),
          }),
        } as never,
        runtimeCwd: '/work',
        fs,
      },
    )
    if ('type' in result) throw new Error('unexpected redirect')
    expect(result.overflowMarkdownPath).toMatch(/^\/work\/webfetch\//)
    expect(files.has(result.overflowMarkdownPath!)).toBe(true)
  })
})

describe('boot-time loaders (skills, agents, plugins, MCP)', () => {
  const proj = '/proj'
  const dot = `${proj}/${RUNTIME_DIR_NAME}`

  it('loadLocalPromptCommands reads skills through params.fs', async () => {
    const { fs } = sessionFs({
      [`${dot}/skills/hello/SKILL.md`]:
        '---\ndescription: says hello\n---\nSay hello.',
    })
    const commands = await loadLocalPromptCommands({
      cwd: proj,
      runtimeConfig: makeRuntimeConfig(),
      includeBundled: false,
      fs,
    })
    expect(commands.map(c => c.name)).toContain('hello')
  })

  it('loadLocalAgents reads agents (incl. plugin trees) through params.fs', async () => {
    const { fs } = sessionFs({
      [`${dot}/agents/helper.md`]: '---\ndescription: helps\n---\nHelp.',
      '/plug/agents/team/rev.md': '---\ndescription: reviews\n---\nReview.',
    })
    const agents = await loadLocalAgents({
      cwd: proj,
      runtimeConfig: makeRuntimeConfig(),
      pluginAgentDirs: [{ dirPath: '/plug/agents', pluginName: 'p' }],
      fs,
    })
    expect(agents.map(a => a.name)).toEqual(
      expect.arrayContaining(['helper', 'p:team:rev']),
    )
  })

  it('visitMarkdownFiles walks opts.fs', async () => {
    const { fs } = sessionFs({ '/plug/commands/a.md': 'x' })
    const seen: string[] = []
    await visitMarkdownFiles('/plug/commands', async (p: string) => void seen.push(p), {
      fs,
    })
    expect(seen).toEqual(['/plug/commands/a.md'])
  })

  it('gatherPlugins discovers and loads plugins through params.fs', async () => {
    const { fs } = sessionFs({
      [`${dot}/plugins/p1/.claude-plugin/plugin.json`]: JSON.stringify({
        name: 'p1',
      }),
      [`${dot}/plugins/p1/commands/go.md`]: 'go',
    })
    const result = await gatherPlugins({
      cwd: proj,
      runtimeConfig: makeRuntimeConfig(),
      enabledPlugins: ['p1'],
      fs,
    })
    expect(result.errors).toEqual([])
    expect(result.enabled.map(p => p.name)).toEqual(['p1'])
  })

  it('the enabled-plugins store reads and writes through the passed fs', async () => {
    const { fs, files } = sessionFs()
    await saveEnabledPlugins(proj, ['a'], fs)
    await expect(patchEnabledPlugin(proj, 'b', true, fs)).resolves.toEqual([
      'a',
      'b',
    ])
    expect(files.has(getEnabledPluginsConfigPath(proj))).toBe(true)
    await expect(
      loadEffectiveEnabledPlugins({ cwd: proj, fs }),
    ).resolves.toEqual(['a', 'b'])
  })

  it('plugin install copies through the passed fs', async () => {
    const { fs, files } = sessionFs({
      '/src/p/.claude-plugin/plugin.json': '{"name":"p"}',
      '/src/p/commands/x.md': 'x',
    })
    await mkdirParents('/dst/deep/dir', fs)
    await expect(copyLocalPluginDirectory('/src/p', '/dst/p', fs)).resolves.toBe(
      true,
    )
    expect(files.get('/dst/p/commands/x.md')).toBe('x')
  })

  it('MCP config and auth tokens round-trip through the passed fs', async () => {
    const { fs } = sessionFs()
    await saveMCPConfig(
      proj,
      { srv: { type: 'http', url: 'https://mcp.example.test/' } },
      fs,
    )
    const configs = await loadMCPConfig(proj, fs)
    expect(configs.map(c => c.name)).toEqual(['srv'])
    await setStoredTokens(proj, 'srv', { access_token: 't' } as never, fs)
    await expect(getStoredTokens(proj, 'srv', fs)).resolves.toMatchObject({
      access_token: 't',
    })
  })
})

describe('no realm-slot reads on session paths (source guard)', () => {
  // Call sites whose only seam is plumbing (runtime boot, the per-session
  // worker coordinators, tool bodies). A bare `processFs()` here
  // reads whichever runtime wrote the slot last; the accepted forms are the
  // session's own fs, or a fallback spelled `?? processFs()` /
  // a `= processFs()` default parameter for minimal/test callers.
  const FILES = [
    'browser/runtime/createAgentRuntime.ts',
    'browser/worker/AgentPermissionCoordinator.ts',
    'browser/worker/AgentModelController.ts',
    'browser/worker/AgentRuntimeRecovery.ts',
    'toolkit/builtin/notebookEdit.ts',
    'toolkit/builtin/planExit.ts',
    'toolkit/builtin/superEdit.ts',
    'toolkit/builtin/subagentLaunch.ts',
    'toolkit/builtin/team/spawnTeammate.ts',
    'toolkit/builtin/webFetch/fetchHelpers.ts',
    'toolkit/run/executeToolCall.ts',
    'team/providerCatalog.ts',
    'memory/extract/extractionRunner.ts',
    'memory/consolidate/consolidationRunner.ts',
    'skillLibrary/builtin/batchSkill.ts',
    'utils/planFiles.ts',
    'permissions/planApproval.ts',
    'input/debugCommands.ts',
    'input/runSlashCommand.ts',
    'memory/relevantRecall.ts',
  ]

  it.each(FILES)('%s', file => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8')
    const bare = src
      .split(/\r?\n/)
      .filter(line => line.includes('processFs()'))
      .filter(line => !/^\s*(\*|\/\/)/.test(line))
      .filter(line => !line.includes('?? processFs()'))
      .filter(line => !/:\s*RuntimeFs\s*=\s*processFs\(\),?\s*$/.test(line))
    expect(bare).toEqual([])
  })

  it("the lead's trust check passes the session fs", () => {
    const src = readFileSync(join(__dirname, '..', 'toolkit/builtin/teamTools.ts'), 'utf8')
    expect(src).toMatch(
      /context\.options\.userSpecifiedProviderId,\s*fsForContext\(context\),/,
    )
  })

  it('runtime boot hands installedFs to every loader it calls', () => {
    const src = readFileSync(
      join(__dirname, '..', 'browser/runtime/createAgentRuntime.ts'),
      'utf8',
    )
    for (const loader of [
      'loadEffectiveEnabledPlugins',
      'loadPluginContributions',
      'loadLocalAgents',
      'loadLocalPromptCommands',
    ]) {
      const calls = src.split(`${loader}({`).slice(1)
      expect(calls.length, loader).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.slice(0, 200), loader).toContain('fs: installedFs,')
      }
    }
    expect(src.match(/loadMarketplaceInstallState\(\{ homeDir \}, installedFs\)/g)).toHaveLength(2)
    expect(src).toMatch(/acquireSessionMCPPool\(\{[^}]*cwd: resolvedCwd,\s*fs: installedFs,/)
  })

  it('/plugins writes go through the session fs', () => {
    const src = readFileSync(
      join(__dirname, '..', 'input/runSlashCommand.ts'),
      'utf8',
    )
    // (`saveEnabledPlugins` is no longer called: every write patches.)
    for (const fn of [
      'patchEnabledPlugin',
      'patchUserEnabledPlugin',
      'loadEnabledPlugins',
      'copyLocalPluginDirectory',
      'mkdirParents',
    ]) {
      const calls = src.split(`await ${fn}(`).slice(1)
      expect(calls.length, fn).toBeGreaterThan(0)
      for (const call of calls) {
        const args = call.slice(0, call.indexOf(')\n'))
        expect(args, fn).toContain('fsForContext(params.context)')
      }
    }
  })

  it('the manager refreshes provider trust through its own fs', () => {
    const src = readFileSync(
      join(__dirname, '..', 'browser/worker/SharedWorkerSessionManager.ts'),
      'utf8',
    )
    expect(src).toMatch(
      /loadSessionTrustResolver\(\s*homeDir,\s*this\.bootServices\.getManagerFs\(\),?\s*\)/,
    )
  })
})

describe('a turn reads instructions and rules through the session fs', () => {
  afterEach(() => resetProcessFs())

  it('loads AGENTS.md into the prompt and a nested rule after a read, with a disposed slot', async () => {
    installProcessFs(disposedFs)
    const sessionFs = memoryFs(undefined, {
      '/workspace/AGENTS.md': 'Project rule: answer in one line.',
      '/workspace/pkg/AGENTS.md': 'Package rule: keep tabs.',
    })
    const w = engineWorld({
      config: { fsOperations: sessionFs },
      tools: [
        {
          name: 'Look',
          readOnly: true,
          // What the file-read tool records for a read: the path, so the
          // instruction files beside it reach the next request.
          during: context => context.nestedMemoryCues?.add('/workspace/pkg/a.ts'),
        },
      ],
      replies: [
        { label: 'read', calls: [{ id: 'look-1', name: 'Look' }] },
        { label: 'done', text: 'Done.' },
        { label: 'title', querySource: 'rename_generate_name', text: 'A title' },
      ],
    })
    await w.submit('look at the package')
    const trace = await w.finish()
    expect(JSON.stringify(trace.modelRequests[0])).toContain('Project rule: answer in one line.')
    expect(JSON.stringify(trace.modelRequests[0])).not.toContain('Package rule')
    expect(JSON.stringify(trace.modelRequests[1])).toContain('Package rule: keep tabs.')
  })
})
