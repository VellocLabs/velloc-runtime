import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message, QueryTerminal } from '../runtime/RuntimeTypes'
import {
  resetSessionModelSettingsSnapshot,
  setSessionModelSettingsSnapshot,
} from '../models/tierSettingsSnapshot'
import {
  __testInternals,
  createBrowserAutoCompact,
  performCompaction,
} from '../context/compaction/autoTrigger'
import {
  defaultMessageCompactionSettings,
  mergeAgentLoopSettings,
} from '../config/agentLoopConfig'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import {
  createPostCompactPlanReferenceMessage,
  createPostCompactReadRestoreMessage,
} from '../messages/contextAttachments'
import { installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'
import {
  MSG_TYPE_STREAM_EVENT,
  PART_TEXT,
  PART_IMAGE,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  ROLE_TOOL,
  ROLE_USER,
  STREAM_COMPACT_PROGRESS,
  SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
} from '../runtime/VercelModelConstants'
import { estimateTranscriptTokens } from '../engine/tokenCounts'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

// Autocompaction tests. The gate fires on token pressure:
// tokenCountWithEstimation(messages) >= foldTriggerTokens(model).
// The LLM summarizer call is stubbed at the bridge layer; these tests cover
// the threshold math and the post-compaction message shape.

const {
  usableWindowTokens,
  foldTriggerTokens,
  dropPicturesForSummary,
  buildSummarizationBase,
  shedOldestForOverflowRetry,
} = __testInternals

afterEach(() => {
  resetProcessFs()
})

function userText(text: string): Message {
  return {
    type: 'user',
    uuid: `user-${text.slice(0, 8)}`,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  } as Message
}

function assistantText(text: string): Message {
  return {
    type: 'assistant',
    uuid: `assistant-${text.slice(0, 8)}`,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as Message
}

// createPostCompactPlanReferenceMessage re-injects the session's plan file:
// the plan must survive a compaction. The plan-mode reminder only fires
// while mode === 'plan', so without this an auto-compact during implementation
// silently drops the approved plan from the model's context.
describe('post-compact plan preservation', () => {
  const planContext = () =>
    createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      sessionId: 'plan-compact-sess',
    })

  it('re-injects the plan file contents after compaction', async () => {
    installProcessFs({
      readFile: async () => '# Plan\n1. do the thing',
    } as never)
    const message = await createPostCompactPlanReferenceMessage(planContext())
    expect(message).not.toBeNull()
    const content = message!.message.content as string
    expect(content).toContain('A plan file exists from plan mode at:')
    expect(content).toContain('# Plan')
    expect(content).toContain('1. do the thing')
    expect(content).toContain(
      'Pick the plan back up only where it still applies',
    )
  })

  it('returns null when there is no plan file (the common case)', async () => {
    installProcessFs({
      readFile: async () => {
        const err = new Error('ENOENT') as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      },
    } as never)
    expect(await createPostCompactPlanReferenceMessage(planContext())).toBeNull()
  })

  it('returns null for an empty/whitespace plan file', async () => {
    installProcessFs({ readFile: async () => '   \n\n' } as never)
    expect(await createPostCompactPlanReferenceMessage(planContext())).toBeNull()
  })

  it('truncates a runaway plan so it cannot eat the post-compact budget', async () => {
    installProcessFs({ readFile: async () => 'x'.repeat(50_000) } as never)
    const message = await createPostCompactPlanReferenceMessage(planContext())
    const content = message!.message.content as string
    expect(content).toContain('[plan truncated]')
    expect(content.length).toBeLessThan(25_000)
  })

  it('returns null without a tool-use context', async () => {
    expect(await createPostCompactPlanReferenceMessage(undefined)).toBeNull()
  })
})

it('creates post-compact Read restore messages from recent read paths', async () => {
  installProcessFs({
    stat: async () => ({ isFile: () => true, size: 11, mtimeMs: 1 }),
    readFile: async () => 'hello world',
  } as never)

  const message = await createPostCompactReadRestoreMessage({
    readPaths: new Set(['/workspace/a.txt']),
  })

  expect(message).not.toBeNull()
  const content = message!.message.content as string
  expect(content).toContain('Recent Read file content restored after compaction')
  expect(content).toContain('<file path="/workspace/a.txt">')
  expect(content).toContain('hello world')
})

it('restores cached Read slices with their offset and limit after compaction', async () => {
  installProcessFs({
    stat: async () => {
      throw new Error('cached read restore should not hit fs')
    },
    readFile: async () => {
      throw new Error('cached read restore should not hit fs')
    },
  } as never)

  const message = await createPostCompactReadRestoreMessage({
    readFileState: new Map([
      [
        '/workspace/process_tool.cc',
        {
          content: '490\tvoid ProcessTool::RunBashOnUI(...) {\n491\t  // relevant slice',
          timestamp: 20,
          offset: 490,
          limit: 80,
        },
      ],
    ]),
  })

  expect(message).not.toBeNull()
  const content = message!.message.content as string
  expect(content).toContain(
    '<file path="/workspace/process_tool.cc" offset="490" limit="80">',
  )
  expect(content).toContain('490\tvoid ProcessTool::RunBashOnUI')
})
it('does not re-inject an image Read base64 payload into the post-compact restore', async () => {
  // An image Read caches the RAW tool-result JSON as its state content, base64
  // and all. Restoring it unchanged puts the payload back as a TEXT part
  // inside a system-reminder, where it is invisible to every media defence:
  // never aged out, never charged, never downscaled. This is the mechanism the
  // incident transcript showed, four blobs re-injected three messages after the
  // compact boundary, so the compaction handed the model a wall of base64
  // instead of shrinking the context it was invoked to shrink.
  installProcessFs({
    stat: async () => {
      throw new Error('cached read restore should not hit fs')
    },
    readFile: async () => {
      throw new Error('cached read restore should not hit fs')
    },
  } as never)

  const base64 = 'A'.repeat(40_000)
  const message = await createPostCompactReadRestoreMessage({
    readFileState: new Map([
      [
        '/workspace/shot.png',
        {
          content: JSON.stringify({
            message: 'Image file read: /workspace/shot.png',
            content_parts: [
              { type: 'image', image: base64, mimeType: 'image/png' },
            ],
          }),
          // Newest, so it is the first candidate the restore loop considers.
          timestamp: 30,
        },
      ],
      [
        '/workspace/notes.md',
        { content: 'plain text worth restoring', timestamp: 20 },
      ],
    ]),
  })

  expect(message).not.toBeNull()
  const content = message!.message.content as string
  expect(content, 'base64 payload not re-injected').not.toContain(base64)
  expect(content, 'image file skipped entirely').not.toContain(
    '/workspace/shot.png',
  )
  // Skipped, not fatal: the budget is untouched so later text files still
  // restore. A break here would have cost the model the rest of the set.
  expect(content, 'later text file still restored').toContain(
    'plain text worth restoring',
  )
})
it('still restores a TEXT file that inlines a base64 data URI', async () => {
  // Only a cached media Read (a serialized result object) is skipped. A text
  // file the model was editing that happens to inline an icon as a data URI is
  // line-numbered text, and must come back like any other text file.
  installProcessFs({
    stat: async () => {
      throw new Error('cached read restore should not hit fs')
    },
    readFile: async () => {
      throw new Error('cached read restore should not hit fs')
    },
  } as never)

  const icon = 'A'.repeat(1_000)
  const html = `1\t<html>\n2\t<img src="data:image/png;base64,${icon}">\n3\t</html>`
  const fixture = `1\t{\n2\t  "data": "${icon}"\n3\t}`
  const message = await createPostCompactReadRestoreMessage({
    readFileState: new Map([
      ['/workspace/index.html', { content: html, timestamp: 30 }],
      ['/workspace/fixture.json', { content: fixture, timestamp: 20 }],
    ]),
  })

  expect(message).not.toBeNull()
  const content = message!.message.content as string
  expect(content).toContain('<file path="/workspace/index.html">')
  expect(content).toContain('<file path="/workspace/fixture.json">')
})


