import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { buildConditionalRuleInjection } from '../memory/conditionalRuleInjection'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFsEntry,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'

function makeDirent(name: string, kind: 'file' | 'dir'): RuntimeFsEntry {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  }
}

function makeFs(tree: Record<string, string>): RuntimeFs {
  return {
    ...unconfiguredFs,
    async readFile(path: string): Promise<string> {
      if (path in tree) return tree[path]!
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const seen = new Set<string>()
      const out: RuntimeFsEntry[] = []
      let anyMatch = false
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        anyMatch = true
        const firstSeg = key.slice(prefix.length).split('/')[0]!
        if (!firstSeg || seen.has(firstSeg)) continue
        seen.add(firstSeg)
        const fullChild = `${prefix}${firstSeg}`
        out.push(makeDirent(firstSeg, fullChild in tree ? 'file' : 'dir'))
      }
      if (!anyMatch) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return out
    },
  } as RuntimeFs
}

const rc: RuntimeConfig = {
  getEnv: () => undefined,
  flagOn: () => false,
  now: () => 1_700_000_000_000,
  createUUID: () => 'uuid',
  createTimestamp: () => '2026-05-13T00:00:00.000Z',
  getMaxStructuredOutputRetries: () => 5,
}

const STYLE_RULE = '/home/user/project/.velloc/rules/style.md'
const base = {
  projectRoot: '/home/user/project',
  homeDir: '/home/user',
  runtimeConfig: rc,
}

afterEach(() => {
  resetProcessFs()
})

describe('buildConditionalRuleInjection (out-of-band dedup)', () => {
  it('returns null when no files were read', async () => {
    installProcessFs(makeFs({ [STYLE_RULE]: '---\npaths: src/**\n---\nbody' }))
    const out = await buildConditionalRuleInjection({
      ...base,
      readPaths: [],
      loadedNestedMemoryPaths: new Set(),
    })
    expect(out).toBeNull()
  })

  it('injects a matching rule as a system-reminder (no in-message marker)', async () => {
    installProcessFs(
      makeFs({ [STYLE_RULE]: '---\npaths: src/**\n---\nstyle rule body' }),
    )
    const out = await buildConditionalRuleInjection({
      ...base,
      readPaths: ['/home/user/project/src/a.ts'],
      loadedNestedMemoryPaths: new Set(),
    })
    expect(out).not.toBeNull()
    expect(out).toContain('<system-reminder>')
    expect(out).toContain(`Contents of ${STYLE_RULE}:`)
    expect(out).toContain('style rule body')
    // Out-of-band dedup → NO marker comment leaks into the model context.
    expect(out).not.toContain('nexus:conditional-rules')
    expect(out).not.toContain('<!--')
  })

  it('records the injected rule in loadedNestedMemoryPaths', async () => {
    installProcessFs(
      makeFs({ [STYLE_RULE]: '---\npaths: src/**\n---\nstyle rule body' }),
    )
    const surfaced = new Set<string>()
    await buildConditionalRuleInjection({
      ...base,
      readPaths: ['/home/user/project/src/a.ts'],
      loadedNestedMemoryPaths: surfaced,
    })
    expect(surfaced.has(STYLE_RULE)).toBe(true)
  })

  it('does not re-inject a rule already in loadedNestedMemoryPaths (dedup)', async () => {
    installProcessFs(
      makeFs({ [STYLE_RULE]: '---\npaths: src/**\n---\nstyle rule body' }),
    )
    const out = await buildConditionalRuleInjection({
      ...base,
      readPaths: ['/home/user/project/src/a.ts'],
      loadedNestedMemoryPaths: new Set([STYLE_RULE]),
    })
    expect(out).toBeNull()
  })

  it('re-injects after the dedup set is cleared (compaction-reset behavior)', async () => {
    installProcessFs(
      makeFs({ [STYLE_RULE]: '---\npaths: src/**\n---\nstyle rule body' }),
    )
    const surfaced = new Set<string>()
    const readPaths = ['/home/user/project/src/a.ts']

    // First read → injects + records.
    const first = await buildConditionalRuleInjection({
      ...base,
      readPaths,
      loadedNestedMemoryPaths: surfaced,
    })
    expect(first).not.toBeNull()

    // Same read again → deduped (already surfaced).
    const second = await buildConditionalRuleInjection({
      ...base,
      readPaths,
      loadedNestedMemoryPaths: surfaced,
    })
    expect(second).toBeNull()

    // Compaction clears the set → a re-read re-injects (rule was compacted out).
    surfaced.clear()
    const third = await buildConditionalRuleInjection({
      ...base,
      readPaths,
      loadedNestedMemoryPaths: surfaced,
    })
    expect(third).not.toBeNull()
  })

  it('returns null when the read path does not match any rule glob', async () => {
    installProcessFs(
      makeFs({ [STYLE_RULE]: '---\npaths: src/**\n---\nstyle rule body' }),
    )
    const out = await buildConditionalRuleInjection({
      ...base,
      readPaths: ['/home/user/project/docs/readme.md'],
      loadedNestedMemoryPaths: new Set(),
    })
    expect(out).toBeNull()
  })
})

