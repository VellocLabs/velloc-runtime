/**
 * src/memory/relevantRecall.ts, deterministic pieces only (the `queryFastModel` call needs a live `callModel`):
 * JSON parsing, marker round-trip, recent-tool extraction, freshness headers, truncation and the null gates.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  buildMarker,
  buildRelevantMemoryInjection,
  collectRecentToolNames,
  collectSurfacedMemoryPaths,
  pickRecallNotes,
  recallNoteBanner,
  parseRecallPicks,
  loadRecallNotes,
  beginRecallLookahead,
} from '../memory/relevantRecall'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_USER,
  PART_TOOL_CALL,
  ROLE_ASSISTANT,
  ROLE_USER,
} from '../runtime/VercelModelConstants'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'

const DAY = 86_400_000

function makeRuntimeConfig(env: Record<string, string> = {}): RuntimeConfig {
  return {
    getEnv: (name: string) => env[name],
    flagOn: (name: string) => {
      const v = env[name]
      return v === '1' || v === 'true' || v === 'yes'
    },
    now: () => Date.now(),
    createUUID: () => 'uuid',
    createTimestamp: () => '2026-05-13T00:00:00.000Z',
    getMaxStructuredOutputRetries: () => 5,
  }
}

function userMessage(text: string): Message {
  return {
    type: MSG_TYPE_USER,
    uuid: 'u',
    message: { role: ROLE_USER, content: text },
  } as unknown as Message
}

function assistantToolCalls(...toolNames: string[]): Message {
  return {
    type: MSG_TYPE_ASSISTANT,
    uuid: 'a',
    message: {
      role: ROLE_ASSISTANT,
      content: toolNames.map((toolName, i) => ({
        type: PART_TOOL_CALL,
        toolCallId: `t${i}`,
        toolName,
        args: {},
      })),
    },
  } as unknown as Message
}

function minimalContext(
  mainLoopProviderId?: string,
  memorySettings?: Record<string, unknown>,
): ToolCallContext {
  return {
    options: {
      cwd: '/home/user/project',
      projectRoot: '/home/user/project',
      mainLoopProviderId,
      mainLoopModel: 'claude-haiku-4-5',
      ...(memorySettings ? { memorySettings } : {}),
    },
    cancelSource: new AbortController(),
  } as unknown as ToolCallContext
}

afterEach(() => {
  resetProcessFs()
})

// ===========================================================================
// parseRecallPicks
// ===========================================================================

describe('parseRecallPicks', () => {
  it('parses a bare JSON object', () => {
    expect(
      parseRecallPicks('{"files": ["user_role.md", "x.md"]}'),
    ).toEqual(['user_role.md', 'x.md'])
  })

  it('strips ```json code fences', () => {
    const raw = '```json\n{"files": ["a.md"]}\n```'
    expect(parseRecallPicks(raw)).toEqual(['a.md'])
  })

  it('slices JSON out of surrounding prose', () => {
    const raw =
      'Sure! Here are the relevant ones: {"files": ["b.md"]} hope that helps'
    expect(parseRecallPicks(raw)).toEqual(['b.md'])
  })

  it('filters out non-string entries', () => {
    expect(
      parseRecallPicks('{"files": ["ok.md", 3, null]}'),
    ).toEqual(['ok.md'])
  })

  it('returns [] for missing key, bad JSON, or no braces', () => {
    expect(parseRecallPicks('{}')).toEqual([])
    expect(parseRecallPicks('not json at all')).toEqual([])
    expect(parseRecallPicks('{"files": "nope"}')).toEqual([])
  })
})

// ===========================================================================
// buildMarker <-> collectSurfacedMemoryPaths round-trip
// ===========================================================================

describe('marker round-trip', () => {
  it('parses paths and bytes back from a single marker', () => {
    const marker = buildMarker(['/m/user_role.md', '/m/foo.md'], 1234)
    const out = collectSurfacedMemoryPaths([userMessage(`hi\n${marker}`)])
    expect([...out.paths]).toEqual(['/m/user_role.md', '/m/foo.md'])
    expect(out.totalBytes).toBe(1234)
  })

  it('accumulates across multiple prior turns', () => {
    const m1 = buildMarker(['/m/a.md'], 100)
    const m2 = buildMarker(['/m/b.md', '/m/c.md'], 250)
    const out = collectSurfacedMemoryPaths([
      userMessage(m1),
      userMessage('unrelated turn'),
      userMessage(m2),
    ])
    expect([...out.paths].sort()).toEqual(['/m/a.md', '/m/b.md', '/m/c.md'])
    expect(out.totalBytes).toBe(350)
  })

  it('ignores messages without a marker and malformed markers', () => {
    const out = collectSurfacedMemoryPaths([
      userMessage('plain text'),
      userMessage('<!--nexus:relevant-memories:{bad json}-->'),
    ])
    expect(out.paths.size).toBe(0)
    expect(out.totalBytes).toBe(0)
  })

  it('handles Windows paths with backslashes', () => {
    const marker = buildMarker(['C:\\Users\\me\\.velloc\\memory\\x.md'], 42)
    const out = collectSurfacedMemoryPaths([userMessage(marker)])
    expect([...out.paths]).toEqual(['C:\\Users\\me\\.velloc\\memory\\x.md'])
  })
})

// ===========================================================================
// collectRecentToolNames
// ===========================================================================

describe('collectRecentToolNames', () => {
  it('collects tool names used after the last user message, deduped', () => {
    const messages = [
      userMessage('old turn'),
      assistantToolCalls('Read'),
      userMessage('current turn'),
      assistantToolCalls('Grep', 'Read'),
      assistantToolCalls('Read'),
    ]
    expect(collectRecentToolNames(messages).sort()).toEqual(['Grep', 'Read'])
  })

  it('returns [] when no tools used since last user message', () => {
    expect(collectRecentToolNames([userMessage('hi')])).toEqual([])
  })
})

// ===========================================================================
// recallNoteBanner
// ===========================================================================

describe('recallNoteBanner', () => {
  it('uses a saved-age header for fresh memories', () => {
    expect(recallNoteBanner('/m/x.md', Date.now())).toBe(
      'Memory (saved today): /m/x.md:',
    )
  })

  it('leads with the staleness caveat for old memories', () => {
    const header = recallNoteBanner('/m/x.md', Date.now() - 9 * DAY)
    expect(header).toContain('Saved 9 days ago')
    expect(header.trimEnd()).toMatch(/Memory: \/m\/x\.md:$/)
  })
})

// ===========================================================================
// loadRecallNotes
// ===========================================================================

function makeFs(files: Record<string, string>): RuntimeFs {
  return {
    ...unconfiguredFs,
    async readFile(path: string): Promise<string> {
      if (path in files) return files[path]!
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  } as RuntimeFs
}

describe('loadRecallNotes', () => {
  it('reads files and attaches a freshness header', async () => {
    installProcessFs(makeFs({ '/m/user_role.md': 'I am a doctor.' }))
    const out = await loadRecallNotes([
      { path: '/m/user_role.md', mtimeMs: Date.now() },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe('I am a doctor.')
    expect(out[0]!.header).toBe('Memory (saved today): /m/user_role.md:')
  })

  it('truncates files over the line cap and appends a note', async () => {
    const big = Array.from({ length: 500 }, (_v, i) => `line ${i}`).join('\n')
    installProcessFs(makeFs({ '/m/big.md': big }))
    const out = await loadRecallNotes([
      { path: '/m/big.md', mtimeMs: Date.now() },
    ])
    expect(out[0]!.content).toContain('This memory file was truncated')
    expect(out[0]!.content).toContain('/m/big.md')
    // 200-line cap → first 200 lines retained, line 200 dropped.
    expect(out[0]!.content).toContain('line 199')
    expect(out[0]!.content).not.toContain('line 200\n')
  })

  it('drops files that fail to read', async () => {
    installProcessFs(makeFs({}))
    const out = await loadRecallNotes([
      { path: '/m/missing.md', mtimeMs: Date.now() },
    ])
    expect(out).toEqual([])
  })
})

// ===========================================================================
// buildRelevantMemoryInjection — fast-return gates (no model call)
// ===========================================================================

describe('buildRelevantMemoryInjection gates', () => {
  const base = {
    messages: [] as Message[],
    signal: new AbortController().signal,
  }

  it('returns null when memory is disabled', async () => {
    const out = await buildRelevantMemoryInjection({
      ...base,
      query: 'find the auth bug',
      toolUseContext: minimalContext('anthropic'),
      providerId: 'anthropic',
      runtimeConfig: makeRuntimeConfig({ VELLOC_MEMORY: 'off' }),
    })
    expect(out).toBeNull()
  })

  it('returns null when recall is killed by env var', async () => {
    const out = await buildRelevantMemoryInjection({
      ...base,
      query: 'find the auth bug',
      toolUseContext: minimalContext('anthropic'),
      providerId: 'anthropic',
      runtimeConfig: makeRuntimeConfig({
        VELLOC_MEMORY_RECALL: 'off',
      }),
    })
    expect(out).toBeNull()
  })

  it('returns null when settings.memoryRecallEnabled is false', async () => {
    const out = await buildRelevantMemoryInjection({
      ...base,
      query: 'find the auth bug',
      toolUseContext: minimalContext('anthropic', { memoryRecallEnabled: false }),
      providerId: 'anthropic',
      runtimeConfig: makeRuntimeConfig(),
    })
    expect(out).toBeNull()
  })

  it('returns null when settings.autoMemoryEnabled is false (master gate)', async () => {
    const out = await buildRelevantMemoryInjection({
      ...base,
      query: 'find the auth bug',
      toolUseContext: minimalContext('anthropic', { autoMemoryEnabled: false }),
      providerId: 'anthropic',
      runtimeConfig: makeRuntimeConfig(),
    })
    expect(out).toBeNull()
  })

  it('returns null for a single-word prompt', async () => {
    const out = await buildRelevantMemoryInjection({
      ...base,
      query: 'hello',
      toolUseContext: minimalContext('anthropic'),
      providerId: 'anthropic',
      runtimeConfig: makeRuntimeConfig(),
    })
    expect(out).toBeNull()
  })

  it('returns null when no provider can be resolved', async () => {
    const out = await buildRelevantMemoryInjection({
      ...base,
      query: 'find the auth bug',
      toolUseContext: minimalContext(undefined),
      providerId: undefined,
      runtimeConfig: makeRuntimeConfig(),
    })
    expect(out).toBeNull()
  })

  it('returns null when the session byte budget is already spent', async () => {
    const spent = buildMarker(['/m/a.md'], 60 * 1024 + 1)
    const out = await buildRelevantMemoryInjection({
      ...base,
      messages: [userMessage(spent)],
      query: 'find the auth bug',
      toolUseContext: minimalContext('anthropic'),
      providerId: 'anthropic',
      runtimeConfig: makeRuntimeConfig(),
    })
    expect(out).toBeNull()
  })
})

// ===========================================================================
// beginRecallLookahead — the non-blocking handle
// ===========================================================================

describe('beginRecallLookahead', () => {
  const base = {
    messages: [] as Message[],
    signal: new AbortController().signal,
  }

  it('returns immediately with settledAt null, then settles', async () => {
    const handle = beginRecallLookahead({
      ...base,
      query: 'find the auth bug',
      // Disabled memory → the promise resolves null fast, but the handle
      // itself must come back synchronously, unsettled.
      toolUseContext: minimalContext('anthropic'),
      providerId: 'anthropic',
      runtimeConfig: makeRuntimeConfig({ VELLOC_MEMORY: 'off' }),
    })
    expect(handle.settledAt).toBeNull()
    expect(handle.consumed).toBe(false)

    await expect(handle.promise).resolves.toBeNull()
    // settledAt is set via promise.finally — flush the microtask queue.
    await new Promise(r => setTimeout(r, 0))
    expect(handle.settledAt).not.toBeNull()
  })

  it('resolves null (never rejects) when the injection build throws', async () => {
    // An fs that throws on every call makes resolveMemoryDir/scan blow up
    // after the cheap gates pass; the prefetch must swallow it.
    installProcessFs(unconfiguredFs)
    try {
      const handle = beginRecallLookahead({
        ...base,
        query: 'find the auth bug',
        toolUseContext: minimalContext('anthropic'),
        providerId: 'anthropic',
        runtimeConfig: makeRuntimeConfig(),
      })
      await expect(handle.promise).resolves.toBeNull()
    } finally {
      resetProcessFs()
    }
  })
})

// ===========================================================================
// The selector's system prompt — what actually goes on the wire
// ===========================================================================

/**
 * A memory dir with one `[user]`-type file, plus a capturing `callModel` so we
 * can read the system prompt the selector really sent. `queryFastModel` reads
 * the transport off `toolUseContext.options.callModel`, so a stub there is the
 * whole seam.
 */