it('seeds post-compact Read stub state for restored cached reads', async () => {
  installProcessFs({
    stat: async () => {
      throw new Error('cached read restore should not hit fs')
    },
    readFile: async () => {
      throw new Error('cached read restore should not hit fs')
    },
  } as never)

  const toolUseContext = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  toolUseContext.postCompactReadFileState = new Map()

  await createPostCompactReadRestoreMessage({
    readFileState: new Map([
      [
        '/workspace/restored.txt',
        {
          content: '1\trestored',
          timestamp: 20,
          mtimeMs: 99,
          offset: undefined,
          limit: 1,
          partialRead: true,
        },
      ],
    ]),
    toolUseContext,
  })

  expect(toolUseContext.postCompactReadFileState.get('/workspace/restored.txt')).toMatchObject({
    content: '1\trestored',
    mtimeMs: 99,
    limit: 1,
    partialRead: true,
    postCompactRestored: true,
  })
})
it('records NO stub state for a truncated partial-view restore', async () => {
  // Regression: a PARTIAL view (offset/limit) whose content exceeds the
  // per-file token cap delivers only a prefix of its slice. The stub's
  // exact-range match would claim the WHOLE offset+limit range, telling the
  // model "file unchanged" for lines the truncation cut away — so a truncated
  // partial view must record no stub state at all (re-reads hit the disk).
  const raw = Array.from(
    { length: 400 },
    (_, i) => `${i + 100}\t${'y'.repeat(40)}`,
  ).join('\n')
  installProcessFs({
    stat: async () => {
      throw new Error('cached read restore should not hit fs')
    },
    readFile: async () => {
      throw new Error('cached read restore should not hit fs')
    },
  } as never)

  const toolUseContext = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  toolUseContext.postCompactReadFileState = new Map()

  const message = await createPostCompactReadRestoreMessage({
    readFileState: new Map([
      [
        '/workspace/slice.txt',
        {
          content: raw,
          timestamp: 20,
          mtimeMs: 7,
          offset: 100,
          limit: 400,
          partialRead: true,
        },
      ],
    ]),
    contextWindow: 500_000,
    toolUseContext,
  })

  // The (truncated) restore content still reaches the model…
  expect(message!.message.content as string).toContain(
    '[post-compact restore truncated]',
  )
  // …but no stub state is recorded, so a re-read of the slice hits the disk.
  expect(
    toolUseContext.postCompactReadFileState.has('/workspace/slice.txt'),
  ).toBe(false)
})
it('records delivered line coverage for a truncated full-file restore', async () => {
  // Regression: a full-file read (partialRead false) too large for the
  // per-file token cap gets truncated on restore, but must not advertise itself
  // as carrying the whole file — the seeded stub state records how many leading
  // lines actually reached the model so deep re-reads still hit the disk.
  const raw = Array.from(
    { length: 400 },
    (_, i) => `${i + 1}\t${'x'.repeat(40)}`,
  ).join('\n')
  installProcessFs({
    stat: async () => {
      throw new Error('cached read restore should not hit fs')
    },
    readFile: async () => {
      throw new Error('cached read restore should not hit fs')
    },
  } as never)

  const toolUseContext = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  toolUseContext.postCompactReadFileState = new Map()

  await createPostCompactReadRestoreMessage({
    readFileState: new Map([
      [
        '/workspace/big.txt',
        {
          content: raw,
          timestamp: 20,
          mtimeMs: 7,
          offset: undefined,
          limit: undefined,
          partialRead: false,
        },
      ],
    ]),
    contextWindow: 500_000,
    toolUseContext,
  })

  // The small window truncates at 2_500 tokens * 4 = 10_000 chars; coverage is
  // the count of complete lines inside that delivered prefix.
  const expectedCoverage = raw.slice(0, 10_000).split('\n').length - 1
  expect(expectedCoverage).toBeGreaterThan(0)
  expect(expectedCoverage).toBeLessThan(400)
  expect(
    toolUseContext.postCompactReadFileState.get('/workspace/big.txt'),
  ).toMatchObject({
    partialRead: false,
    postCompactRestored: true,
    restoredCoverageLines: expectedCoverage,
  })
})
function extractRestoredFileContent(content: string, path: string): string {
  const startMarker = `<file path="${path}">\n`
  const start = content.indexOf(startMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  const bodyStart = start + startMarker.length
  const end = content.indexOf('\n</file>', bodyStart)
  expect(end).toBeGreaterThanOrEqual(0)
  return content.slice(bodyStart, end)
}

it('scales post-compact Read restore file budget by context window', async () => {
  const raw = 'x'.repeat(30_000)
  installProcessFs({
    stat: async () => ({ isFile: () => true, size: raw.length, mtimeMs: 1 }),
    readFile: async () => raw,
  } as never)

  const small = await createPostCompactReadRestoreMessage({
    readPaths: new Set(['/workspace/b.txt']),
    contextWindow: 500_000,
  })
  const smallContent = extractRestoredFileContent(
    small!.message.content as string,
    '/workspace/b.txt',
  )
  expect(smallContent.indexOf('\n[post-compact restore truncated]')).toBe(
    10_000,
  )

  const large = await createPostCompactReadRestoreMessage({
    readPaths: new Set(['/workspace/b.txt']),
    contextWindow: 500_001,
  })
  const largeContent = extractRestoredFileContent(
    large!.message.content as string,
    '/workspace/b.txt',
  )
  expect(largeContent.indexOf('\n[post-compact restore truncated]')).toBe(
    20_000,
  )
})

it('scales post-compact Read restore file count by context window', async () => {
  // Regression: a deep multi-file survey re-reads ~15-20 distinct files between
  // compactions. The old flat cap of 5 files left the bulk of the re-read set
  // unrestored (so unstubbable). A frontier-window model (>=200K) now restores a
  // wider set; a small local-model window stays at 5 so the restore block can't
  // dominate post-compact context.
  installProcessFs({
    stat: async () => {
      throw new Error('cached read restore should not hit fs')
    },
    readFile: async () => {
      throw new Error('cached read restore should not hit fs')
    },
  } as never)

  const makeState = () =>
    new Map(
      Array.from({ length: 12 }, (_unused, i) => {
        const idx = String(i).padStart(2, '0')
        return [
          `/workspace/f${idx}.ts`,
          {
            content: `1\tcontent of file ${idx}`,
            timestamp: 100 - i,
            mtimeMs: 1,
            offset: 1,
            limit: 1,
            partialRead: true,
          },
        ] as const
      }),
    )

  const small = await createPostCompactReadRestoreMessage({
    readFileState: makeState(),
    contextWindow: 199_999,
  })
  const smallContent = small!.message.content as string
  expect(smallContent).toContain('/workspace/f04.ts')
  expect(smallContent).not.toContain('/workspace/f05.ts')

  const frontier = await createPostCompactReadRestoreMessage({
    readFileState: makeState(),
    contextWindow: 200_000,
  })
  const frontierContent = frontier!.message.content as string
  expect(frontierContent).toContain('/workspace/f05.ts')
  expect(frontierContent).toContain('/workspace/f11.ts')
})

function assistantToolCall(toolCallId: string): Message {
  return {
    type: 'assistant',
    uuid: `assistant-${toolCallId}`,
    message: {
      role: 'assistant',
      content: [
        {
          type: PART_TOOL_CALL,
          toolCallId,
          toolName: 'ExitPlanMode',
          args: {},
        },
      ],
    },
  } as Message
}

async function collectQuery<T>(
  generator: AsyncGenerator<T, QueryTerminal, unknown>,
): Promise<{ values: T[]; terminal: QueryTerminal }> {
  const values: T[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { values, terminal: next.value }
    values.push(next.value)
  }
}

describe('autocompact threshold', () => {
  // Uncatalogued / undefined model → 200K default window, no per-model
  // max-output (so the full 20K summary reserve applies).
  it('derives effective window = context window − summary reserve', () => {
    // 200_000 − min(20_000, 20_000) = 180_000
    expect(usableWindowTokens(undefined)).toBe(180_000)
  })

  it('threshold = effective window − 13K buffer', () => {
    // 180_000 − 13_000 = 167_000
    expect(foldTriggerTokens(undefined)).toBe(167_000)
  })

  it('scales with the per-model context window (1M variant)', () => {
    // `[1m]` → 1_000_000 window, 20K reserve, 13K buffer.
    expect(foldTriggerTokens('claude-opus[1m]')).toBe(967_000)
  })

  // Regression: small local-model windows (ollama llama3 = 8_192,
  // maxOutput 4_096 → effective 4_096) made `effective − buffer`
    // NEGATIVE, so the token-pressure gate was true for EVERY
  // conversation — autocompact fired on every turn forever (one wasted
  // summarizer call + tape rebuild per turn; the e2e ollama sweep died
  // on it). The 80%-of-effective floor keeps the gate meaningful.
  it('floors the threshold for small context windows (never negative)', () => {
    const threshold = foldTriggerTokens('llama3')
    // ollama llama3: window 8_192 − reserve min(4_096, 20_000) = 4_096
    // effective; buffer-based would be 4_096 − 13_000 < 0 → floor at
    // 80% of effective.
    expect(threshold).toBe(Math.floor(4_096 * 0.8))
    expect(threshold).toBeGreaterThan(0)
  })

  it('the floor never RAISES the threshold for big windows', () => {
    // 180_000 effective → buffer-based 167_000 beats 144_000 (80%).
    expect(foldTriggerTokens(undefined)).toBe(167_000)
  })
})

describe('summarizer call', () => {
  it('dropPicturesForSummary replaces standalone image blocks with [image]', () => {
    const withImage: Message = {
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', image: 'BASE64', mimeType: 'image/png' },
        ],
      },
    } as Message
    const [stripped] = dropPicturesForSummary([withImage])
    const content = (stripped as unknown as { message: { content: unknown[] } })
      .message.content
    expect(content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: '[image]' },
    ])
  })

  it('dropPicturesForSummary strips images nested in tool-result content', () => {
    const withToolImage: Message = {
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            content: [
              { type: 'text', text: 'shot:' },
              { type: 'image', image: 'B64', mimeType: 'image/png' },
            ],
          },
        ],
      },
    } as Message
    const [stripped] = dropPicturesForSummary([withToolImage])
    const tr = (
      stripped as unknown as { message: { content: Array<{ content: unknown }> } }
    ).message.content[0]
    expect(tr.content).toEqual([
      { type: 'text', text: 'shot:' },
      { type: 'text', text: '[image]' },
    ])
  })

  it('dropPicturesForSummary passes through text-only and non-user messages', () => {
    const textOnly: Message = {
      type: 'user',
      uuid: 'u3',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    } as Message
    const assistant = assistantText('reply')
    const result = dropPicturesForSummary([textOnly, assistant])
    expect(result[0]).toBe(textOnly) // unchanged → same reference
    expect(result[1]).toBe(assistant) // non-user → passthrough
  })

  it('splits repaired tool-result + text user turns for the compact bridge call', () => {
    const messages = [
      assistantToolCall('call_exit_plan'),
      userText('Plan mode reminder text.'),
    ]

    const prepared = buildSummarizationBase(messages)

    expect(prepared.map(message => message.role)).toEqual([
      'assistant',
      ROLE_TOOL,
      ROLE_USER,
    ])
    const toolContent = prepared[1]?.content
    expect(Array.isArray(toolContent) ? toolContent[0] : undefined).toMatchObject({
      type: PART_TOOL_RESULT_CANONICAL,
      toolCallId: 'call_exit_plan',
      isError: true,
    })
    const userContent = prepared[2]?.content
    expect(Array.isArray(userContent) ? userContent[0] : undefined).toMatchObject({
      type: 'text',
      text: 'Plan mode reminder text.',
    })
  })

  it('shedOldestForOverflowRetry drops the oldest ~20% and keeps the tail', () => {
    const msgs: Message[] = Array.from({ length: 10 }, (_, i) =>
      assistantText(`m${i}`),
    )
    const truncated = shedOldestForOverflowRetry(msgs)
    expect(truncated).not.toBeNull()
    expect(truncated).toHaveLength(8) // dropped floor(10 * 0.2) = 2
    expect(truncated?.[0]).toBe(msgs[2])
  })

  it('shedOldestForOverflowRetry returns null when there is nothing to drop', () => {
    expect(shedOldestForOverflowRetry([assistantText('only')])).toBeNull()
    expect(shedOldestForOverflowRetry([])).toBeNull()
  })
})