describe('buildConditionalRuleInjection — nested instruction files', () => {
  const P = '/home/user/project'
  const read = (readPaths: string[], surfaced = new Set<string>(), extra: Record<string, unknown> = {}) =>
    buildConditionalRuleInjection({ ...base, readPaths, loadedNestedMemoryPaths: surfaced, ...extra })

  it("a read under a subdirectory attaches that directory's AGENTS.md, and each directory's on the way, parent first", async () => {
    installProcessFs(
      makeFs({
        [`${P}/AGENTS.md`]: 'ROOT_TEXT',
        [`${P}/pkg/AGENTS.md`]: 'PKG_TEXT',
        [`${P}/pkg/sub/AGENTS.md`]: 'SUB_TEXT',
        [`${P}/pkg/sub/file.ts`]: 'code',
      }),
    )
    const out = await read([`${P}/pkg/sub/file.ts`])
    expect(out).toContain(`Contents of ${P}/pkg/AGENTS.md:\n\nPKG_TEXT`)
    expect(out).toContain(`Contents of ${P}/pkg/sub/AGENTS.md:\n\nSUB_TEXT`)
    expect(out!.indexOf('PKG_TEXT')).toBeLessThan(out!.indexOf('SUB_TEXT'))
    // The root's file is the eager load's, not the read's.
    expect(out).not.toContain('ROOT_TEXT')
  })

  it('reads the same slots as the eager walk: CLAUDE.md where there is no AGENTS.md, AGENTS.md alone where both are', async () => {
    installProcessFs(
      makeFs({
        [`${P}/a/CLAUDE.md`]: 'A_FALLBACK',
        [`${P}/a/b/AGENTS.md`]: 'B_AGENTS',
        [`${P}/a/b/CLAUDE.md`]: 'B_FALLBACK',
        [`${P}/a/b/.claude/CLAUDE.md`]: 'B_DOT_DIR',
        [`${P}/a/b/CLAUDE.local.md`]: 'B_LOCAL',
      }),
    )
    const out = await read([`${P}/a/b/x.ts`])
    expect(out).toContain('A_FALLBACK')
    expect(out).toContain('B_AGENTS')
    expect(out).not.toContain('B_FALLBACK\n')
    expect(out).toContain('B_DOT_DIR')
    expect(out).toContain('B_LOCAL')
  })

  it('attaches a file once per session, and again after the dedup set is cleared (compaction)', async () => {
    installProcessFs(makeFs({ [`${P}/pkg/AGENTS.md`]: 'PKG_TEXT' }))
    const surfaced = new Set<string>()
    expect(await read([`${P}/pkg/one.ts`], surfaced)).toContain('PKG_TEXT')
    expect(surfaced.has(`${P}/pkg/AGENTS.md`)).toBe(true)
    expect(await read([`${P}/pkg/two.ts`], surfaced)).toBeNull()
    surfaced.clear()
    expect(await read([`${P}/pkg/two.ts`], surfaced)).toContain('PKG_TEXT')
  })

  it('a read OF the instruction file is its own delivery: not attached, and not attached later beside it', async () => {
    installProcessFs(makeFs({ [`${P}/pkg/AGENTS.md`]: 'PKG_TEXT' }))
    const surfaced = new Set<string>()
    expect(await read([`${P}/pkg/AGENTS.md`], surfaced)).toBeNull()
    expect(await read([`${P}/pkg/other.ts`], surfaced)).toBeNull()
  })

  it('a file at the project root, or outside it, attaches nothing', async () => {
    installProcessFs(makeFs({ [`${P}/AGENTS.md`]: 'ROOT_TEXT', '/elsewhere/pkg/AGENTS.md': 'OUTSIDE' }))
    expect(await read([`${P}/README.md`])).toBeNull()
    expect(await read(['/elsewhere/pkg/x.ts'])).toBeNull()
  })

  it('Windows spellings: a backslashed read under a drive-letter root still finds the directory', async () => {
    installProcessFs(makeFs({ 'D:\\repo\\pkg\\AGENTS.md': 'WIN_PKG' }))
    const out = await read(['D:\\repo\\pkg\\x.ts'], new Set(), { projectRoot: 'D:\\repo' })
    expect(out).toContain('WIN_PKG')
  })

  it('under a read boundary the walk anchors at the root and reads nothing outside it', async () => {
    installProcessFs(
      makeFs({
        [`${P}/wt/pkg/AGENTS.md`]: 'IN_ROOT',
        [`${P}/pkg/AGENTS.md`]: 'CANONICAL',
      }),
    )
    const out = await read([`${P}/wt/pkg/x.ts`], new Set(), { readRoot: `${P}/wt` })
    expect(out).toContain('IN_ROOT')
    expect(await read([`${P}/pkg/x.ts`], new Set(), { readRoot: `${P}/wt` })).toBeNull()
  })

  it('a nested file\'s @include of a file the prompt already carries is not injected a second time', async () => {
    installProcessFs(
      makeFs({
        [`${P}/AGENTS.md`]: 'ROOT_TEXT',
        [`${P}/pkg/AGENTS.md`]: `PKG_TEXT\n@${P}/AGENTS.md`,
      }),
    )
    // Unaware of the eager load, the include climbs back up and re-delivers it…
    expect(await read([`${P}/pkg/x.ts`])).toContain('ROOT_TEXT')
    // …told what the prompt holds (a spelling that differs only by slashes
    // and drive case still counts), it does not — and the nested file itself is.
    const out = await read([`${P}/pkg/x.ts`], new Set(), {
      promptInstructionPaths: new Set([`${P}/AGENTS.md/`]),
    })
    expect(out).toContain('PKG_TEXT')
    expect(out).not.toContain('ROOT_TEXT')
  })

  it('prompt-carried files stay excluded after the dedup set is cleared (compaction)', async () => {
    installProcessFs(
      makeFs({
        [`${P}/AGENTS.md`]: 'ROOT_TEXT',
        [`${P}/pkg/AGENTS.md`]: `PKG_TEXT\n@${P}/AGENTS.md`,
      }),
    )
    const surfaced = new Set<string>()
    const promptInstructionPaths = new Set([`${P}/AGENTS.md`])
    await read([`${P}/pkg/x.ts`], surfaced, { promptInstructionPaths })
    surfaced.clear()
    const again = await read([`${P}/pkg/y.ts`], surfaced, { promptInstructionPaths })
    expect(again).toContain('PKG_TEXT')
    expect(again).not.toContain('ROOT_TEXT')
  })

  it('files read side by side share one walk: a shared directory is read once, not once per file', async () => {
    const tree = {
      [`${P}/pkg/AGENTS.md`]: 'PKG_TEXT',
      [`${P}/pkg/a/AGENTS.md`]: 'A_TEXT',
      [`${P}/pkg/b/AGENTS.md`]: 'B_TEXT',
    }
    const reads = (paths: string[]) => {
      const counts = new Map<string, number>()
      const fs = makeFs(tree)
      const readFile = fs.readFile.bind(fs)
      ;(fs as { readFile: RuntimeFs['readFile'] }).readFile = (async (
        path: string,
        options: { encoding: string },
      ) => {
        counts.set(path, (counts.get(path) ?? 0) + 1)
        return readFile(path, options)
      }) as RuntimeFs['readFile']
      installProcessFs(fs)
      return read(paths).then(out => ({ out, counts }))
    }
    const one = await reads([`${P}/pkg/a/x.ts`])
    const two = await reads([`${P}/pkg/a/x.ts`, `${P}/pkg/b/y.ts`])
    // The ancestor `pkg` costs the same with two reads as with one…
    expect(two.counts.get(`${P}/pkg/AGENTS.md`)).toBe(one.counts.get(`${P}/pkg/AGENTS.md`))
    // …and the answer still holds each directory's file exactly once.
    for (const text of ['PKG_TEXT', 'A_TEXT', 'B_TEXT']) {
      expect(two.out!.split(text).length - 1).toBe(1)
    }
  })

  it('a legacy VELLOC.md in a subdirectory attaches only where nothing newer is', async () => {
    installProcessFs(
      makeFs({
        [`${P}/old/VELLOC.md`]: 'OLD_ONLY',
        [`${P}/both/AGENTS.md`]: 'BOTH_NEW',
        [`${P}/both/VELLOC.md`]: 'BOTH_OLD',
      }),
    )
    expect(await read([`${P}/old/x.ts`])).toContain('OLD_ONLY')
    const both = await read([`${P}/both/x.ts`])
    expect(both).toContain('BOTH_NEW')
    expect(both).not.toContain('BOTH_OLD')
  })

  it('nested files come before the path-scoped rules', async () => {
    installProcessFs(
      makeFs({
        [STYLE_RULE]: '---\npaths: src/**\n---\nSTYLE_BODY',
        [`${P}/src/AGENTS.md`]: 'SRC_AGENTS',
      }),
    )
    const out = await read([`${P}/src/a.ts`])
    expect(out!.indexOf('SRC_AGENTS')).toBeGreaterThan(-1)
    expect(out!.indexOf('SRC_AGENTS')).toBeLessThan(out!.indexOf('STYLE_BODY'))
  })
})