function selectorHarness(manifestFiles: Record<string, string>) {
  const dir = '/home/user/.velloc/projects/p/memory/'
  const fs: RuntimeFs = {
    ...unconfiguredFs,
    async readdir() {
      // `walkMemoryDir` calls isFile()/isDirectory() as METHODS, not fields.
      return Object.keys(manifestFiles).map(name => ({
        name,
        isFile: () => true,
        isDirectory: () => false,
      })) as never
    },
    async readFile(path: string) {
      const name = path.slice(path.lastIndexOf('/') + 1)
      const body = manifestFiles[name]
      if (body === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return body
    },
    async stat() {
      return { size: 128, mtimeMs: Date.now() } as never
    },
  }
  installProcessFs(fs)

  const seen: { systemPrompt?: unknown } = {}
  const callModel = async function* (args: { baseInstructions?: unknown }) {
    seen.systemPrompt = args.baseInstructions
    // Select nothing — this test is about the REQUEST, not the reply.
    yield {
      type: MSG_TYPE_ASSISTANT,
      uuid: 'a',
      message: {
        role: ROLE_ASSISTANT,
        content: [{ type: 'text', text: '{"files": []}' }],
      },
    } as unknown as Message
  }

  const context = {
    options: {
      cwd: '/home/user/project',
      projectRoot: '/home/user/project',
      mainLoopProviderId: 'anthropic',
      mainLoopModel: 'claude-haiku-4-5',
      callModel,
    },
    cancelSource: new AbortController(),
  } as unknown as ToolCallContext

  return { dir, context, seen }
}

describe('selector system prompt', () => {
  /**
   * `[user]` / `[project]` memories describe standing context, so their
   * descriptions overlap textually with almost any question — which is exactly
   * how a launch-plan memory gets recalled for an unrelated question that
   * merely says "publish". The rule that stops it has to be ON THE WIRE, not
   * just present in a source constant, so this asserts the system prompt the
   * selector actually sent. See the constant's comment.
   */
  it('tells the selector to match on what the question is about, not keyword overlap', async () => {
    const { dir, context, seen } = selectorHarness({
      'project_launch.md':
        '---\nname: launch\ndescription: Publicly launching the product\ntype: project\n---\n\nbody',
    })

    await pickRecallNotes({
      query: 'how do I publish this skill to the marketplace',
      memoryDir: dir,
      signal: context.cancelSource.signal,
      toolUseContext: context,
      providerId: 'anthropic',
    })

    const sent = String(seen.systemPrompt ?? '')
    expect(sent, 'the selector call was never made').not.toBe('')
    expect(sent).toContain('A [user] or [project] note describes the user')
    expect(sent).toContain(
      'Choose by what the query is about, not by words it happens to share',
    )
  })

  /**
   * The selector prompt deliberately has no rule against re-selecting
   * memories it already returned: Nexus removes already-surfaced files from
   * the candidate list before the manifest is built, so the model cannot
   * re-select one. Asserting the rule's ABSENCE keeps a future edit from
   * adding a rule that describes a situation this architecture cannot produce.
   */
  it('omits the re-selection rule, which this architecture makes unnecessary', async () => {
    const { dir, context, seen } = selectorHarness({
      'feedback_x.md':
        '---\nname: x\ndescription: A rule\ntype: feedback\n---\n\nbody',
    })

    await pickRecallNotes({
      query: 'some multi word query',
      memoryDir: dir,
      signal: context.cancelSource.signal,
      toolUseContext: context,
      providerId: 'anthropic',
    })

    expect(String(seen.systemPrompt ?? '')).not.toContain('re-select')
  })

  /** The de-dup that replaces it: already-surfaced files never reach the
   *  manifest, so the model is never even offered them. */
  it('drops already-surfaced files from the manifest it sends', async () => {
    const { dir, context, seen } = selectorHarness({
      'project_launch.md':
        '---\nname: launch\ndescription: Publicly launching the product\ntype: project\n---\n\nbody',
      'feedback_x.md':
        '---\nname: x\ndescription: A rule about tests\ntype: feedback\n---\n\nbody',
    })
    const seenPrompt: { userPrompt?: string } = {}
    const options = (context as unknown as {
      options: { callModel: unknown }
    }).options
    const inner = options.callModel as (a: {
      baseInstructions?: unknown
      messages?: unknown
    }) => AsyncGenerator<Message, void, unknown>
    options.callModel = async function* (args: {
      baseInstructions?: unknown
      messages?: Array<{ message?: { content?: unknown } }>
    }) {
      seenPrompt.userPrompt = JSON.stringify(args.messages ?? [])
      yield* inner(args)
    } as unknown as typeof inner

    await pickRecallNotes({
      query: 'some multi word query',
      memoryDir: dir,
      signal: context.cancelSource.signal,
      toolUseContext: context,
      providerId: 'anthropic',
      alreadyInjected: new Set([`${dir}project_launch.md`]),
    })

    const body = seenPrompt.userPrompt ?? ''
    expect(body, 'the selector call was never made').not.toBe('')
    expect(body).toContain('feedback_x.md')
    expect(body).not.toContain('project_launch.md')
    expect(seen.systemPrompt).toBeDefined()
  })
})