describe('compaction config', () => {
  it('defaults to enabled with no threshold override', () => {
    const s = defaultMessageCompactionSettings()
    expect(s.enabled).toBe(true)
    expect(s.autoCompactTokenThreshold).toBeUndefined()
    expect('summaryMaxChars' in s).toBe(false)
  })

  it('mergeAgentLoopSettings deep-merges messageCompaction overrides', () => {
    // Caller overrides ONE field; the rest must keep defaults.
    const merged = mergeAgentLoopSettings({
      messageCompaction: { autoCompactTokenThreshold: 5_000 } as never,
    })
    expect(merged.messageCompaction.autoCompactTokenThreshold).toBe(5_000)
    expect(merged.messageCompaction.enabled).toBe(true)
  })
})

describe('query autocompact progress', () => {
  it('emits compact progress for a successful async autocompact before the boundary', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })

    let modelMessages: Message[] | undefined
    const deps = assembleTurnDependencies(runtimeConfig, {
      autocompact: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 20))
        return {
          compactionResult: {
            boundaryMarker: {
              type: 'system',
              subtype: SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
              uuid: 'compact-boundary-1',
              message: 'Conversation compacted',
              compactMetadata: { trigger: 'auto', preTokens: 1234 },
            } as Message,
            summaryMessages: [
              {
                type: 'user',
                uuid: 'compact-summary-1',
                isMeta: true,
                message: { role: 'user', content: 'summary' },
              } as Message,
            ],
          },
        }
      },
      callModel: async function* (params) {
        modelMessages = params.messages
        yield assistantText('done')
      },
    })

    const { values } = await collectQuery(
      runTurnLoop({
        messages: [userText('long task')],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    const compactEventIndexes: number[] = []
    const compactEvents: Array<{ event: { stage?: unknown } }> = []
    values.forEach((value, index) => {
      if (
        !!value &&
        typeof value === 'object' &&
        (value as { type?: unknown }).type === MSG_TYPE_STREAM_EVENT &&
        ((value as { event?: { type?: unknown } }).event?.type === STREAM_COMPACT_PROGRESS)
      ) {
        compactEventIndexes.push(index)
        compactEvents.push(value as { event: { stage?: unknown } })
      }
    })
    expect(compactEvents.map(event => event.event.stage)).toEqual(['start', 'end'])

    const startIndex = compactEventIndexes[0] ?? -1
    const endIndex = compactEventIndexes[1] ?? -1
    const boundaryIndex = values.findIndex(
      value =>
        !!value &&
        typeof value === 'object' &&
        (value as { subtype?: unknown }).subtype === SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
    )
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(endIndex).toBeGreaterThan(startIndex)
    expect(boundaryIndex).toBeGreaterThan(endIndex)
    expect(modelMessages?.map(message => message.uuid)).toEqual([
      'compact-boundary-1',
      'compact-summary-1',
    ])
  })

  it('emits compact progress for a delayed failed autocompact attempt and then blocks at the hard limit', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })

    let callModelReached = false
    const deps = assembleTurnDependencies(runtimeConfig, {
      autocompact: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 20))
        return { failureStreak: 1 }
      },
      callModel: async function* () {
        callModelReached = true
        yield assistantText('done')
      },
    })

    const overBlockingLimit: Message = {
      type: 'assistant',
      uuid: 'assistant-high-usage',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'prior high usage turn' }],
        usage: {
          input_tokens: 378_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    } as Message

    const { values, terminal } = await collectQuery(
      runTurnLoop({
        messages: [userText('long task'), overBlockingLimit],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    const compactEvents = values.filter(
      value =>
        !!value &&
        typeof value === 'object' &&
        (value as { type?: unknown }).type === MSG_TYPE_STREAM_EVENT &&
        ((value as { event?: { type?: unknown } }).event?.type === STREAM_COMPACT_PROGRESS),
    )
    expect(compactEvents.map(event => (event as { event: { stage?: unknown } }).event.stage)).toEqual(['start', 'end'])
    expect(callModelReached).toBe(false)
    expect(terminal.reason).toBe('prompt_too_long')
    expect(
      values.some(
        value =>
          !!value &&
          typeof value === 'object' &&
          (value as { type?: unknown }).type === 'assistant' &&
          (value as { apiError?: unknown }).apiError === 'prompt_too_long',
      ),
    ).toBe(true)
  })

  it('continues after a delayed failed autocompact attempt when below the hard limit', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })

    let callModelReached = false
    const deps = assembleTurnDependencies(runtimeConfig, {
      autocompact: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 20))
        return { failureStreak: 1 }
      },
      callModel: async function* () {
        callModelReached = true
        yield assistantText('done')
      },
    })

    const { values, terminal } = await collectQuery(
      runTurnLoop({
        messages: [userText('long task')],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    const compactEvents = values.filter(
      value =>
        !!value &&
        typeof value === 'object' &&
        (value as { type?: unknown }).type === MSG_TYPE_STREAM_EVENT &&
        ((value as { event?: { type?: unknown } }).event?.type === STREAM_COMPACT_PROGRESS),
    )
    expect(compactEvents.map(event => (event as { event: { stage?: unknown } }).event.stage)).toEqual(['start', 'end'])
    expect(callModelReached).toBe(true)
    expect(terminal.reason).toBe('completed')
  })

  it('starts each iteration from the latest compact boundary before microcompact/autocompact', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })

    const boundary: Message = {
      type: 'system',
      subtype: SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
      uuid: 'compact-boundary-1',
      message: 'Conversation compacted',
      compactMetadata: { trigger: 'auto', preTokens: 350_000 },
    } as Message
    const summary: Message = {
      type: 'user',
      uuid: 'compact-summary-1',
      isMeta: true,
      message: { role: 'user', content: 'summary' },
    } as Message
    const postBoundaryUser = userText('continue after compact')
    const fullTranscript = [
      userText('old user before compact'),
      assistantText('old assistant before compact'),
      boundary,
      summary,
      postBoundaryUser,
    ]

    let microcompactMessages: Message[] | undefined
    let autocompactMessages: Message[] | undefined
    const deps = assembleTurnDependencies(runtimeConfig, {
      microcompact: async messages => {
        microcompactMessages = messages
        return { messages }
      },
      autocompact: async messages => {
        autocompactMessages = messages
        return {}
      },
      callModel: async function* () {
        yield assistantText('done')
      },
    })

    await collectQuery(
      runTurnLoop({
        messages: fullTranscript,
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    expect(microcompactMessages?.map(message => message.uuid)).toEqual([
      'compact-boundary-1',
      'compact-summary-1',
      postBoundaryUser.uuid,
    ])
    expect(autocompactMessages?.map(message => message.uuid)).toEqual([
      'compact-boundary-1',
      'compact-summary-1',
      postBoundaryUser.uuid,
    ])
  })
})

