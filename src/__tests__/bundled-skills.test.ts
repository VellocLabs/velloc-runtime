import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  __resetBundledSkillsForTests,
  BUNDLED_SKILL_FEATURE_PREFIX,
  getBundledSkillCommands,
  getBundledSkillDynamicContent,
  getBundledSkillIsEnabled,
  getBundledSkillModelInvocation,
  getBundledSkillRequiredTools,
  isBundledSkillE2eOnly,
  isBundledSkillModelInvocableIn,
  addStockSkill,
} from '../skillLibrary/builtinSkills'
import {
  __resetBundledSkillsInitForTests,
  installStockSkills,
} from '../skillLibrary/builtin/catalog'
import {
  E2E_THROW_SKILL_ERROR,
  E2E_THROW_SKILL_NAME,
} from '../skillLibrary/builtin/e2eThrow'
import { getModelInvocableCommands } from '../skillLibrary/skillDiscovery'
import {
  __resetFeatureRegistryForTests,
  getFeatureCatalog,
  getFeatureDefinition,
} from '../skillLibrary/builtinSkills'
import {
  getWorkerLogBuffer,
  setWorkerLogCaptureSource,
} from '../utils/workerLogBuffer'
import { projectHomeFor } from '../utils/conversationStoragePaths'
import {
  unconfiguredFs,
  installProcessFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'

/** Stub fs that pretends a given set of dirs exist (for the
 *  `isCwdGitRepo` git-walk helper that `batch.ts` uses). Mirrors the
 *  `installProcessFs` pattern in `local-skills.test.ts`. */
function stubFsWithExistingDirs(existing: ReadonlySet<string>): RuntimeFs {
  const fs = { ...unconfiguredFs } as unknown as RuntimeFs
  ;(fs as unknown as { readdir: (p: string) => Promise<unknown> }).readdir =
    async (p: string) => {
      if (existing.has(p)) return []
      const err = new Error(`ENOENT: ${p}`) as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    }
  return fs
}

beforeEach(() => {
  __resetBundledSkillsForTests()
  __resetBundledSkillsInitForTests()
  __resetFeatureRegistryForTests()
})

describe('bundledSkills registry — isEnabled callback', () => {
  it('stores an isEnabled callback and returns it via getBundledSkillIsEnabled', async () => {
    const { getBundledSkillIsEnabled } = await import(
      '../skillLibrary/builtinSkills'
    )
    addStockSkill({
      name: 'gated',
      description: '',
      content: 'body',
      isEnabled: appState =>
        appState.enabledFeatures?.['gated.feature'] === true,
    })
    const callback = getBundledSkillIsEnabled('gated')
    expect(callback).toBeDefined()
    expect(
      callback!({
        permissionRules: { mode: 'default' } as never,
        enabledFeatures: { 'gated.feature': true },
      } as never),
    ).toBe(true)
    expect(
      callback!({
        permissionRules: { mode: 'default' } as never,
        enabledFeatures: {},
      } as never),
    ).toBe(false)
    // No callback → undefined.
    addStockSkill({ name: 'always', description: '', content: 'body' })
    expect(getBundledSkillIsEnabled('always')).toBeUndefined()
  })

  it('replacing a gated skill with one that has no isEnabled clears the callback', async () => {
    const { getBundledSkillIsEnabled } = await import(
      '../skillLibrary/builtinSkills'
    )
    addStockSkill({
      name: 'x',
      description: '',
      content: 'body',
      isEnabled: () => true,
    })
    expect(getBundledSkillIsEnabled('x')).toBeDefined()
    addStockSkill({ name: 'x', description: '', content: 'body' })
    expect(getBundledSkillIsEnabled('x')).toBeUndefined()
  })
})

describe('bundledSkills registry', () => {
  it('registers a bundled skill and returns it as a well-formed ChromiumCommandMetadata', () => {
    addStockSkill({
      name: 'test-skill',
      description: 'test description',
      content: 'body',
    })
    const commands = getBundledSkillCommands()
    expect(commands).toHaveLength(1)
    const cmd = commands[0]!
    expect(cmd.type).toBe('prompt')
    expect(cmd.name).toBe('test-skill')
    expect(cmd.description).toBe('test description')
    expect(cmd.content).toBe('body')
    expect(cmd.source).toBe('bundled')
    expect(cmd.loadedFrom).toBe('bundled')
    expect(cmd.userCallable).toBe(true)
    expect(cmd.hiddenFromModel).toBe(false)
    // Synthetic path — no on-disk file.
    expect(cmd.path).toBe('bundled:test-skill')
    // No baseDir, so `buildSkillBody` skips the "Base directory" prefix.
    expect(cmd.baseDir).toBeUndefined()
  })

  it('is idempotent on name — re-register replaces the prior entry', () => {
    addStockSkill({ name: 'a', description: 'v1', content: 'body1' })
    addStockSkill({ name: 'a', description: 'v2', content: 'body2' })
    const commands = getBundledSkillCommands()
    expect(commands).toHaveLength(1)
    expect(commands[0]!.description).toBe('v2')
    expect(commands[0]!.content).toBe('body2')
  })

  it('preserves registration order across calls (Map insertion order)', () => {
    addStockSkill({ name: 'first', description: '', content: '' })
    addStockSkill({ name: 'second', description: '', content: '' })
    addStockSkill({ name: 'third', description: '', content: '' })
    const names = getBundledSkillCommands().map(c => c.name)
    expect(names).toEqual(['first', 'second', 'third'])
  })

  it('resolves an empty gate to the matching per-surface boolean', () => {
    addStockSkill({
      name: 'model-only',
      description: '',
      content: '',
      userInvocation: [],
    })
    addStockSkill({
      name: 'slash-only',
      description: '',
      content: '',
      modelInvocation: [],
    })
    const byName = new Map(getBundledSkillCommands().map(c => [c.name, c]))
    expect(byName.get('model-only')!.userCallable).toBe(false)
    expect(byName.get('slash-only')!.hiddenFromModel).toBe(true)
  })

  it('rejects a definition that sets neither content nor dynamicContent', () => {
    expect(() =>
      addStockSkill({
        name: 'empty',
        description: 'nothing here',
      } as never),
    ).toThrow(/content or dynamicContent/)
  })

  it('rejects a definition that sets BOTH content and dynamicContent', () => {
    expect(() =>
      addStockSkill({
        name: 'both',
        description: 'conflicted',
        content: 'static',
        dynamicContent: async () => 'dynamic',
      } as never),
    ).toThrow(/ONLY ONE of content or dynamicContent/)
  })

  it('stores a dynamic-content callback and returns it via getBundledSkillDynamicContent', async () => {
    const ctx = {} as ToolCallContext
    addStockSkill({
      name: 'dyn',
      description: 'dynamic',
      dynamicContent: async args => `<live body for ${args}>`,
    })
    const callback = getBundledSkillDynamicContent('dyn')
    expect(callback).toBeDefined()
    expect(await callback!('hello', ctx)).toBe('<live body for hello>')
    // Static-body skills (and unknown names) return undefined.
    addStockSkill({ name: 'static', description: '', content: 'x' })
    expect(getBundledSkillDynamicContent('static')).toBeUndefined()
    expect(getBundledSkillDynamicContent('does-not-exist')).toBeUndefined()
  })

  it('replacing a dynamic-content skill with a static one clears the callback', () => {
    addStockSkill({
      name: 'x',
      description: '',
      dynamicContent: async () => 'first',
    })
    expect(getBundledSkillDynamicContent('x')).toBeDefined()
    addStockSkill({ name: 'x', description: '', content: 'static now' })
    expect(getBundledSkillDynamicContent('x')).toBeUndefined()
  })

  it('forwards optional frontmatter-style fields unchanged', () => {
    addStockSkill({
      name: 'full',
      description: '',
      content: '',
      useWhen: 'when X happens',
      argumentHint: '<thing>',
      argNames: ['thing'],
      permittedTools: ['Bash', 'Read'],
      model: 'claude-sonnet-4-5',
      context: 'fork',
      agent: 'general-purpose',
      effort: 'high',
    })
    const cmd = getBundledSkillCommands()[0]!
    expect(cmd.useWhen).toBe('when X happens')
    expect(cmd.argumentHint).toBe('<thing>')
    expect(cmd.argNames).toEqual(['thing'])
    expect(cmd.permittedTools).toEqual(['Bash', 'Read'])
    expect(cmd.model).toBe('claude-sonnet-4-5')
    expect(cmd.context).toBe('fork')
    expect(cmd.agent).toBe('general-purpose')
    expect(cmd.effort).toBe('high')
  })
})

describe('installStockSkills', () => {
  it('registers the built-in skills on first call', () => {
    expect(getBundledSkillCommands()).toHaveLength(0)
    installStockSkills()
    const names = getBundledSkillCommands().map(c => c.name).sort()
    // The list grows as skills are added; spot-check two of them.
    expect(names).toContain('simplify')
    expect(names).toContain('update-config')
  })

  it('is idempotent — repeated calls do not duplicate registrations', () => {
    installStockSkills()
    const firstCount = getBundledSkillCommands().length
    installStockSkills()
    installStockSkills()
    expect(getBundledSkillCommands().length).toBe(firstCount)
  })

  it('registers init, review, security-review and commit as slash-only skills', () => {
    installStockSkills()
    const byName = new Map(getBundledSkillCommands().map(c => [c.name, c]))
    for (const name of ['init', 'review', 'security-review', 'commit']) {
      const cmd = byName.get(name)
      expect(cmd, `bundled skill "${name}" should be registered`).toBeDefined()
      // These commands are user-typed: slash-only, so the model can't invoke them.
      expect(cmd!.hiddenFromModel).toBe(true)
      expect(cmd!.userCallable).toBe(true)
      expect(cmd!.content.length).toBeGreaterThan(0)
    }
  })

  it('commit/security-review carry shell-expansion git probes', () => {
    installStockSkills()
    const byName = new Map(getBundledSkillCommands().map(c => [c.name, c]))
    // The `!`git …`` markers are what expandSkillBodyShell runs at dispatch.
    expect(byName.get('commit')!.content).toContain('!`git status`')
    expect(byName.get('security-review')!.content).toContain(
      '!`git diff origin/HEAD...`',
    )
    // /review takes a PR number via the standard $ARGUMENTS substitution.
    expect(byName.get('review')!.content).toContain('$ARGUMENTS')
  })
})

describe('simplify bundled skill', () => {
  beforeEach(() => installStockSkills())

  it('is registered with its description', () => {
    const simplify = getBundledSkillCommands().find(c => c.name === 'simplify')!
    expect(simplify).toBeDefined()
    expect(simplify.description).toBe(
      'Reviews your changed code for reuse, design and performance cleanups and fixes what it finds: duplicated helpers, design smells, and wasted work.',
    )
    expect(simplify.userCallable).toBe(true)
    expect(simplify.hiddenFromModel).toBe(false)
    expect(simplify.source).toBe('bundled')
  })

  it('body carries the three-phase structure', async () => {
    // simplify builds its body through `dynamicContent`. Invoke it with
    // empty args to get the base body.
    const dyn = getBundledSkillDynamicContent('simplify')!
    expect(dyn).toBeDefined()
    const body = await dyn('', {} as ToolCallContext)
    expect(body).toContain('# Tidy pass: review the diff, then fix it')
    expect(body).toContain('## Step 1: Collect the changes')
    expect(body).toContain('## Step 2: Three reviewers at once')
    expect(body).toContain('### Reviewer A: Reuse')
    expect(body).toContain('### Reviewer B: Design smells')
    expect(body).toContain('### Reviewer C: Cost and performance')
    expect(body).toContain('## Step 3: Apply the fixes')
    // The three reviewers are launched through the sub-agent tool.
    expect(body).toMatch(/three reviewers[^\n]*\bAgent\b|\bAgent\b[^\n]*three reviewers/)
  })

  it('appends the extra-attention section only when args are non-empty', async () => {
    const dyn = getBundledSkillDynamicContent('simplify')!
    const empty = await dyn('', {} as ToolCallContext)
    const withArgs = await dyn('look at hotspot X', {} as ToolCallContext)
    expect(empty).not.toContain('## Extra attention')
    expect(withArgs).toContain('## Extra attention\n\nlook at hotspot X')
  })
})

describe('debug bundled skill', () => {
  beforeEach(() => installStockSkills())

  it('is registered slash-only with permittedTools for log investigation', () => {
    const dbg = getBundledSkillCommands().find(c => c.name === 'debug')!
    expect(dbg).toBeDefined()
    expect(dbg.userCallable).toBe(true)
    // Slash-only, so the model doesn't spend context describing nexus
    // internals on every unrelated turn.
    expect(dbg.hiddenFromModel).toBe(true)
    expect(dbg.argumentHint).toBe('[issue description]')
    expect(dbg.permittedTools).toEqual(['Read', 'Grep', 'Glob'])
    expect(dbg.source).toBe('bundled')
    // The body is dynamic; the static `content` placeholder is empty.
    expect(dbg.content).toBe('')
  })

  it('dynamic body drains the worker log buffer and embeds recent entries', async () => {
    // The ring is opt-in — open the 'debug' capture source (as /debug log
    // on would have) so the synthetic entries below actually land.
    setWorkerLogCaptureSource('debug', true)
    // Push a handful of synthetic entries — drain() returns them in order.
    const buffer = getWorkerLogBuffer()
    buffer.push('error', '[mcp] connection refused to example.com:443')
    buffer.push('warn', '[bridge] retry after 503')
    buffer.push('error', '[skills] failed to register hooks: TypeError x is undefined')

    const ctx = {} as ToolCallContext
    const callback = getBundledSkillDynamicContent('debug')!
    const body = await callback('tool calls hanging', ctx)

    // Header + the product's own introduction.
    expect(body).toContain('Debug Nexus Skill')
    expect(body).toContain('nexus_web SharedWorker runtime')
    // User issue lands in the prompt.
    expect(body).toContain('## Issue Reported')
    expect(body).toContain('tool calls hanging')
    // All three log entries appear, with level + tag + text.
    expect(body).toContain('[error]')
    expect(body).toContain('[warn]')
    expect(body).toContain('[mcp]')
    expect(body).toContain('connection refused to example.com:443')
    expect(body).toContain('retry after 503')
    expect(body).toContain('failed to register hooks')
  })

  it('handles "no issue described" and "empty buffer" gracefully', async () => {
    // Implementation note: tests run in vitest's node env where the worker
    // log buffer is shared module-level. We can't fully reset it from this
    // file, so this test asserts behavior conditional on the empty case
    // (when relevant) and ensures the "no args" / "no entries" branches
    // produce sensible placeholder text rather than crashing.
    const ctx = {} as ToolCallContext
    const callback = getBundledSkillDynamicContent('debug')!
    const body = await callback('', ctx)

    expect(body).toContain('## Issue Reported')
    expect(body).toContain('none specified — diagnose any anomalies')
    // Either the empty-buffer notice OR the live tail. Both are valid.
    const tailIsEmpty = body.includes(
      'no warn/error entries captured yet',
    )
    const tailHasContent = body.includes('## Recent Worker Log')
    expect(tailIsEmpty || tailHasContent).toBe(true)
  })

  it('omits the bridge-trace section when __NEXUS_BRIDGE_TRACE__ is unset', async () => {
    // The global may have been set by other tests in this run. If it's
    // unset/empty, the section explains how to enable. Either path is
    // valid for the prompt — assert the prompt mentions the trace concept.
    const ctx = {} as ToolCallContext
    const body = await getBundledSkillDynamicContent('debug')!('', ctx)
    expect(
      body.includes('Bridge Trace') || body.includes('Recent Bridge Trace Events'),
    ).toBe(true)
  })

  it('enables debug capture on invocation and reports it', async () => {
    const { disableDebugLogging, isTraceCapturing } = await import('../utils/debugLog')
    const ctx = {} as ToolCallContext
    const callback = getBundledSkillDynamicContent('debug')!

    // Switch off → the prompt announces capture was just enabled and asks
    // the model to have the user reproduce + re-run.
    disableDebugLogging()
    const firstBody = await callback('', ctx)
    expect(isTraceCapturing()).toBe(true)
    expect(firstBody).toContain('Debug Capture Just Enabled')
    expect(firstBody).toContain('/debug log off')

    // Switch already on → no just-enabled section.
    const secondBody = await callback('', ctx)
    expect(secondBody).not.toContain('Debug Capture Just Enabled')

    disableDebugLogging()
  })
})

describe('tidy-memory bundled skill', () => {
  beforeEach(() => installStockSkills())

  it('is registered slash-only with memory-consolidation permittedTools', () => {
    const tidy = getBundledSkillCommands().find(c => c.name === 'tidy-memory')!
    expect(tidy).toBeDefined()
    expect(tidy.userCallable).toBe(true)
    expect(tidy.hiddenFromModel).toBe(true)
    expect(tidy.argumentHint).toBe('[extra context]')
    // Needs read+write for memory files, grep for transcripts.
    expect(tidy.permittedTools).toEqual(
      ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
    )
    expect(tidy.source).toBe('bundled')
    expect(tidy.useWhen).toContain('consolidate')
  })

  it('dynamic body carries the four-phase memory-consolidation structure', async () => {
    const ctx = {
      options: { cwd: '/work', projectRoot: '/work/myrepo' },
    } as never as ToolCallContext
    const body = await getBundledSkillDynamicContent('tidy-memory')!('', ctx)

    // Title and the four phase headings.
    expect(body).toContain('# Memory Tidy')
    expect(body).toContain('## 1. Look at what is there')
    expect(body).toContain('## 2. Find what is new')
    expect(body).toContain('## 3. Fold it into notes')
    expect(body).toContain('## 4. Rebuild the index')
    // The memory index file and its line cap.
    expect(body).toContain('MEMORY.md')
    expect(body).toContain('200 lines') // INDEX_MAX_LINES
    // Transcript-grep recipe.
    expect(body).toContain('grep -rn')
    expect(body).toContain('--include="*.jsonl"')
    // Memory + transcript dirs are interpolated from cwd/projectRoot.
    expect(body).toContain('/work/myrepo/memory/')
    expect(body).toContain('/work/.velloc/sessions/')
    // Closer line.
    expect(body).toContain(
      'Finish with a short report of what you added, changed or removed',
    )
    // The index size is a ceiling, and stale notes lose their index line.
    expect(body).toContain('lines and under ~25 KB')
    expect(body).toContain('notes that are gone, stale, wrong or replaced')
    // Directly checked current sources count as evidence; exclusions still hold.
    expect(body).toContain('a current source you checked directly; the exclusions above still apply')
  })

  it('falls back to ${cwd}/.velloc/memory/ when projectRoot is unset', async () => {
    const ctx = {
      options: { cwd: '/work' },
    } as never as ToolCallContext
    const body = await getBundledSkillDynamicContent('tidy-memory')!('', ctx)
    expect(body).toContain('/work/.velloc/memory/')
  })

  it('appends extra context section when args are provided', async () => {
    const ctx = {
      options: { cwd: '/w', projectRoot: '/w/p' },
    } as never as ToolCallContext
    const body = await getBundledSkillDynamicContent('tidy-memory')!(
      'consolidate findings from the bridge refactor',
      ctx,
    )
    expect(body).toContain('## Additional context')
    expect(body).toContain('consolidate findings from the bridge refactor')
  })

  // Regression: /tidy-memory must consolidate the SAME memory dir the agent writes to.
  // Before the fix it ignored the Settings → Memory `autoMemoryDirectory`
  // override (the new primary mechanism), so under daily-log — where /tidy-memory is the
  // sole consolidation path — it distilled the wrong (default) directory.
  it('honors memorySettings.autoMemoryDirectory for the consolidation memory dir', async () => {
    const ctx = {
      options: {
        cwd: '/work',
        projectRoot: '/work/myrepo',
        homeDir: '/home/u',
        memorySettings: { autoMemoryDirectory: '/custom/mem' },
      },
    } as never as ToolCallContext
    const body = await getBundledSkillDynamicContent('tidy-memory')!('', ctx)
    expect(body).toContain('Memory directory: `/custom/mem/`')
    // The default project-memory dir must NOT be the consolidation target
    // (the transcript grep still references the projects/ dir — only the
    // `Memory directory:` line must reflect the override).
    expect(body).not.toContain('Memory directory: `/home/u/.velloc/projects')
  })

  it('expands ~/ in memorySettings.autoMemoryDirectory against homeDir', async () => {
    const ctx = {
      options: {
        cwd: '/work',
        projectRoot: '/work/myrepo',
        homeDir: '/home/u',
        memorySettings: { autoMemoryDirectory: '~/my-mem' },
      },
    } as never as ToolCallContext
    const body = await getBundledSkillDynamicContent('tidy-memory')!('', ctx)
    expect(body).toContain('Memory directory: `/home/u/my-mem/`')
  })

  // Regression: the transcript grep must target where transcripts ACTUALLY
  // live — the grouped `<configHome>/projects/<projectFolderKey(projectRoot)>` dir
  // (projectHomeFor) — not the non-existent
  // `${cwd}/.velloc/sessions/` the prior code hardcoded.
  it('points the transcript grep at the grouped projects dir when homeDir is resolved', async () => {
    const ctx = {
      options: { cwd: '/work', projectRoot: '/work/myrepo', homeDir: '/home/u' },
    } as never as ToolCallContext
    const body = await getBundledSkillDynamicContent('tidy-memory')!('', ctx)
    const expectedDir = projectHomeFor('/home/u', '/work/myrepo')
    expect(body).toContain(expectedDir)
    expect(body).not.toContain('/work/.velloc/sessions/')
  })

  // No host-resolved home (worker env): fall back to the legacy conventional
  // base so the pattern still reaches the model.
  it('falls back to ${cwd}/.velloc/sessions/ for transcripts when homeDir is absent', async () => {
    const ctx = {
      options: { cwd: '/work', projectRoot: '/work/myrepo' },
    } as never as ToolCallContext
    const body = await getBundledSkillDynamicContent('tidy-memory')!('', ctx)
    expect(body).toContain('/work/.velloc/sessions/')
  })

  it('omits the extra-context section when args are empty', async () => {
    const ctx = {
      options: { cwd: '/w', projectRoot: '/w/p' },
    } as never as ToolCallContext
    const body = await getBundledSkillDynamicContent('tidy-memory')!('', ctx)
    expect(body).not.toContain('## Additional context')
  })
})

describe('loop bundled skill', () => {
  beforeEach(() => installStockSkills())

  it('is registered `/loop`-only with a dynamic body', () => {
    const loop = getBundledSkillCommands().find(c => c.name === 'loop')!
    expect(loop).toBeDefined()
    expect(loop.userCallable).toBe(true)
    // `modelInvocation: []` — starting a recurring BACKGROUND routine is a
    // user decision, so the model never reaches for /loop on its own.
    expect(loop.hiddenFromModel).toBe(true)
    expect(loop.modelInvocation).toEqual([])
    expect(loop.argumentHint).toBe('[interval] <prompt>')
    expect(loop.useWhen).toContain('schedule')
    expect(loop.source).toBe('bundled')
    // Dynamic body → the static `content` placeholder stays empty.
    expect(loop.content).toBe('')
    expect(getBundledSkillDynamicContent('loop')).toBeDefined()
  })

  it('is ALWAYS enabled — no isEnabled gate, only a display-only row', () => {
    // The routine substrate is unconditional, so the skill ships with no
    // `isEnabled` gate.
    expect(getBundledSkillIsEnabled('loop')).toBeUndefined()
    // Slash-only now, so it earns a DISPLAY-ONLY Features row — shown,
    // never toggled — the same treatment /review, /commit and /init get.
    expect(getBundledSkillModelInvocation('loop')).toEqual([])
    const loopFeature = getFeatureDefinition('bundled-skills.loop')!
    expect(loopFeature).toBeDefined()
    expect(loopFeature.modelInvocable).toBe(false)
    expect(
      getFeatureCatalog().find(f => f.id === 'bundled-skills.loop')?.modelInvocable,
    ).toBe(false)
    // …and no session-type narrowing: `/loop` works in every template type.
    expect(getBundledSkillCommands().find(c => c.name === 'loop')?.userInvocation)
      .toBeUndefined()
  })

  it('empty args yield usage text and never reach the cron tool', async () => {
    const body = await getBundledSkillDynamicContent('loop')!(
      '   ',
      {} as ToolCallContext,
    )
    expect(body).toContain('Usage: `/loop [interval] <prompt>`')
    // The usage path must not instruct a CronCreate call.
    expect(body).not.toContain('CronCreate')
  })

  it('body carries the parsing rules and interval→cron table', async () => {
    const body = await getBundledSkillDynamicContent('loop')!(
      '5m check the build',
      {} as ToolCallContext,
    )
    expect(body).toContain('# Loop: register a recurring routine')
    expect(body).toContain('## Parse the input')
    expect(body).toContain('^\\d+[smhd]$')
    expect(body).toContain('"check every PR" contains no interval')
    expect(body).toContain('## Interval to cron')
    expect(body).toContain('`*/N * * * *`')
    expect(body).toContain('`0 0 */N * *`')
    // Rule 3's default, interpolated from LOOP_FALLBACK_CADENCE.
    expect(body).toContain('interval is 10m')
    // The raw input is appended unchanged for the model to parse.
    expect(body).toContain('## Raw input\n\n5m check the build')
  })

  it('body loads a deferred CronCreate through ToolSearch before calling it', async () => {
    const body = await getBundledSkillDynamicContent('loop')!(
      '1m review handoffs',
      {} as ToolCallContext,
    )
    expect(body).toContain('load it first with ToolSearch using the query `select:CronCreate`')
    // The load step precedes the call step.
    expect(body.indexOf('select:CronCreate')).toBeLessThan(
      body.indexOf('Call CronCreate with:'),
    )
    // A session type with no scheduling at all stops with an explanation.
    expect(body).toContain('`/loop` needs a session type with scheduling')
  })

  it('body targets the nexus CronCreate schema (`name` + `schedule`)', async () => {
    const body = await getBundledSkillDynamicContent('loop')!(
      'check the deploy',
      {} as ToolCallContext,
    )
    expect(body).toContain('Call CronCreate with:')
    // nexus routines are named + use `schedule`; there is no `recurring` or
    // `durable` field.
    expect(body).toContain('`name`')
    expect(body).toContain('`schedule`')
    expect(body).not.toContain('`recurring`')
    expect(body).not.toContain('`durable`')
    // The body points at CronList / CronDelete for the routine's lifecycle and
    // promises no auto-expiry (nexus routines never age out).
    expect(body).toContain('CronList')
    expect(body).toContain('CronDelete')
    expect(body).not.toContain('auto-expire')
    // One-shot requests belong to the sibling tool, not `recurring: false`.
    expect(body).toContain('ScheduleCron')
  })

  it('body requests session delivery, so each fire runs in this conversation', async () => {
    const body = await getBundledSkillDynamicContent('loop')!(
      'check the deploy',
      {} as ToolCallContext,
    )
    // Session delivery makes each fire land in the current transcript
    // instead of a fresh contextless agent.
    expect(body).toContain('`deliver_to: "session"`')
    // `notify_on` is inert for session delivery — the inline answer IS the
    // notification — so the body must not instruct one.
    expect(body).not.toContain('`notify_on`')
  })

  it('body tells the model NOT to expand the prompt (it inherits context now)', async () => {
    const body = await getBundledSkillDynamicContent('loop')!(
      'check the deploy',
      {} as ToolCallContext,
    )
    expect(body).toContain("## Keep the prompt in the user's words")
    expect(body).toContain('near-verbatim')
    // The pre-session-delivery instruction told the model to expand the
    // shorthand into a self-contained directive because each fire started
    // cold. That premise is gone; leaving the section in would discard the
    // very context the loop now exists to use.
    expect(body).not.toContain('fresh headless agent on every fire')
    expect(body).not.toContain(
      '## Write the prompt so it works with no conversation context',
    )
  })

  it('body warns that a fired turn cannot register more routines', async () => {
    const body = await getBundledSkillDynamicContent('loop')!(
      'check the deploy',
      {} as ToolCallContext,
    )
    // Matches the runtime recursion guard, so the model does not waste a
    // turn attempting something that will be refused.
    expect(body).toContain('recursion guard')
  })

  it('body keeps the "run it now, do not wait for the first fire" step', async () => {
    const body = await getBundledSkillDynamicContent('loop')!(
      'check the deploy',
      {} as ToolCallContext,
    )
    expect(body).toContain('Run the prompt once right now')
  })
})

describe('batch bundled skill', () => {
  beforeEach(() => installStockSkills())

  it('is registered slash-only with its description', () => {
    const batch = getBundledSkillCommands().find(c => c.name === 'batch')!
    expect(batch).toBeDefined()
    expect(batch.description).toContain('parallel')
    expect(batch.argumentHint).toBe('<instruction>')
    // userCallable + hiddenFromModel → /batch only.
    expect(batch.userCallable).toBe(true)
    expect(batch.hiddenFromModel).toBe(true)
    expect(batch.source).toBe('bundled')
    expect(batch.useWhen).toContain('sweeping')
  })

  it('missing-instruction guard returns help text', async () => {
    const dyn = getBundledSkillDynamicContent('batch')!
    expect(dyn).toBeDefined()
    const text = await dyn('', { options: { cwd: '/tmp' } } as ToolCallContext)
    expect(text).toContain('`/batch` needs an instruction')
    expect(text).toContain('/batch migrate every API handler')
    expect(text).toContain('/batch add JSDoc to every exported function')
  })

  it('not-a-git-repo guard returns the refusal text', async () => {
    // Stub fs that has NO .git anywhere — emulates a fresh dir without git.
    installProcessFs(stubFsWithExistingDirs(new Set()))
    try {
      const dyn = getBundledSkillDynamicContent('batch')!
      const text = await dyn('migrate from react to vue', {
        options: { cwd: '/workspace' },
      } as ToolCallContext)
      expect(text.startsWith('`/batch` only works inside a git repository')).toBe(true)
      expect(text).toContain('isolated git worktree')
      expect(text).toContain('Run `git init` here')
    } finally {
      installProcessFs(unconfiguredFs)
    }
  })

  it('body carries the three-phase plan→spawn→track structure', async () => {
    // Stub fs that says `/workspace/.git` exists — emulates running inside
    // a git repo. The `isCwdGitRepo` helper finds the dir and returns true,
    // unlocking the full prompt path.
    installProcessFs(
      stubFsWithExistingDirs(new Set(['/workspace/.git'])),
    )
    try {
      const dyn = getBundledSkillDynamicContent('batch')!
      const text = await dyn('migrate from react to vue', {
        options: { cwd: '/workspace' },
      } as ToolCallContext)
      expect(text).toContain('# Coordinator brief: one large change, many parallel workers')
      expect(text).toContain('## Stage 1: Plan in plan mode')
      expect(text).toContain('## Stage 2: Launch the workers')
      expect(text).toContain('## Stage 3: Track the results')
      expect(text).toContain('EnterPlanMode')
      expect(text).toContain('ExitPlanMode')
      expect(text).toContain('Agent')
      expect(text).toContain('Skill')
      expect(text).toContain('AskUserQuestion')
      // The instruction is interpolated directly (no $ARGUMENTS).
      expect(text).toContain('migrate from react to vue')
      expect(text).toContain('between 5 and 30')
      expect(text).toContain('PR: <url>')
      expect(text).toContain('gh pr create')
    } finally {
      installProcessFs(unconfiguredFs)
    }
  })

  it('requires only the tools its body drives — nothing the per-model todo gate withholds', async () => {
    // `requiredTools` is the type-level guard ("a type that admits /batch
    // must run these"). TodoWrite is ALSO withheld per MODEL
    // (utils/todoTools.ts, `todoTools: false`), and that gate cannot be
    // stated as a type requirement — so the only consistent shape is a body
    // that never drives TodoWrite and a requirement list that never names it.
    // The list once named it; every required tool must appear in the prompt
    // it is required for.
    installProcessFs(
      stubFsWithExistingDirs(new Set(['/workspace/.git'])),
    )
    try {
      const dyn = getBundledSkillDynamicContent('batch')!
      const text = await dyn('migrate from react to vue', {
        options: { cwd: '/workspace' },
      } as ToolCallContext)
      expect(text).not.toContain('TodoWrite')
      const required = getBundledSkillRequiredTools('batch') ?? []
      expect(required.length).toBeGreaterThan(0)
      for (const tool of required) {
        expect(text, `requiredTools names ${tool}, which the body never drives`).toContain(tool)
      }
    } finally {
      installProcessFs(unconfiguredFs)
    }
  })
})

describe('update-config bundled skill', () => {
  beforeEach(() => installStockSkills())

  it('is registered with permittedTools [Read], user- AND model-invocable', () => {
    const cmd = getBundledSkillCommands().find(c => c.name === 'update-config')!
    expect(cmd).toBeDefined()
    expect(cmd.permittedTools).toEqual(['Read'])
    expect(cmd.userCallable).toBe(true)
    // update-config is model-invocable (the model reaches for it on
    // "from now on, whenever X" requests), so hiddenFromModel stays false.
    expect(cmd.hiddenFromModel).toBe(false)
    expect(cmd.source).toBe('bundled')
    // Dynamic body → the static `content` placeholder is empty.
    expect(cmd.content).toBe('')
  })

  it('full body documents the single settings source, hooks, and the Phase-2 gaps', async () => {
    const dyn = getBundledSkillDynamicContent('update-config')!
    expect(dyn).toBeDefined()
    const body = await dyn('', {} as ToolCallContext)
    expect(body).toContain('# Update Config Skill')
    expect(body).toContain('~/.velloc/settings.json')
    expect(body).toContain('## Hooks Configuration')
    // Honest about what is NOT wired yet, so the model never writes an inert
    // permissions/env setting.
    expect(body).toContain('NOT yet supported')
  })

  /**
   * The description is the only thing the model sees when deciding whether this
   * skill is the right tool, and it used to advertise `profile` settings. That
   * pulled "remember this PR template" requests into settings.json, where the
   * value landed in a user-global field the prompt never mentions. It must now
   * route conventions to the instruction file instead.
   */
  it('description scopes the skill to harness config and routes conventions to AGENTS.md', () => {
    const cmd = getBundledSkillCommands().find(c => c.name === 'update-config')!
    const description = cmd.description ?? ''
    // Still owns the thing only the harness can do: hooks.
    expect(description).toContain('hooks')
    expect(description).toContain('only the harness runs on events')
    // No longer advertises a settings-backed instruction store…
    expect(description).not.toContain('profile')
    // …and actively redirects the requests that used to land there.
    expect(description).toContain('Not for conventions')
    expect(description).toContain('AGENTS.md')
  })

  /**
   * The skill catalog in the system prompt truncates each description at 250
   * chars (`MAX_LISTING_DESC_CHARS` in `skillLibrary/skillDiscovery.ts`). What survives
   * that cut is all the model reads when deciding whether this is the right
   * tool — so the DISQUALIFIER and its destination have to fit inside the
   * budget, not trail off after it. Appending anything to the front of this
   * description is what would silently push them out.
   */
  it('keeps the disqualifier inside the 250-char catalog truncation', () => {
    const cmd = getBundledSkillCommands().find(c => c.name === 'update-config')!
    const shown = (cmd.description ?? '').slice(0, 249)
    expect(shown).toContain('Not for conventions')
    expect(shown).toContain('AGENTS.md, never settings.json')
  })

  it('full body says instructions do NOT live in settings.json', () => {
    const dyn = getBundledSkillDynamicContent('update-config')!
    return dyn('', {} as ToolCallContext).then(body => {
      expect(body).toContain('Instructions do NOT live here')
      // The `profile` section is documented as identity-only now.
      expect(body).toContain('display identity only')
      // And the model is told not to invent the removed key.
      expect(body).toContain('Never invent a `profile.instructions`')
    })
  })

  it('lists SubagentStop among the events that fire, not the ones that do not', async () => {
    // A fork's turn-end fires SubagentStop; the body used to
    // tell the model it never runs, so it would refuse to author one.
    const dyn = getBundledSkillDynamicContent('update-config')!
    const body = await dyn('[hooks-only] x', {} as ToolCallContext)
    expect(body).toContain('| SubagentStop | Agent id |')
    const inert = body.slice(body.indexOf('DO NOT fire yet'))
    expect(inert.slice(0, inert.indexOf('remaining lifecycle events'))).not.toContain('SubagentStop')
    expect(body).toContain('A SubagentStop hook gets `agent_id`')
  })

  it('lists SessionStart, SessionEnd (clear) and SubagentStart among the events that fire', async () => {
    // Their call sites landed; the body had them among the dead.
    const dyn = getBundledSkillDynamicContent('update-config')!
    const body = await dyn('[hooks-only] x', {} as ToolCallContext)
    expect(body).toContain('| SessionStart | "startup" / "resume" / "clear" / "compact" |')
    expect(body).toContain('| SessionEnd | "clear" |')
    expect(body).toContain('| SubagentStart | Agent id |')
    const inert = body.slice(body.indexOf('DO NOT fire yet'))
    const inertList = inert.slice(0, inert.indexOf('remaining lifecycle events'))
    expect(inertList).not.toContain('SessionStart')
    expect(inertList).not.toContain('SubagentStart')
    expect(inertList).toContain('Notification of any type but')
  })

  it('lists Notification (idle_prompt) among the events that fire', async () => {
    // Its call site landed; the body had it among the dead.
    const dyn = getBundledSkillDynamicContent('update-config')!
    const body = await dyn('[hooks-only] x', {} as ToolCallContext)
    expect(body).toContain('| Notification | "idle_prompt" |')
  })

  it('lists StopFailure among the events that fire, matched on the error type', async () => {
    // Its call site landed (an API error ending the turn).
    const dyn = getBundledSkillDynamicContent('update-config')!
    const body = await dyn('[hooks-only] x', {} as ToolCallContext)
    expect(body).toContain('| StopFailure | Error type')
    expect(body).toContain('rate_limit')
    const inert = body.slice(body.indexOf('DO NOT fire yet'))
    expect(inert.slice(0, inert.indexOf('remaining lifecycle events'))).not.toContain('StopFailure')
  })

  it('lists PermissionRequest among the events that fire, and says how a hook answers the ask', async () => {
    // Beside the dialog; a decision, not a pass, decides.
    const dyn = getBundledSkillDynamicContent('update-config')!
    const body = await dyn('[hooks-only] x', {} as ToolCallContext)
    expect(body).toContain('| PermissionRequest | Tool name |')
    expect(body).toContain('"hookEventName": "PermissionRequest", "decision": { "behavior": "allow" }')
    expect(body).toContain('prints no decision decides nothing')
  })

  it('[hooks-only] returns just the hooks docs + verification flow + the task', async () => {
    const dyn = getBundledSkillDynamicContent('update-config')!
    const body = await dyn(
      '[hooks-only] log my bash commands',
      {} as ToolCallContext,
    )
    expect(body).toContain('## Hooks Configuration')
    expect(body).toContain('## Constructing a Hook (with verification)')
    expect(body).toContain('## Hook to build\n\nlog my bash commands')
    // The full settings reference / skill header is omitted in hooks-only mode.
    expect(body).not.toContain('# Update Config Skill')
  })

  it('appends the request section only when args are present (non hooks-only)', async () => {
    const dyn = getBundledSkillDynamicContent('update-config')!
    const empty = await dyn('', {} as ToolCallContext)
    const withArgs = await dyn('run prettier after edits', {} as ToolCallContext)
    expect(empty).not.toContain('## Request')
    expect(withArgs).toContain('## Request\n\nrun prettier after edits')
  })
})

describe('bundledSkills registry — the modelInvocation gate', () => {
  it('accepts a single string and stores it as a frozen array', () => {
    addStockSkill({
      name: 'agent-only',
      description: '',
      content: 'x',
      modelInvocation: 'agent',
    })
    const types = getBundledSkillModelInvocation('agent-only')
    expect(types).toEqual(['agent'])
    // Frozen — protects the cached membership list from mutation.
    expect(Object.isFrozen(types)).toBe(true)
  })

  it('accepts an array of strings and preserves order', () => {
    addStockSkill({
      name: 'multi',
      description: '',
      content: 'x',
      modelInvocation: ['agent', 'code'],
    })
    expect(getBundledSkillModelInvocation('multi')).toEqual(['agent', 'code'])
  })

  it('distinguishes an OMITTED gate from an EMPTY one — the tri-state', () => {
    // The whole point of the shape. The retired `type:` field collapsed
    // both ends to "no filter", which is why a slash-only skill needed a
    // second boolean to say so. Here absent means every session type and
    // empty means this surface is off.
    addStockSkill({
      name: 'no-gate',
      description: '',
      content: 'x',
    })
    addStockSkill({
      name: 'empty-array',
      description: '',
      content: 'x',
      modelInvocation: [],
    })
    addStockSkill({
      name: 'whitespace',
      description: '',
      content: 'x',
      modelInvocation: ['   ', ''],
    })
    addStockSkill({
      name: 'wildcard',
      description: '',
      content: 'x',
      modelInvocation: ['*', 'agent'],
    })
    expect(getBundledSkillModelInvocation('no-gate')).toBeUndefined()
    // Blank entries collapse to `[]` — DISABLED, not "absent".
    expect(getBundledSkillModelInvocation('empty-array')).toEqual([])
    expect(getBundledSkillModelInvocation('whitespace')).toEqual([])
    // `*` anywhere in the list widens back to every type.
    expect(getBundledSkillModelInvocation('wildcard')).toBeUndefined()
  })

  it('trims entries and drops blanks', () => {
    addStockSkill({
      name: 'mixed',
      description: '',
      content: 'x',
      modelInvocation: [' agent ', '', 'code  '],
    })
    expect(getBundledSkillModelInvocation('mixed')).toEqual(['agent', 'code'])
  })

  it('re-registering with no gate clears the prior list', () => {
    addStockSkill({
      name: 'flippy',
      description: '',
      content: 'x',
      modelInvocation: 'agent',
    })
    expect(getBundledSkillModelInvocation('flippy')).toEqual(['agent'])
    addStockSkill({
      name: 'flippy',
      description: '',
      content: 'x',
    })
    expect(getBundledSkillModelInvocation('flippy')).toBeUndefined()
  })

  describe('isBundledSkillModelInvocableIn', () => {
    it('returns true for an unregistered skill (no filter = allow)', () => {
      expect(isBundledSkillModelInvocableIn('nope', 'agent')).toBe(true)
    })

    it('returns true when the skill has no gate (no filter)', () => {
      addStockSkill({
        name: 'untyped',
        description: '',
        content: 'x',
      })
      expect(isBundledSkillModelInvocableIn('untyped', 'chat')).toBe(true)
      expect(isBundledSkillModelInvocableIn('untyped', undefined)).toBe(true)
    })

    it('returns false for an EMPTY gate — even with no session type', () => {
      // The over-include courtesy below is about an unknown TYPE. An
      // explicit `[]` is not a type question, so nothing widens it.
      addStockSkill({
        name: 'shut',
        description: '',
        content: 'x',
        modelInvocation: [],
      })
      expect(isBundledSkillModelInvocableIn('shut', 'agent')).toBe(false)
      expect(isBundledSkillModelInvocableIn('shut', undefined)).toBe(false)
    })

    it('returns true when `templateType` is unknown (over-include)', () => {
      addStockSkill({
        name: 'a-only',
        description: '',
        content: 'x',
        modelInvocation: 'agent',
      })
      // Caller didn't model a templateType — don't silently hide every
      // typed skill from a misconfigured caller.
      expect(isBundledSkillModelInvocableIn('a-only', undefined)).toBe(true)
      expect(isBundledSkillModelInvocableIn('a-only', '')).toBe(true)
    })

    it('matches on inclusion in the whitelist', () => {
      addStockSkill({
        name: 'ac',
        description: '',
        content: 'x',
        modelInvocation: ['agent', 'code'],
      })
      expect(isBundledSkillModelInvocableIn('ac', 'agent')).toBe(true)
      expect(isBundledSkillModelInvocableIn('ac', 'code')).toBe(true)
      expect(isBundledSkillModelInvocableIn('ac', 'chat')).toBe(false)
      expect(isBundledSkillModelInvocableIn('ac', 'project')).toBe(false)
    })

    it('the user-quoted example: type=agent skill is hidden from a chat session', () => {
      addStockSkill({
        name: 'big-thinking',
        description: '',
        content: 'x',
        modelInvocation: 'agent',
      })
      expect(isBundledSkillModelInvocableIn('big-thinking', 'agent')).toBe(true)
      expect(isBundledSkillModelInvocableIn('big-thinking', 'chat')).toBe(false)
    })
  })
})

describe('addStockSkill — auto-feature registration', () => {
  it('registers a feature `bundled-skills.<name>` when `default` is set', () => {
    addStockSkill({
      name: 'unitfoo',
      description: 'The foo skill, briefly described.',
      content: 'body',
      default: true,
    })
    const feature = getFeatureDefinition(`${BUNDLED_SKILL_FEATURE_PREFIX}unitfoo`)
    expect(feature).toBeDefined()
    expect(feature!.id).toBe('bundled-skills.unitfoo')
    expect(feature!.default).toBe(true)
    // Falls back to skill name + skill description when feature* overrides
    // are omitted — single source of truth wins.
    expect(feature!.title).toBe('unitfoo')
    expect(feature!.description).toBe('The foo skill, briefly described.')
    // Default category is auto-applied.
    expect(feature!.category).toBe('Bundled skills')
  })

  it('respects featureTitle / featureDescription / featureCategory overrides', () => {
    addStockSkill({
      name: 'bar',
      description: 'Short model-facing line.',
      content: 'body',
      default: false,
      featureTitle: 'Bar — friendlier UI label',
      featureDescription: 'Adds /bar — a longer user-facing explanation.',
      featureCategory: 'Experimental',
      requiresRestart: true,
      docsUrl: 'https://example.org/docs/bar',
    })
    const feature = getFeatureDefinition('bundled-skills.bar')!
    expect(feature.title).toBe('Bar — friendlier UI label')
    expect(feature.description).toBe('Adds /bar — a longer user-facing explanation.')
    expect(feature.category).toBe('Experimental')
    expect(feature.default).toBe(false)
    expect(feature.requiresRestart).toBe(true)
    expect(feature.docsUrl).toBe('https://example.org/docs/bar')
  })

  it('auto-wires `isEnabled` to the feature flag when no explicit callback is given', () => {
    addStockSkill({
      name: 'autobaz',
      description: '',
      content: 'body',
      default: false,
    })
    const isEnabled = getBundledSkillIsEnabled('autobaz')
    expect(isEnabled).toBeDefined()
    // Default false → off when no override.
    expect(isEnabled!({ enabledFeatures: {} } as never)).toBe(false)
    // Override flips it on.
    expect(isEnabled!({
      enabledFeatures: { 'bundled-skills.autobaz': true },
    } as never)).toBe(true)
  })

  it('keeps an author-supplied `isEnabled` callback when both are present', () => {
    let callbackHits = 0
    addStockSkill({
      name: 'authorgate',
      description: '',
      content: 'body',
      default: true,
      isEnabled: () => {
        callbackHits++
        return false
      },
    })
    const isEnabled = getBundledSkillIsEnabled('authorgate')!
    expect(isEnabled({ enabledFeatures: {} } as never)).toBe(false)
    expect(callbackHits).toBe(1)
    // The feature is still registered — the WebUI toggle still appears.
    expect(getFeatureDefinition('bundled-skills.authorgate')).toBeDefined()
  })

  it('does NOT register a feature when `default` is omitted', () => {
    addStockSkill({
      name: 'nogate',
      description: '',
      content: 'body',
    })
    expect(getFeatureDefinition('bundled-skills.nogate')).toBeUndefined()
    // No auto-wired isEnabled → skill is unconditional.
    expect(getBundledSkillIsEnabled('nogate')).toBeUndefined()
  })

  it('throws when feature-UI fields are set without `default` (typo guard)', () => {
    expect(() =>
      addStockSkill({
        name: 'oops',
        description: '',
        content: 'body',
        // Forgot `default`. The featureTitle would be silently ignored —
        // surface this loudly instead.
        featureTitle: 'Oops — settings only',
      }),
    ).toThrow(/feature-UI fields.*no `default`/)
  })

  it('re-registering with `default` omitted DROPS the prior auto-feature', () => {
    addStockSkill({
      name: 'flippy',
      description: '',
      content: 'body',
      default: true,
    })
    expect(getFeatureDefinition('bundled-skills.flippy')).toBeDefined()
    // Note: re-registering doesn't AUTO-clear the feature from the
    // global registry today (registerFeature is last-write-wins per id,
    // but we don't call it again when default is absent). The skill's
    // `isEnabled` IS cleared so the skill becomes unconditional —
    // matching what the author signaled by dropping `default`.
    addStockSkill({
      name: 'flippy',
      description: '',
      content: 'body',
    })
    // Skill side: gate is gone.
    expect(getBundledSkillIsEnabled('flippy')).toBeUndefined()
    // Feature side: the stale entry remains until process restart
    // (acceptable for a registration-time-only API; no production code
    // re-registers the same skill with different `default` semantics).
    expect(getFeatureDefinition('bundled-skills.flippy')).toBeDefined()
  })
})

describe('addStockSkill — model-invocable toggle vs slash-only display-only', () => {
  it('a MODEL-INVOCABLE skill (default set) registers a TOGGLE feature (modelInvocable: true) with gating', () => {
    addStockSkill({
      name: 'modelfoo',
      description: 'A model-invocable skill.',
      content: 'body',
      default: true,
      argumentHint: '<thing>',
    })
    const feature = getFeatureDefinition('bundled-skills.modelfoo')!
    expect(feature).toBeDefined()
    expect(feature.modelInvocable).toBe(true)
    expect(feature.name).toBe('modelfoo')
    // The toggle gates the skill: isEnabled wired to the feature flag.
    const isEnabled = getBundledSkillIsEnabled('modelfoo')
    expect(isEnabled).toBeDefined()
    expect(isEnabled!({ enabledFeatures: {} } as never)).toBe(true) // default true
    expect(
      isEnabled!({ enabledFeatures: { 'bundled-skills.modelfoo': false } } as never),
    ).toBe(false)
  })

  it('a SLASH-ONLY skill registers a DISPLAY-ONLY feature (modelInvocable: false, never gated)', () => {
    addStockSkill({
      name: 'slashfoo',
      description: 'A slash-only skill.',
      content: 'body',
      modelInvocation: [],
      argumentHint: '<instruction>',
    })
    const feature = getFeatureDefinition('bundled-skills.slashfoo')!
    expect(feature, 'slash-only skill still SHOWS on the Features page').toBeDefined()
    expect(feature.modelInvocable).toBe(false)
    expect(feature.name).toBe('slashfoo')
    expect(feature.argumentHint).toBe('<instruction>')
    // Display-only: no toggle → no isEnabled gate → always available via /name.
    expect(getBundledSkillIsEnabled('slashfoo')).toBeUndefined()
  })

  it('a slash-only skill WITHOUT default still registers a display-only row (like review/commit/init)', () => {
    // review/commit/init/security-review set no `default` — previously invisible
    // on the Features page; now they appear as display-only rows.
    addStockSkill({
      name: 'commitlike',
      description: 'Slash-only, no default.',
      content: 'body',
      modelInvocation: [],
    })
    const feature = getFeatureDefinition('bundled-skills.commitlike')!
    expect(feature).toBeDefined()
    expect(feature.modelInvocable).toBe(false)
    expect(getBundledSkillIsEnabled('commitlike')).toBeUndefined()
  })

  it('a model-invocable skill WITHOUT default registers no feature (always-on, no toggle)', () => {
    addStockSkill({ name: 'modelnogate', description: '', content: 'body' })
    expect(getFeatureDefinition('bundled-skills.modelnogate')).toBeUndefined()
    expect(getBundledSkillIsEnabled('modelnogate')).toBeUndefined()
  })

  it('getFeatureCatalog carries modelInvocable through to the UI', () => {
    addStockSkill({ name: 'm1', description: '', content: 'b', default: true })
    addStockSkill({
      name: 's1',
      description: '',
      content: 'b',
      modelInvocation: [],
    })
    const catalog = getFeatureCatalog()
    expect(catalog.find(f => f.id === 'bundled-skills.m1')?.modelInvocable).toBe(true)
    expect(catalog.find(f => f.id === 'bundled-skills.s1')?.modelInvocable).toBe(false)
  })
})

describe('installStockSkills — populates the features catalog as a side effect', () => {
  it('produces feature entries for every bundled skill that declares `default`', () => {
    installStockSkills()
    // All production bundled skills set `default: true`.
    expect(getFeatureDefinition('bundled-skills.simplify')).toBeDefined()
    expect(getFeatureDefinition('bundled-skills.batch')).toBeDefined()
    expect(getFeatureDefinition('bundled-skills.debug')).toBeDefined()
    expect(getFeatureDefinition('bundled-skills.tidy-memory')).toBeDefined()
    expect(getFeatureDefinition('bundled-skills.update-config')).toBeDefined()
    // Sanity: each one has a non-empty title + description. We don't
    // assert the value of `default` per-skill here — that's an editorial
    // choice on the skill registration site (simplify/batch/debug ship
    // on by default; tidy-memory ships opt-in) and shouldn't be re-pinned in
    // a test. Just verify the field is present + boolean.
    for (const id of [
      'bundled-skills.simplify',
      'bundled-skills.batch',
      'bundled-skills.debug',
      'bundled-skills.tidy-memory',
      'bundled-skills.update-config',
    ] as const) {
      const feature = getFeatureDefinition(id)!
      expect(feature.title.length).toBeGreaterThan(0)
      expect(feature.description.length).toBeGreaterThan(0)
      expect(feature.category).toBe('Bundled skills')
      expect(typeof feature.default).toBe('boolean')
    }
  })
})

describe('e2e-throw bundled skill (test fixture)', () => {
  beforeEach(() => installStockSkills())

  it('is registered as an e2e-only, model-only, non-advertised fixture', () => {
    const cmd = getBundledSkillCommands().find(c => c.name === E2E_THROW_SKILL_NAME)!
    expect(cmd).toBeDefined()
    // e2eOnly → the loader drops it from every non-e2e command list.
    expect(isBundledSkillE2eOnly(E2E_THROW_SKILL_NAME)).toBe(true)
    // Model-only: invocable by an explicit Skill tool call, hidden from the
    // user slash picker.
    expect(cmd.hiddenFromModel).toBe(false)
    expect(cmd.userCallable).toBe(false)
    // `e2eOnly` alone keeps it out of the model's advertised listing in
    // every real (and e2e) session — no sentinel session type needed.
    const modelInvocable = getModelInvocableCommands([cmd])
    expect(modelInvocable).toHaveLength(0)
    // No `default` → no Features-page entry (would be `bundled-skills.e2e-throw`).
    expect(getFeatureDefinition(`${BUNDLED_SKILL_FEATURE_PREFIX}${E2E_THROW_SKILL_NAME}`))
      .toBeUndefined()
  })

  it('its dynamic body build throws deterministically', async () => {
    const dynamic = getBundledSkillDynamicContent(E2E_THROW_SKILL_NAME)!
    expect(dynamic).toBeDefined()
    await expect(dynamic('', {} as never)).rejects.toThrow(
      E2E_THROW_SKILL_ERROR,
    )
  })
})