describe('forked-agent autocompact wiring', () => {
  // A fork with no explicit `deps` borrows the parent engine's autocompact from
  // `toolUseContext.options.autocompact`, as it borrows `callModel`, so a long-running sub-agent compacts.

  // An assistant message carrying real API `usage` — the anchor
  // `tokenCountWithEstimation` reads to size the live context.
  function assistantWithUsage(cachedPromptTokens: number): Message {
    return {
      type: 'assistant',
      uuid: 'assistant-anchor',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'prior turn' }],
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cachedPromptTokens,
          output_tokens: 50,
        },
      },
    } as Message
  }

  it('a fork over the token threshold borrows the main-loop autocompact and compacts', async () => {
    // Real autocompact bound to a fake STREAMING bridge that returns a summary
    // (same shape as `makeStreamingBridge` in the performCompaction tests).
    let summarizerStarted = false
    const fakeBridge = {
      servesModelRoutes: true,
      request: async (req: { route?: { action?: string }; payload: Record<string, unknown> }) => {
        // A raw open names its stream too (`streamId`): only a read is a read.
        if ('streamId' in req.payload && req.route?.action !== 'rawStreamOpen') {
          return {
            ok: true as const,
            result: {
              chunks: [
                {
                  type: 'content_block_delta',
                  delta: {
                    type: 'text_delta',
                    text: '<digest>fork compacted its history</digest>',
                  },
                },
              ],
              done: true,
            },
          }
        }
        summarizerStarted = true
        return { ok: true as const, result: { streamId: 'fork-stream-1' } }
      },
    } as unknown as Parameters<typeof createBrowserAutoCompact>[0]

    const runtimeConfig = new DefaultRuntimeConfig()
    const realAutocompact = createBrowserAutoCompact(
      fakeBridge,
      runtimeConfig as never,
    )

    // Publish the real autocompact + a turn-ending callModel on the context —
    // exactly what the parent engine does at construction
    // (`options.autocompact` / `options.callModel`; the module-global slots are
    // gone).
    let postCompactMessages: Message[] | undefined
    const fakeCallModel = (async function* (p: { messages: Message[] }) {
      postCompactMessages = p.messages
      yield {
        type: 'assistant',
        uuid: 'assistant-final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      } as Message
    }) as unknown as QueryRuntimeDeps['callModel']

    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })
    toolUseContext.options.callModel = fakeCallModel
    toolUseContext.options.autocompact = realAutocompact

    // Seed history OVER the uncatalogued-model threshold (200K window − 20K
    // summary reserve − 13K buffer = 167K): the assistant anchor reports
    // ~200K of live context.
    const { values } = await collectQuery(
      runTurnLoop({
        messages: [userText('do a long task'), assistantWithUsage(200_000)],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        // The exact flag `launchFork` passes (`useRealModelTransport`) —
        // marks this as a foreground fork that borrows the remembered deps,
        // and crucially passes NO `deps` (so the fork-path resolution runs).
        useRememberedCallModel: true,
      }),
    )

    // The fork actually ran the bridge-backed summarizer...
    expect(summarizerStarted).toBe(true)
    // ...yielded the compact-boundary marker into the stream...
    const boundary = values.find(
      v =>
        !!v &&
        typeof v === 'object' &&
        (v as { subtype?: unknown }).subtype === 'compact_boundary',
    )
    expect(boundary).toBeDefined()
    // ...and the post-compact model call saw the substituted summary tape.
    expect(JSON.stringify(postCompactMessages ?? [])).toContain(
      'compact_boundary',
    )
  })
})

describe('performCompaction', () => {
  // performCompaction uses the STREAMING bridge route (streamStart +
  // streamRead) so it works on backends that reject non-streaming requests.
  // This mock answers streamStart with a streamId and streamRead with one
  // text_delta chunk carrying `summaryText`, then done. The streamStart
  // payload (carrying maxOutputTokens etc.) is handed to `onStartPayload`.
  const makeStreamingBridge = (
    summaryText: string,
    onStartPayload?: (payload: Record<string, unknown>) => void,
  ) =>
    ({
      servesModelRoutes: true,
      request: async (req: { route?: { action?: string }; payload: Record<string, unknown> }) => {
        // A raw open names its stream too (`streamId`): only a read is a read.
        if ('streamId' in req.payload && req.route?.action !== 'rawStreamOpen') {
          return {
            ok: true as const,
            result: {
              chunks: [
                {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: summaryText },
                },
              ],
              done: true,
            },
          }
        }
        onStartPayload?.(req.payload)
        return { ok: true as const, result: { streamId: 'stream-1' } }
      },
    }) as unknown as Parameters<typeof performCompaction>[0]['bridgeTransport']

  /** Bridge whose streamStart FAILS with `failMessages` (one per attempt,
   *  shifted) before succeeding; every start payload is captured. */
  const makeFailingThenOkBridge = (
    failMessages: string[],
    payloads: Record<string, unknown>[],
  ) =>
    ({
      servesModelRoutes: true,
      request: async (req: { route?: { action?: string }; payload: Record<string, unknown> }) => {
        // A raw open names its stream too (`streamId`): only a read is a read.
        if ('streamId' in req.payload && req.route?.action !== 'rawStreamOpen') {
          return {
            ok: true as const,
            result: {
              chunks: [
                {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: '<digest>ok</digest>' },
                },
              ],
              done: true,
            },
          }
        }
        payloads.push(req.payload)
        const fail = failMessages.shift()
        if (fail) {
          return { ok: false as const, error: { message: fail } }
        }
        return { ok: true as const, result: { streamId: 'stream-1' } }
      },
    }) as unknown as Parameters<typeof performCompaction>[0]['bridgeTransport']

  const compactRuntimeConfig = () => {
    let uuid = 0
    return {
      createUUID: () => `uuid-${uuid++}`,
      createTimestamp: () => '2026-01-01T00:00:00.000Z',
      // The mock bridge scripts the model stream itself (`servesModelRoutes`).
      getEnv: () => undefined,
    } as unknown as Parameters<typeof performCompaction>[0]['runtimeConfig']
  }

  it.each([
    ['only the working-out block', '<worksheet>went through it all</worksheet>'],
    ['an empty digest block', '<digest></digest>'],
    ['a blank digest block after the worksheet', '<worksheet>notes</worksheet>\n<digest>\n  \n</digest>'],
  ])('a reply carrying %s is an empty summary, not a success', async (_label, reply) => {
    const mockBridge = makeStreamingBridge(reply)
    const result = await performCompaction({
      messages: [userText('do a task'), assistantText('did it')],
      bridgeTransport: mockBridge,
      runtimeConfig: compactRuntimeConfig(),
      mainLoopModel: 'test-model',
      trigger: 'manual',
    })
    expect(result).toEqual({ error: 'the model returned an empty summary' })
  })

  it('session-model policy: a specific compact pin drives the summarizer payload — model + ITS provider', async () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        compact: {
          mode: 'specific',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-flash',
        },
      },
    })
    try {
      let capturedPayload: Record<string, unknown> | undefined
      const mockBridge = makeStreamingBridge('<digest>ok</digest>', p => {
        capturedPayload = p
      })
      const result = await performCompaction({
        messages: [userText('do a task'), assistantText('did it')],
        bridgeTransport: mockBridge,
        runtimeConfig: compactRuntimeConfig(),
        mainLoopModel: 'claude-fable-5',
        providerId: 'anthropic',
        trigger: 'manual',
      })
      expect('summaryMessages' in result).toBe(true)
      // Cross-provider pin: the request must name the PIN's provider — the
      // parent's providerId would make the host reject `model: <id>`.
      expect(capturedPayload?.model).toBe('deepseek-v4-flash')
      expect(capturedPayload?.providerId).toBe('deepseek')
    } finally {
      resetSessionModelSettingsSnapshot()
    }
  })

  it('a pinned summarizer that fails (non-PTL) retries ONCE on the parent model', async () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        compact: {
          mode: 'specific',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-flash',
        },
      },
    })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const payloads: Record<string, unknown>[] = []
      const mockBridge = makeFailingThenOkBridge(
        ['model not available for this account'],
        payloads,
      )
      const result = await performCompaction({
        messages: [userText('do a task'), assistantText('did it')],
        bridgeTransport: mockBridge,
        runtimeConfig: compactRuntimeConfig(),
        mainLoopModel: 'claude-fable-5',
        providerId: 'anthropic',
        trigger: 'auto',
      })
      // The failed pin degraded to the parent pair and compaction SUCCEEDED —
      // a broken pin must not leave long sessions never compacting.
      expect('summaryMessages' in result).toBe(true)
      expect(payloads).toHaveLength(2)
      expect(payloads[0]).toMatchObject({
        model: 'deepseek-v4-flash',
        providerId: 'deepseek',
      })
      expect(payloads[1]).toMatchObject({
        model: 'claude-fable-5',
        providerId: 'anthropic',
      })
    } finally {
      info.mockRestore()
      resetSessionModelSettingsSnapshot()
    }
  })

  it('PTL on a pinned summarizer keeps the SAME-model head-shed — never the parent fallback', async () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        compact: {
          mode: 'specific',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-flash',
        },
      },
    })
    try {
      const payloads: Record<string, unknown>[] = []
      const mockBridge = makeFailingThenOkBridge(
        ['Prompt is too long for this model'],
        payloads,
      )
      const result = await performCompaction({
        messages: [
          userText('one'),
          assistantText('two'),
          userText('three'),
          assistantText('four'),
        ],
        bridgeTransport: mockBridge,
        runtimeConfig: compactRuntimeConfig(),
        mainLoopModel: 'claude-fable-5',
        providerId: 'anthropic',
        trigger: 'auto',
      })
      expect('summaryMessages' in result).toBe(true)
      // PTL = the head-shed loop's job, on the SAME model (its window is the
      // constraint being managed); the parent fallback is for other failures.
      expect(payloads).toHaveLength(2)
      expect(payloads[0]?.model).toBe('deepseek-v4-flash')
      expect(payloads[1]?.model).toBe('deepseek-v4-flash')
      expect(payloads[1]?.providerId).toBe('deepseek')
    } finally {
      resetSessionModelSettingsSnapshot()
    }
  })

  it('marks the injected summary message isMeta so the UI hides it', async () => {
    // The post-compact summary is internal context for the model's next turn,
    // not user-authored chat. The assistant-ui adapter filters isMeta user
    // messages to null, so without this flag the wall of summary text would
    // render as a bubble. The compact_boundary divider still shows.
    const mockBridge = makeStreamingBridge('<digest>did the thing</digest>')

    let uuid = 0
    const mockRuntimeConfig = {
      createUUID: () => `uuid-${uuid++}`,
      createTimestamp: () => '2026-01-01T00:00:00.000Z',
    } as unknown as Parameters<typeof performCompaction>[0]['runtimeConfig']

    const result = await performCompaction({
      messages: [userText('do a task'), assistantText('did it')],
      bridgeTransport: mockBridge,
      runtimeConfig: mockRuntimeConfig,
      mainLoopModel: 'test-model',
      trigger: 'auto',
    })

    if (!('summaryMessages' in result)) {
      throw new Error(`expected success, got error: ${result.error}`)
    }
    expect(result.summaryMessages).toHaveLength(1)
    const summary = result.summaryMessages[0] as Message & { isMeta?: boolean }
    expect(summary.type).toBe('user')
    expect(summary.isMeta).toBe(true)
  })

  it('caps the summary call to a safe maxOutputTokens for an uncatalogued model', async () => {
    // Regression guard: an uncatalogued model has no catalog max, so the cap
    // must fall back to the 8 192 floor (matching query/deps' main-loop floor),
    // NOT SUMMARY_REPLY_CAP (20K) — that can exceed a small model's
    // real output limit and the provider rejects the call ("Compaction failed").
    let capturedPayload: Record<string, unknown> | undefined
    const mockBridge = makeStreamingBridge('<digest>ok</digest>', p => {
      capturedPayload = p
    })

    let uuid = 0
    const mockRuntimeConfig = {
      createUUID: () => `uuid-${uuid++}`,
      createTimestamp: () => '2026-01-01T00:00:00.000Z',
    } as unknown as Parameters<typeof performCompaction>[0]['runtimeConfig']

    await performCompaction({
      messages: [userText('do a task'), assistantText('did it')],
      bridgeTransport: mockBridge,
      runtimeConfig: mockRuntimeConfig,
      mainLoopModel: 'totally-uncatalogued-model-xyz',
      trigger: 'manual',
    })

    expect(capturedPayload?.maxOutputTokens).toBe(8_192)
  })

  it('a runtime-served provider is summarized through its ModelProvider, not the host', async () => {
    // Regression: the summarizer sent `model.streamStart` on the raw bridge,
    // past the driver layer that only the main loop's `send` consulted — so a
    // provider the host does not know (OpenRouter: runtime-only) could chat
    // but never compact ("PROVIDER_UNKNOWN").
    const actions: string[] = []
    const opened: Array<Record<string, unknown>> = []
    const sseBody = new TextEncoder().encode(
      'data: {"choices":[{"index":0,"delta":{"content":"<digest>ok</digest>"},"finish_reason":"stop"}]}\n\n',
    )
    let served = false
    const hostBridge = {
      request: async (req: { route: { action: string }; payload: Record<string, unknown> }) => {
        actions.push(req.route.action)
        if (req.route.action === 'rawStreamOpen') {
          opened.push(req.payload)
          return { ok: true as const, result: { streamId: 'raw-1', status: 200, statusText: 'OK', finalUrl: '', headers: {} } }
        }
        if (req.route.action === 'rawStreamRead') {
          const chunk = served ? new Uint8Array() : sseBody
          served = true
          return { ok: true as const, result: { done: true, chunk } }
        }
        if (req.route.action === 'rawStreamCancel') return { ok: true as const, result: { ok: true } }
        return { ok: false as const, error: { code: 'PROVIDER_UNKNOWN', message: 'Unknown provider: openrouter' } }
      },
    } as unknown as Parameters<typeof performCompaction>[0]['bridgeTransport']

    let uuid = 0
    const result = await performCompaction({
      messages: [userText('do a task'), assistantText('did it')],
      bridgeTransport: hostBridge,
      runtimeConfig: {
        createUUID: () => `uuid-${uuid++}`,
        createTimestamp: () => '2026-01-01T00:00:00.000Z',
      } as unknown as Parameters<typeof performCompaction>[0]['runtimeConfig'],
      mainLoopModel: 'anthropic/claude-sonnet-5.5',
      providerId: 'openrouter',
      trigger: 'manual',
    })

    expect('summaryMessages' in result).toBe(true)
    expect(actions).not.toContain('streamStart')
    expect(opened[0]).toMatchObject({
      providerId: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
    })
  })

  it('forwards providerId on the summarizer request so the host can resolve the model', async () => {
    // Regression: the summarizer payload omitted `providerId`, so the host
    // couldn't route `model` (e.g. gpt-5.5 → openai) and rejected the call with
    // `model: gpt-5.5`. The auto path swallows that error, so long sessions
    // silently never compacted. The provider MUST ride the request.
    let capturedPayload: Record<string, unknown> | undefined
    const mockBridge = makeStreamingBridge('<digest>ok</digest>', p => {
      capturedPayload = p
    })

    let uuid = 0
    const mockRuntimeConfig = {
      createUUID: () => `uuid-${uuid++}`,
      createTimestamp: () => '2026-01-01T00:00:00.000Z',
    } as unknown as Parameters<typeof performCompaction>[0]['runtimeConfig']

    await performCompaction({
      messages: [userText('do a task'), assistantText('did it')],
      bridgeTransport: mockBridge,
      runtimeConfig: mockRuntimeConfig,
      mainLoopModel: 'gpt-5.5',
      providerId: 'openai',
      trigger: 'auto',
    })

    expect(capturedPayload?.providerId).toBe('openai')
  })

  it('sends the summaryRequest as a trailing user message without moving it into systemPrompt', async () => {
    // Keep the cache-friendly request shape: the compact template is
    // the final user message, not a system-prompt mutation. The prompt itself
    // carries an explicit guard so summarizers do not preserve this internal
    // request as the user's active task.
    let capturedPayload: Record<string, unknown> | undefined
    const mockBridge = makeStreamingBridge('<digest>ok</digest>', p => {
      capturedPayload = p
    })

    let uuid = 0
    const mockRuntimeConfig = {
      createUUID: () => `uuid-${uuid++}`,
      createTimestamp: () => '2026-01-01T00:00:00.000Z',
    } as unknown as Parameters<typeof performCompaction>[0]['runtimeConfig']

    const result = await performCompaction({
      messages: [
        userText('continue the shell streaming implementation'),
        assistantText('running focused checks'),
      ],
      bridgeTransport: mockBridge,
      runtimeConfig: mockRuntimeConfig,
      mainLoopModel: 'test-model',
      trigger: 'auto',
    })

    if (!('summaryMessages' in result)) {
      throw new Error(`expected success, got error: ${result.error}`)
    }

    const requestMessages =
      (capturedPayload?.messages as Array<{ role?: string; content?: unknown }> | undefined) ??
      []
    expect(requestMessages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    const summaryRequest = String(requestMessages.at(-1)?.content ?? '')
    expect(summaryRequest).toContain(
      'This message is internal machinery, not something the user wrote',
    )
    expect(summaryRequest).toContain(
      'Condense the conversation so far into a detailed digest',
    )
    expect(summaryRequest).toContain('Where the code was touched')
    expect(summaryRequest).toContain('In progress at the cutoff')
    expect(summaryRequest).not.toContain('Sites and Pages Visited')
    expect(summaryRequest).not.toContain('Current Tab and Sub-task')

    const systemPrompt = capturedPayload?.systemPrompt as string[] | undefined
    expect(systemPrompt?.join('\n')).toContain(
      'summarizing conversations',
    )
    expect(systemPrompt?.join('\n')).not.toContain(
      'This compact prompt is an internal summarization instruction',
    )

    const postCompactSummary = result.summaryMessages[0] as Message & {
      message: { content: string }
    }
    expect(postCompactSummary.message.content).toContain(
      'Carry on from exactly where things stopped',
    )
    expect(postCompactSummary.message.content).not.toContain(
      '<latest-user-message>',
    )
    expect(postCompactSummary.message.content).not.toContain(
      'internal compaction-request leakage',
    )
    expect(postCompactSummary.message.content).not.toContain('browser_actions')
  })

  it('does not character-cap compact summaries after formatting', async () => {
    // Compact summaries get no post-response character cap: the full
    // formatted body is kept so sections 7-9 survive restore.
    const longSummary =
      '<worksheet>drafting details</worksheet>' +
      '<digest>\n' +
      '1. Primary Request and Intent:\n   implement shell progress\n\n' +
      '2. Key Technical Concepts:\n   compact continuation\n\n' +
      '3. Files and Code Sections:\n' +
      '   - repeated file detail\n'.repeat(700) +
      '\n7. Pending Tasks:\n   - wire live progress event conversion\n\n' +
      '8. Current Work:\n   Reading nexus_web/src/engine/turn/turnDependencies.ts around stream event conversion.\n\n' +
      '9. Optional Next Step:\n   Patch live progress conversion and add focused coverage.\n' +
      '</digest>'
    const mockBridge = makeStreamingBridge(longSummary)

    let uuid = 0
    const mockRuntimeConfig = {
      createUUID: () => `uuid-${uuid++}`,
      createTimestamp: () => '2026-01-01T00:00:00.000Z',
    } as unknown as Parameters<typeof performCompaction>[0]['runtimeConfig']

    const result = await performCompaction({
      messages: [userText('implement shell progress'), assistantText('reading files')],
      bridgeTransport: mockBridge,
      runtimeConfig: mockRuntimeConfig,
      mainLoopModel: 'test-model',
      trigger: 'auto',
    })

    if (!('summaryMessages' in result)) {
      throw new Error(`expected success, got error: ${result.error}`)
    }

    const postCompactSummary = result.summaryMessages[0] as Message & {
      message: { content: string }
    }
    expect(postCompactSummary.message.content).not.toContain(
      '[…summary middle truncated]',
    )
    expect(postCompactSummary.message.content).not.toContain('<digest>')
    expect(postCompactSummary.message.content).toContain(
      'Summary:\n1. Primary Request',
    )
    expect(postCompactSummary.message.content).toContain(
      '3. Files and Code Sections',
    )
    expect(postCompactSummary.message.content).toContain('repeated file detail')
    expect(postCompactSummary.message.content).toContain('7. Pending Tasks')
    expect(postCompactSummary.message.content).toContain('8. Current Work')
    expect(postCompactSummary.message.content).toContain(
      'nexus_web/src/engine/turn/turnDependencies.ts',
    )
    expect(postCompactSummary.message.content).toContain('9. Optional Next Step')
  })

  it('returns the underlying error reason when the summarizer call fails', async () => {
    // When the bridge rejects (provider/context error), performCompaction must
    // surface the reason as `{ error }` so QueryEngine can show WHY /compact
    // failed instead of a generic message.
    const mockBridge = {
      servesModelRoutes: true,
      request: async () => ({
        ok: false as const,
        error: {code: 'LLM_ERROR', message: 'service unavailable'},
      }),
    } as unknown as Parameters<typeof performCompaction>[0]['bridgeTransport']

    let uuid = 0
    const mockRuntimeConfig = {
      createUUID: () => `uuid-${uuid++}`,
      createTimestamp: () => '2026-01-01T00:00:00.000Z',
    } as unknown as Parameters<typeof performCompaction>[0]['runtimeConfig']

    const result = await performCompaction({
      messages: [userText('do a task'), assistantText('did it')],
      bridgeTransport: mockBridge,
      runtimeConfig: mockRuntimeConfig,
      mainLoopModel: 'test-model',
      trigger: 'manual',
    })

    if (!('error' in result)) {
      throw new Error('expected an error result, got a successful compaction')
    }
    expect(result.error).toContain('service unavailable')
  })
})

// ===========================================================================
// Token estimation — media parts inside tool results count toward `tokenCountWithEstimation`, charged at the
// flattened wire cost (see `estimateMediaPartChars`).
// ===========================================================================

describe('token estimation counts media parts', () => {
  function readImageResult(base64: string): Message {
    return {
      type: 'user',
      uuid: 'u-read-image',
      message: {
        role: 'user',
        content: [
          {
            type: PART_TOOL_RESULT_CANONICAL,
            toolCallId: 'read-1',
            result: [
              { type: PART_TEXT, text: 'Image file read: /tmp/shot.png' },
              { type: PART_IMAGE, image: base64, mimeType: 'image/jpeg' },
            ],
          },
        ],
      },
    } as Message
  }

  it('charges a tool-result image part instead of scoring it zero', () => {
    // Without the fix only the 29-char text part counted and the whole message
    // scored single-digit tokens, so a screenshot-heavy turn was invisible to
    // the autocompact gate, `isAtBlockingLimit` and the token meter alike.
    const tokens = estimateTranscriptTokens([readImageResult('A'.repeat(120_000))])
    expect(tokens).toBeGreaterThan(1_000)
  })

  it('caps one media part at the native per-image ceiling', () => {
    // Media rides the wire as a native image block on every provider — the C++
    // translators hoist it out of the tool result where the wire format cannot
    // carry it inline (`openai_provider.cc`) — so it is billed geometrically
    // and capped near 1,600 tokens, NOT at its base64 char count. Charging the
    // base64 would over-count by ~70x and make `isAtBlockingLimit` refuse to
    // send a request that fits easily.
    const tokens = estimateTranscriptTokens([readImageResult('A'.repeat(190_000))])
    expect(tokens).toBeLessThan(2_000)
  })

  it('never charges a small image MORE than the bytes it occupies', () => {
    // `min(payloadLength, cap)`: a thumbnail must not be priced at the 1,600
    // token per-part ceiling just because it is an image.
    const tokens = estimateTranscriptTokens([readImageResult('A'.repeat(1_000))])
    expect(tokens).toBeLessThan(1_000)
  })

  it('keeps the blocking gate under the limit for three screenshots', () => {
    // The failure this pins: on a 200,000-window model the blocking limit is
    // 177,000 tokens, and three ~190k-char screenshots priced as flattened
    // base64 score ~380k — the request is never sent and the user is told to
    // start a new conversation over images that really cost a few thousand.
    const msgs = [
      readImageResult('A'.repeat(190_000)),
      readImageResult('B'.repeat(190_000)),
      readImageResult('C'.repeat(190_000)),
    ]
    expect(estimateTranscriptTokens(msgs)).toBeLessThan(177_000)
  })

  it('leaves a media-free tool result unchanged', () => {
    // Guards against the media branch swallowing ordinary text results.
    const textOnly = {
      type: 'user',
      uuid: 'u-text',
      message: {
        role: 'user',
        content: [
          {
            type: PART_TOOL_RESULT_CANONICAL,
            toolCallId: 'bash-1',
            result: [{ type: PART_TEXT, text: 'x'.repeat(4_000) }],
          },
        ],
      },
    } as Message
    expect(estimateTranscriptTokens([textOnly])).toBe(1_000)
  })
})
