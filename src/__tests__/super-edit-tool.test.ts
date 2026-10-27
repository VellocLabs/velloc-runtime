import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, ToolUseConfirmResolution } from '../runtime/RuntimeTypes'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolContract } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'

const {
  readFileMock,
  runJsMock,
  isAvailableMock,
  statMock,
  readdirMock,
  readFileBytesMock,
  writeFileMock,
  mkdirMock,
  unlinkMock,
  rmMock,
  renameMock,
  renameGate,
  preHookMock,
  postHookMock,
  headlessMock,
} = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  runJsMock: vi.fn(),
  isAvailableMock: vi.fn(() => true),
  statMock: vi.fn(),
  readdirMock: vi.fn(),
  readFileBytesMock: vi.fn(),
  writeFileMock: vi.fn(),
  mkdirMock: vi.fn(),
  unlinkMock: vi.fn(),
  rmMock: vi.fn(),
  renameMock: vi.fn(),
  // fs.rename is OPTIONAL on RuntimeFs (older host / non-native impls) —
  // the gate lets a test remove it to assert the NotSupportedError signal.
  renameGate: { enabled: true },
  // Hook / headless boundary — the engines are tested elsewhere; here we
  // assert SuperEdit WIRES them (fires the hook, honors a block, consults the
  // headless resolver in no-UI contexts). Default = permissive.
  preHookMock: vi.fn(async () => ({ blocked: false, message: '' })),
  postHookMock: vi.fn(async () => ''),
  headlessMock: vi.fn(async () => ({ behavior: 'deny', message: 'headless auto-deny' })),
}))

vi.mock('../utils/fs/runtimeFs', () => {
  const mockFs = () => ({
    readFile: readFileMock,
    stat: statMock,
    readdir: readdirMock,
    readFileBytes: readFileBytesMock,
    writeFile: writeFileMock,
    mkdir: mkdirMock,
    unlink: unlinkMock,
    rm: rmMock,
    get rename() {
      return renameGate.enabled ? renameMock : undefined
    },
  })
  return {
    processFs: mockFs,
    fsForContext: (c: { options: { fsOperations?: unknown } }) =>
      c.options.fsOperations ?? mockFs(),
  }
})
vi.mock('../browser/runJs/RunJsBroker', async importOriginal => ({
  // Keep the real exports (RunJsFailure in particular — the tool does an
  // `instanceof` on it, and a mock-only module would turn that into a
  // TypeError) and override just the two entry points.
  ...(await importOriginal<typeof import('../browser/runJs/RunJsBroker')>()),
  isRunJsAvailable: () => isAvailableMock(),
  runJs: (opts: unknown) => runJsMock(opts),
}))
// Keep the real permission machinery (buildFilePermissionContext,
// FILE_*_TOOLS, checkRead/Write pipelines) and stub only the hook + headless
// boundary the two findings are about.

// Imported AFTER the mocks are registered (vi.mock is hoisted above this).
import { RunJsFailure } from '../browser/runJs/RunJsBroker'
import {
  SuperEditTool,
  SUPER_EDIT_TOOL_DESCRIPTION,
  handleScriptFsOp,
  commitOverlay,
  formatScriptLocation,
  type CommitOutcome,
} from '../toolkit/builtin/superEdit'
import { OverlayFs } from '../browser/runJs/overlayFs'
import type { RunJsFsOp } from '../browser/runJs/runJsProtocol'
import { getPlanFilePathForSession } from '../utils/planFiles'
import { dirnameRuntimePath } from '../utils/runtimePaths'
import { deriveChildToolContext } from '../agents/forkedRun'
import {
  setSideTaskSink,
  type RunJsTaskFinish,
  type RunJsTaskStart,
} from '../backgroundTasks/sideTaskSink'

type FakeToolOptions = {
  permission?: { behavior: 'allow' | 'deny' | 'ask'; message?: string; updatedInput?: Record<string, unknown> }
  callData?: unknown
  requiresUI?: boolean
  readOnly?: boolean
  validate?: (input: Record<string, unknown>) => Promise<{ result: boolean; message?: string }>
  onCall?: (input: Record<string, unknown>) => void
}

function fakeTool(name: string, opts: FakeToolOptions = {}): ToolContract {
  const permission = opts.permission ?? { behavior: 'allow' as const }
  return {
    name,
    readsOnly: () => opts.readOnly ?? false,
    async selfVerdict() {
      return permission
    },
    async call(input: Record<string, unknown>) {
      opts.onCall?.(input)
      return { data: opts.callData ?? 'CALL_OK' }
    },
    haltsForUser: opts.requiresUI ? () => true : undefined,
    checkInput: opts.validate,
  } as unknown as ToolContract
}

/** Minimal getAppState with a permissionRules — what the nested gate's
 *  plan-mode / file-pipeline / rule phases read. */
function makeAppState(
  mode: string,
  extra: Record<string, unknown> = {},
): () => { permissionRules: Record<string, unknown> } {
  return () => ({
    permissionRules: {
      mode,
      extraWorkspaceRoots: new Map(),
      ...extra,
    },
  })
}

function makeContext(
  tools: ToolContract[],
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext {
  return {
    options: { tools, cwd: '/proj' },
    cancelSource: new AbortController(),
    toolRunSeams: { nested: { preHooks: (...a: unknown[]) => preHookMock(...(a as [])), postHooks: (...a: unknown[]) => postHookMock(...(a as [])), headlessDecision: (...a: unknown[]) => headlessMock(...(a as [])) } } as never,
    requestToolUseConfirm: undefined,
    ...overrides,
  } as unknown as ToolCallContext
}

const canUseTool = vi.fn() as unknown as PermissionDecider
const invokingRow = {} as unknown as Message

beforeEach(() => {
  readFileMock.mockReset()
  runJsMock.mockReset()
  isAvailableMock.mockReset()
  isAvailableMock.mockReturnValue(true)
  for (const m of [
    statMock,
    readdirMock,
    readFileBytesMock,
    writeFileMock,
    mkdirMock,
    unlinkMock,
    rmMock,
    renameMock,
  ]) {
    m.mockReset()
  }
  renameGate.enabled = true
  preHookMock.mockReset()
  preHookMock.mockResolvedValue({ blocked: false, message: '' })
  postHookMock.mockReset()
  postHookMock.mockResolvedValue('')
  headlessMock.mockReset()
  headlessMock.mockResolvedValue({ behavior: 'deny', message: 'headless auto-deny' })
})

describe('SuperEditTool.validateInput', () => {
  it('requires exactly one of code / path', async () => {
    const ctx = makeContext([])
    expect((await SuperEditTool.checkInput!({}, ctx)).result).toBe(false)
    expect((await SuperEditTool.checkInput!({ code: 'x', path: 'y' }, ctx)).result).toBe(false)
    expect((await SuperEditTool.checkInput!({ code: 'x' }, ctx)).result).toBe(true)
    expect((await SuperEditTool.checkInput!({ path: 'y' }, ctx)).result).toBe(true)
  })

  it('rejects a non-numeric timeoutSec', async () => {
    const ctx = makeContext([])
    const r = await SuperEditTool.checkInput!(
      { code: 'x', timeoutSec: 'soon' as unknown as number },
      ctx,
    )
    expect(r.result).toBe(false)
  })

  it('accepts `path` in every session type, including a noExecution one', async () => {
    // `code` and `path` are two ways to supply the SAME script — `path` is not
    // an execution capability. Whatever the file holds runs in the same
    // hardened realm an inline snippet does (no network, no process, no nested
    // worker; the permission-gated `workspace` facade as its only I/O), so a
    // non-executing session type has no reason to withhold it.
    const safeCodeCtx = makeContext([], {
      options: { tools: [], cwd: '/proj', templateType: 'safe_code' },
    } as unknown as Partial<ToolCallContext>)
    for (const ctx of [safeCodeCtx, makeContext([])]) {
      expect(
        (await SuperEditTool.checkInput!({ path: 'scripts/x.js' }, ctx)).result,
      ).toBe(true)
      expect(
        (await SuperEditTool.checkInput!({ code: 'return 1' }, ctx)).result,
      ).toBe(true)
    }
  })

  it('converts timeoutSec → ms for the broker and clamps to [1, 600]s', async () => {
    isAvailableMock.mockReturnValue(true)
    runJsMock.mockResolvedValue({ result: '1', logs: [] })
    // 5s → 5000ms.
    await SuperEditTool.call({ code: 'x', timeoutSec: 5 }, makeContext([]), canUseTool, invokingRow)
    expect(runJsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 5_000 }),
    )
    // Over the cap → 600s = 600000ms.
    await SuperEditTool.call({ code: 'x', timeoutSec: 9999 }, makeContext([]), canUseTool, invokingRow)
    expect(runJsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 600_000 }),
    )
  })
})

describe('SuperEditTool.description', () => {
  it('sends the static pure-mutation contract to the model (empty input)', async () => {
    // The serializer calls description with EMPTY input — this is the only
    // SuperEdit prose on the wire (bridgeSerialization.ts).
    const text = await SuperEditTool.description({}, { tools: [] } as never)
    expect(text).toBe(SUPER_EDIT_TOOL_DESCRIPTION)
    expect(text).toContain('const workspace: FileSystemDirectoryHandle')
    expect(text).toContain('function getDirectory(')
    // The one-call helpers lead the contract — they are the intended default
    // for file I/O (the handle walk is what models fell back to without
    // them), and the model only uses what the description names.
    expect(text).toContain('function readTextFile(path: string): Promise<string>')
    expect(text).toContain('function writeTextFile(path: string, text: string): Promise<void>')
    expect(text).toContain('function readFileBytes(path: string): Promise<Uint8Array>')
    expect(text).toContain(
      'function replaceTextFile(path: string, find: string, replace: string, options?: { all?: boolean }): Promise<number>',
    )
    // The exact-text editor must displace the read -> String.replace -> write
    // shape by NAME, and must carry its three failure modes: literal
    // replacement, unique-match-or-throw, and no partial write. Drop any of
    // them from the prose and the model reverts to hand-rolling the guard.
    expect(text).toContain('prefer over read \u2192 replace \u2192 write')
    expect(text).toContain('literal text, never patterns')
    expect(text).toContain('NotFoundError')
    expect(text).toContain('AmbiguousMatchError')
    expect(text).toContain('{ all: true }')
    // Uniform-newline compatibility: the model must know an LF `find` can hit
    // a CRLF file (so it stops escaping CRLF by hand) and that the file's EOL
    // wins. Behavior ships in fileHelpers.ts (superedit-newline-and-diff-order).
    expect(text).toContain('conservative LF↔CRLF fallback')
    expect(text).toContain("keep the file's line endings")
    expect(text).toContain('function writeFileBytes(path: string, bytes: Uint8Array | ArrayBuffer | ArrayBufferView): Promise<void>')
    expect(text.indexOf('readTextFile')).toBeLessThan(text.indexOf('const workspace'))
    // Behavior boundary: exploration belongs to search/read tools, not SuperEdit.
    expect(text).toContain('Use search/read tools first when you still need to explore')
    // Full multi-segment paths are the capability that kills the
    // segment-by-segment handle walk; the description states it ONCE.
    expect(text).toContain('Relative and absolute paths are\n// supported')
    expect(text).toContain("'..' is rejected")
    // Transaction contract, one paragraph: buffered, throw → nothing written,
    // external change → rejected, commit I/O failure → partial + reported.
    expect(text).toContain('BUFFERED until the script succeeds')
    expect(text).toContain('nothing is written')
    expect(text).toContain('the save is rejected')
    expect(text).toContain('partial commit')
    // The code/data rule keeps its one prohibition — without it models rebuild
    // file bodies as `[...].join('\\n')` inside `code`.
    expect(text).toContain('Do not reconstruct large data inside `code`')
    // The handle API is explicitly the ADVANCED tier below the helpers.
    expect(text).toContain('advanced operations not covered above')
    // Compact contract, not an API manual: the description stays under a
    // hard character budget (a rewrite cut it ~22%).
    expect(text.length).toBeLessThan(3900)
    // getDirectory must not read as a containment escape hatch.
    expect(text).toContain('access remains permission-gated')
    // Pure mutation: no tool proxy, no exec, no skill in the script surface.
    expect(text).not.toContain('tools.<')
    expect(text).not.toContain('function exec(')
    expect(text).not.toContain('function skill(')
    // And it no longer points anywhere for commands: no shipped session type
    // registers the `exec` tool, so naming it here would be a dangling
    // reference — the description just states that `workspace` is the only I/O.
    expect(text).not.toContain('`exec`')
    expect(text).toContain('These workspace-backed APIs are the only I/O.')
  })

  it('labels the permission dialog with the per-call description instead', async () => {
    // `toolExecution.ts` calls description with the REAL input — a one-line
    // summary belongs there, not the whole contract.
    const label = await SuperEditTool.description(
      { code: 'x', description: 'Count the TODOs' },
      { tools: [] } as never,
    )
    expect(label).toBe('Count the TODOs')
  })
})

describe('SuperEditTool.call', () => {
  it('reports unavailable and does not dispatch when no worker is attached', async () => {
    isAvailableMock.mockReturnValue(false)
    const res = await SuperEditTool.call({ code: 'x' }, makeContext([]), canUseTool, invokingRow)
    expect(res.data).toMatch(/unavailable/)
    expect(runJsMock).not.toHaveBeenCalled()
  })

  it('dispatches inline code and returns the serialized result + logs', async () => {
    runJsMock.mockResolvedValue({ result: '42', logs: [{ level: 'log', text: 'hi' }] })
    const res = await SuperEditTool.call({ code: 'return 42' }, makeContext([]), canUseTool, invokingRow)
    expect(runJsMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'return 42', timeoutMs: 30_000 }),
    )
    expect(res.data).toContain('42')
    expect(res.data).toContain('[log] hi')
  })

  it('reads a local path via the fs bridge before dispatching', async () => {
    readFileMock.mockResolvedValue('return "from-file"')
    runJsMock.mockResolvedValue({ result: 'from-file', logs: [] })
    const res = await SuperEditTool.call({ path: 'scripts/x.js' }, makeContext([]), canUseTool, invokingRow)
    expect(readFileMock).toHaveBeenCalledWith(expect.stringContaining('scripts/x.js'), { encoding: 'utf-8' })
    expect(runJsMock).toHaveBeenCalledWith(expect.objectContaining({ code: 'return "from-file"' }))
    expect(res.data).toContain('from-file')
  })

  it('an untrusted child cannot run a script file from outside its read root', async () => {
    // The script source is read straight off disk; its output / error text /
    // found-or-not would disclose an out-of-root file to the untrusted relay.
    readFileMock.mockResolvedValue('return "secret"')
    runJsMock.mockResolvedValue({ result: 'secret', logs: [] })
    const ctx = makeContext([])
    ;(ctx.options as { untrustedReadRoot?: string }).untrustedReadRoot = '/proj'
    const res = await SuperEditTool.call(
      { path: '/home/user/other/secret.js' },
      ctx,
      canUseTool,
      invokingRow,
    )
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/^Denied: .*outside this session's allowed root/)
    expect(readFileMock).not.toHaveBeenCalled()
    expect(runJsMock).not.toHaveBeenCalled()

    // Inside the root it still runs.
    const ok = await SuperEditTool.call({ path: 'scripts/x.js' }, ctx, canUseTool, invokingRow)
    expect(ok.data).toContain('secret')
  })

  it('surfaces a path read failure as a tool error', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'))
    const res = await SuperEditTool.call({ path: 'missing.js' }, makeContext([]), canUseTool, invokingRow)
    expect(res.data).toMatch(/could not read missing\.js/)
    expect(runJsMock).not.toHaveBeenCalled()
  })

  it('surfaces a broker error (timeout/abort) as a tool error', async () => {
    runJsMock.mockRejectedValue(new Error('SuperEdit timed out after 20ms.'))
    const res = await SuperEditTool.call({ code: 'x' }, makeContext([]), canUseTool, invokingRow)
    expect(res.data).toMatch(/SuperEdit error: SuperEdit timed out/)
  })

  it('appends the streamed console lines to a failed run', async () => {
    runJsMock.mockRejectedValue(
      new RunJsFailure('boom', [
        { level: 'log', text: 'step 1' },
        { level: 'warn', text: 'step 2' },
      ]),
    )
    const res = await SuperEditTool.call({ code: 'x' }, makeContext([]), canUseTool, invokingRow)
    expect(res.data).toMatch(/SuperEdit error: boom/)
    expect(res.data).toContain('--- console (2) ---')
    expect(res.data).toContain('[log] step 1')
    expect(res.data).toContain('[warn] step 2')
  })

  it('quotes the failing source line when the failure carries a script location', async () => {
    // The worker adjusts stack coordinates to SCRIPT-relative before they
    // reach the broker; the tool's job is the model-facing rendering: the
    // location on the headline plus the offending line quoted from `code` —
    // so the model fixes the line instead of guessing.
    runJsMock.mockRejectedValue(
      new RunJsFailure('x is not defined', [{ level: 'log', text: 'before' }], undefined, {
        line: 3,
        column: 11,
      }),
    )
    const code = 'const a = 1;\nconst b = 2;\nconst y = x + 1;'
    const res = await SuperEditTool.call({ code }, makeContext([]), canUseTool, invokingRow)
    expect(res.data).toContain('SuperEdit error: x is not defined\n(script line 3:11)')
    expect(res.data).toContain('> const y = x + 1;')
    // A line that fits is quoted whole and unlabelled — no window header.
    expect(res.data).not.toContain('Source from column')
    expect(res.data).toContain('[log] before')
  })

  it('windows a long one-line script at the failing column instead of quoting all of it', async () => {
    // The tool description pushes file content into `inputs`, so real scripts
    // are routinely ONE long line. Quoting the whole line hands the model back
    // the script it just wrote with the failure buried inside it; the window
    // starts 40 characters of lead-in before the column the engine reported.
    const prefix = 'const a = 1; '.repeat(20) // 260 chars, well past the cap
    const tail = 'await replaceTextFile(inputs.path, inputs.find, inputs.find)'
    const code = prefix + tail
    runJsMock.mockRejectedValue(
      new RunJsFailure(
        'replaceTextFile find and replace are identical; the edit would change nothing.',
        [],
        undefined,
        { line: 1, column: prefix.length + 1 },
      ),
    )
    const res = await SuperEditTool.call({ code }, makeContext([]), canUseTool, invokingRow)
    expect(res.data).toContain(
      'SuperEdit error: replaceTextFile find and replace are identical; the edit would change nothing.\n' +
        `(script line 1:${prefix.length + 1})`,
    )
    expect(res.data).toContain(
      `Source from column ${prefix.length - 39}:\n> ${prefix.slice(-40)}${tail}`,
    )
    // The 260 characters of source before the failure are NOT echoed back.
    expect(res.data).not.toContain(`> ${code}`)
    expect(res.data).not.toContain(prefix)
  })

  it('falls back to the plain message when no location is carried (timeout, crash)', async () => {
    runJsMock.mockRejectedValue(new RunJsFailure('SuperEdit timed out after 20ms.', []))
    const res = await SuperEditTool.call({ code: 'x' }, makeContext([]), canUseTool, invokingRow)
    expect(res.data).toContain('SuperEdit error: SuperEdit timed out after 20ms.')
    expect(res.data).not.toContain('script line')
  })

  it('re-throws (rather than swallowing) when the turn was aborted', async () => {
    const ctx = makeContext([])
    ctx.cancelSource.abort()
    runJsMock.mockRejectedValue(new Error('SuperEdit was interrupted.'))
    await expect(
      SuperEditTool.call({ code: 'x' }, ctx, canUseTool, invokingRow),
    ).rejects.toThrow(/interrupted/)
  })
})

describe('SuperEditTool.call — Super Edit (local_js) task surfacing', () => {
  function recordingSink(): { started: RunJsTaskStart[]; finished: RunJsTaskFinish[] } {
    const log = { started: [] as RunJsTaskStart[], finished: [] as RunJsTaskFinish[] }
    setSideTaskSink({
      forkStarted: () => {},
      forkProgress: () => {},
      forkFinished: () => {},
      fastCallStarted: () => {},
      fastCallFinished: () => {},
      runJsStarted: s => log.started.push(s),
      runJsFinished: f => log.finished.push(f),
    })
    return log
  }

  /** A parent AssistantMessage carrying one SuperEdit tool_use block, so the tool
   *  can recover its own tool call id (the local_js task's native + public id).
   *  `name` is parameterised so the legacy-spelling case can reuse this. */
  function parentWith(
    id: string,
    input: Record<string, unknown>,
    name = 'SuperEdit',
  ): Message {
    return {
      message: { content: [{ type: 'tool_use', id, name, input }] },
    } as unknown as Message
  }

  function ctxWithSession(sessionId = 's1'): ToolCallContext {
    const ctx = makeContext([])
    ;(ctx.options as unknown as { sessionId: string }).sessionId = sessionId
    return ctx
  }

  afterEach(() => setSideTaskSink(null))

  it('emits start (call id, code, params) and a success finish keyed by the tool call id', async () => {
    const log = recordingSink()
    runJsMock.mockResolvedValue({ result: '42', logs: [{ level: 'log', text: 'hi' }] })
    const input = { code: 'return 42', description: 'Count TODOs', timeoutSec: 5 }
    await SuperEditTool.call(
      input,
      ctxWithSession('sess-A'),
      canUseTool,
      parentWith('toolu_1', input),
    )
    expect(log.started).toHaveLength(1)
    expect(log.started[0]).toMatchObject({
      callId: 'toolu_1',
      spawnerSessionId: 'sess-A',
      description: 'Count TODOs',
      code: 'return 42',
      inlineCode: true,
      timeoutSec: 5,
    })
    expect(log.finished).toHaveLength(1)
    expect(log.finished[0]!.callId).toBe('toolu_1')
    expect(log.finished[0]!.status).toBe('success')
    expect(log.finished[0]!.resultText).toContain('42')
  })

  it('registers NO task when the parent block carries a different tool name', () => {
    // The tool recovers its own call id by scanning the parent message for its
    // tool_use block, matched on the wire name — so the name in `tools:` and the
    // name in the transcript must be the same string. This pins that the match
    // is exact: a block naming anything else (a stale `super_edit` from before
    // the rename, a typo, another tool) contributes no call id, so no
    // task is registered rather than a wrong one being attached.
    const log = recordingSink()
    runJsMock.mockResolvedValue({ result: '7', logs: [] })
    const input = { code: 'return 7', description: 'Mismatched parent' }
    return SuperEditTool.call(
      input,
      ctxWithSession('sess-mismatch'),
      canUseTool,
      parentWith('toolu_other', input, 'super_edit'),
    ).then(() => {
      expect(log.started).toHaveLength(0)
      expect(log.finished).toHaveLength(0)
    })
  })

  it('does NOT surface a task when the tool call id cannot be recovered', async () => {
    const log = recordingSink()
    runJsMock.mockResolvedValue({ result: '1', logs: [] })
    // invokingRow has no tool_use content → no id → no task registered.
    await SuperEditTool.call({ code: 'x' }, ctxWithSession(), canUseTool, invokingRow)
    expect(log.started).toHaveLength(0)
    expect(log.finished).toHaveLength(0)
  })

  it('registers + fails the task when a `path` read fails (no code ran)', async () => {
    const log = recordingSink()
    readFileMock.mockRejectedValue(new Error('ENOENT'))
    const input = { path: 'missing.js', description: 'From file' }
    const res = await SuperEditTool.call(
      input,
      ctxWithSession(),
      canUseTool,
      parentWith('toolu_2', input),
    )
    expect(res.data).toMatch(/could not read missing\.js/)
    expect(log.started).toHaveLength(1)
    expect(log.started[0]).toMatchObject({ callId: 'toolu_2', inlineCode: false, path: 'missing.js' })
    expect(log.finished[0]).toMatchObject({ callId: 'toolu_2', status: 'error' })
  })

  it('finishes the task as stopped when the turn was aborted', async () => {
    const log = recordingSink()
    const ctx = ctxWithSession()
    ctx.cancelSource.abort()
    runJsMock.mockRejectedValue(new Error('SuperEdit was interrupted.'))
    const input = { code: 'x' }
    await expect(
      SuperEditTool.call(input, ctx, canUseTool, parentWith('toolu_3', input)),
    ).rejects.toThrow(/interrupted/)
    expect(log.finished[0]).toMatchObject({ callId: 'toolu_3', status: 'stopped' })
  })
})

// ── overlay + commit pipeline (Branch B) ─────────────────────────────────────
//
// SuperEdit no longer mutates disk eagerly. A script RECORDS its writes into an
// OverlayFs (handleScriptFsOp) and reads through it; only after the script
// succeeds does commitOverlay gate the touched set, conflict-check against the
// first-touch baselines, and replay the recorded ops. These describes exercise
// the two phases directly; the end-to-end isError wiring is covered last.

function overlayCtx(
  mode = 'default',
  extra: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): ToolCallContext {
  const ctx = makeContext([], {
    readAppState: makeAppState(mode, extra),
    ...overrides,
  } as never)
  ;(ctx.options as unknown as { sessionId: string }).sessionId = 's1'
  return ctx
}

/** A fresh overlay over the mocked fs — the same disk adapter production builds
 *  from processFs(). commitOverlay reaches the same mocks for its
 *  conflict re-stat and execution. */
function newOverlay(): OverlayFs {
  return new OverlayFs({
    stat: (p: string) => statMock(p),
    readFileBytes: (p: string) => readFileBytesMock(p),
    readdir: (p: string) => readdirMock(p),
  })
}

/** Run the script phase for a sequence of ops, then commit. */
async function scriptThenCommit(
  ops: Array<[RunJsFsOp, Record<string, unknown>]>,
  ctx: ToolCallContext,
): Promise<CommitOutcome> {
  const overlay = newOverlay()
  for (const [op, payload] of ops) {
    await handleScriptFsOp(overlay, op, payload, ctx, invokingRow)
  }
  return commitOverlay(overlay, ctx, invokingRow)
}

const FILE_STAT = { isDirectory: () => false, size: 1, mtimeMs: 1 }
const DIR_STAT = { isDirectory: () => true, size: 0, mtimeMs: 1 }
// The real absent-path wire shape (anchored predicate: the old free-form
// 'FS_ERROR: not found' matches nothing any producer emits).
const NF = () => new Error('FS_ERROR: ENOENT: no such file or directory')

/** A slot whose `tool.check` hook answers `answer` for every check, and
 *  records the events it saw. */
function checkingMods(answer: Record<string, unknown>) {
  const seen: Array<Record<string, unknown>> = []
  return {
    seen,
    mods: {
      hasToolCheckHooks: () => true,
      toolCheck: async (e: Record<string, unknown>, core: () => Promise<unknown>) => {
        seen.push({ ...e, core: await core() })
        return { settled: true, result: answer }
      },
    },
  }
}

describe('a mod’s tool.check decides each path as a Read / Write of it', () => {
  it('a read is checked as Read, with core’s verdict; the hook’s deny refuses it with its reason', async () => {
    const ctx = overlayCtx()
    const { mods, seen } = checkingMods({ decision: 'deny', reason: 'NO_READ_SECRETS' })
    ;(ctx.options as unknown as { mods: unknown }).mods = mods
    statMock.mockResolvedValue(FILE_STAT)
    readFileBytesMock.mockResolvedValue(new Uint8Array([1]))
    await expect(
      handleScriptFsOp(newOverlay(), 'readFile', { path: 'a.txt' }, ctx, invokingRow),
    ).rejects.toMatchObject({ name: 'NotAllowedError', message: 'NO_READ_SECRETS' })
    expect(seen[0]).toMatchObject({ tool: 'Read', input: { file_path: '/proj/a.txt' }, core: { decision: 'allow' } })
  })

  it('stat, the internal existence probe, raises nothing', async () => {
    const ctx = overlayCtx()
    const { mods, seen } = checkingMods({ decision: 'deny', reason: 'NO' })
    ;(ctx.options as unknown as { mods: unknown }).mods = mods
    statMock.mockResolvedValue(FILE_STAT)
    await handleScriptFsOp(newOverlay(), 'stat', { path: 'a.txt' }, ctx, invokingRow)
    expect(seen).toEqual([])
  })

  it('a hook’s ask over core’s allow puts the path to the person, in the hook’s words', async () => {
    const confirm = vi.fn(async () => ({ behavior: 'deny' }) as unknown as ToolUseConfirmResolution)
    const ctx = overlayCtx('default', {}, { requestToolUseConfirm: confirm })
    const { mods } = checkingMods({ decision: 'ask', reason: 'Read the env file?' })
    ;(ctx.options as unknown as { mods: unknown }).mods = mods
    statMock.mockResolvedValue(FILE_STAT)
    await expect(
      handleScriptFsOp(newOverlay(), 'readFile', { path: '.env.local' }, ctx, invokingRow),
    ).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Read',
        permissionResult: expect.objectContaining({ message: 'Read the env file?' }),
      }),
      expect.objectContaining({ decided: expect.any(Promise) }),
    )
  })

  it('a write is checked as Write at commit: the hook’s deny is a denied commit, nothing written', async () => {
    const ctx = overlayCtx()
    const { mods, seen } = checkingMods({ decision: 'deny', reason: 'NO_WRITES_HERE' })
    ;(ctx.options as unknown as { mods: unknown }).mods = mods
    statMock.mockRejectedValue(NF())
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array(0) }]],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'denied', message: expect.stringContaining('NO_WRITES_HERE') })
    expect(seen.map(e => e.tool)).toEqual(['Write'])
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a hook’s allow cannot clear a path-safety ask', async () => {
    const confirm = vi.fn(async () => ({ behavior: 'deny' }) as unknown as ToolUseConfirmResolution)
    const ctx = overlayCtx('default', {}, { requestToolUseConfirm: confirm })
    const { mods } = checkingMods({ decision: 'allow' })
    ;(ctx.options as unknown as { mods: unknown }).mods = mods
    statMock.mockRejectedValue(NF())
    const outcome = await scriptThenCommit(
      [['writeFile', { path: '.git/config', bytes: new Uint8Array(0) }]],
      ctx,
    )
    expect(confirm).toHaveBeenCalled()
    expect(outcome.status).toBe('denied')
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

describe('handleScriptFsOp — script-phase reads', () => {
  it('serves stat/readFile from the overlay, permission-gated on the named path', async () => {
    const ctx = overlayCtx()
    statMock.mockResolvedValue(FILE_STAT)
    readFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const overlay = newOverlay()
    const st = await handleScriptFsOp(overlay, 'stat', { path: 'a.txt' }, ctx, invokingRow)
    expect(st).toMatchObject({ kind: 'file', size: 1 })
    const rd = await handleScriptFsOp(overlay, 'readFile', { path: 'a.txt' }, ctx, invokingRow)
    expect(rd).toMatchObject({ bytes: new Uint8Array([1, 2, 3]) })
  })

  it('a read served from a pending write reflects the script’s own change', async () => {
    const ctx = overlayCtx()
    statMock.mockRejectedValue(NF())
    const overlay = newOverlay()
    await handleScriptFsOp(overlay, 'writeFile', { path: 'a.txt', bytes: new Uint8Array([9]) }, ctx, invokingRow)
    const rd = await handleScriptFsOp(overlay, 'readFile', { path: 'a.txt' }, ctx, invokingRow)
    expect(rd).toMatchObject({ bytes: new Uint8Array([9]) })
  })

  it('a missing entry reads back as NotFoundError', async () => {
    const ctx = overlayCtx()
    statMock.mockRejectedValue(NF())
    await expect(
      handleScriptFsOp(newOverlay(), 'stat', { path: 'missing.txt' }, ctx, invokingRow),
    ).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('a path escaping the workspace is rejected before any disk read', async () => {
    const ctx = overlayCtx()
    await expect(
      handleScriptFsOp(newOverlay(), 'stat', { path: '../outside.txt' }, ctx, invokingRow),
    ).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(statMock).not.toHaveBeenCalled()
  })

  it('an anchored root (getDirectory) gates the ABSOLUTE path and contains against the root', async () => {
    const ctx = overlayCtx()
    statMock.mockResolvedValue(DIR_STAT)
    await handleScriptFsOp(newOverlay(), 'stat', { path: 'sub', root: '/other/place' }, ctx, invokingRow)
    expect(statMock).toHaveBeenCalledWith('/other/place/sub')
    statMock.mockClear()
    await expect(
      handleScriptFsOp(newOverlay(), 'stat', { path: '../escape', root: '/other/place' }, ctx, invokingRow),
    ).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(statMock).not.toHaveBeenCalled()
  })

  it('a readFile fires a Read PreToolUse hook; stat does NOT', async () => {
    const ctx = overlayCtx()
    statMock.mockResolvedValue(FILE_STAT)
    readFileBytesMock.mockResolvedValue(new Uint8Array([1]))
    await handleScriptFsOp(newOverlay(), 'readFile', { path: 'a.txt' }, ctx, invokingRow)
    expect((preHookMock.mock.calls[0] as unknown[])[0]).toBe('Read')
    preHookMock.mockClear()
    await handleScriptFsOp(newOverlay(), 'stat', { path: 'a.txt' }, ctx, invokingRow)
    expect(preHookMock).not.toHaveBeenCalled()
  })
})

describe('commitOverlay — writes gated at commit', () => {
  it('a write inside the cwd commits and hits the fs bridge with the resolved path', async () => {
    const ctx = overlayCtx()
    statMock.mockRejectedValue(NF())
    writeFileMock.mockResolvedValue(undefined)
    const bytes = new Uint8Array([104, 105])
    const outcome = await scriptThenCommit([['writeFile', { path: 'a.txt', bytes }]], ctx)
    expect(outcome.status).toBe('ok')
    expect(writeFileMock).toHaveBeenCalledWith('/proj/a.txt', bytes)
  })

  it('a Write deny rule turns into a denied commit, before the bridge is touched', async () => {
    const ctx = overlayCtx('default', { denyRuleBook: { session: ['Write'] } })
    statMock.mockRejectedValue(NF())
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array(0) }]],
      ctx,
    )
    expect(outcome.status).toBe('denied')
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a protected path asks; refusal → denied, approval → writes', async () => {
    statMock.mockRejectedValue(NF())
    const deny = vi.fn(async () => ({ behavior: 'deny' }) as unknown as ToolUseConfirmResolution)
    const denied = await scriptThenCommit(
      [['writeFile', { path: '.git/config', bytes: new Uint8Array(0) }]],
      overlayCtx('default', {}, { requestToolUseConfirm: deny }),
    )
    expect(denied.status).toBe('denied')
    expect(deny).toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()

    const allow = vi.fn(async () => ({ behavior: 'allow' }) as ToolUseConfirmResolution)
    writeFileMock.mockResolvedValue(undefined)
    const ok = await scriptThenCommit(
      [['writeFile', { path: '.git/config', bytes: new Uint8Array(0) }]],
      overlayCtx('default', {}, { requestToolUseConfirm: allow }),
    )
    expect(ok.status).toBe('ok')
    expect(allow).toHaveBeenCalled()
    expect(writeFileMock).toHaveBeenCalled()
  })

  it('a write outside the bound project forwards "outside-workspace" + the target directory', async () => {
    statMock.mockRejectedValue(NF())
    const confirm = vi.fn(async () => ({ behavior: 'allow' }) as ToolUseConfirmResolution)
    const ctx = overlayCtx('default', {}, { requestToolUseConfirm: confirm })
    ;(ctx.options as unknown as { projectRoot: string }).projectRoot = '/proj'
    writeFileMock.mockResolvedValue(undefined)
    await scriptThenCommit([['writeFile', { path: 'x.txt', root: '/outside', bytes: new Uint8Array(0) }]], ctx)
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionResult: expect.objectContaining({
          reason: 'outside-workspace',
          directory: '/outside',
        }),
      }),
      expect.objectContaining({ decided: expect.any(Promise) }),
    )
  })

  it('plan mode makes the workspace read-only (write denied at commit, reads still work)', async () => {
    const ctx = overlayCtx('plan')
    statMock.mockResolvedValue(FILE_STAT)
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array(0) }]],
      ctx,
    )
    expect(outcome).toMatchObject({
      status: 'denied',
      // The same model-facing rejection the top-level plan gate produces
      // (planModeRejectMessage) — pinned so the e2e REJECTION_MARKER assertion
      // keeps matching a SuperEdit-mediated block.
      message: expect.stringContaining('are allowed until you exit'),
    })
    expect(writeFileMock).not.toHaveBeenCalled()
    const stat = await handleScriptFsOp(newOverlay(), 'stat', { path: 'a.txt' }, ctx, invokingRow)
    expect(stat).toMatchObject({ kind: 'file', size: 1 })
  })

  // Plan-file carve-out: `code`-type sessions write their plan THROUGH SuperEdit.
  it('plan mode: a write to exactly the session plan file commits', async () => {
    const ctx = overlayCtx('plan')
    statMock.mockRejectedValue(NF())
    const planPath = getPlanFilePathForSession('/proj', 's1')
    const rel = planPath.slice('/proj/'.length)
    writeFileMock.mockResolvedValue(undefined)
    const bytes = new Uint8Array([35, 32])
    const outcome = await scriptThenCommit([['writeFile', { path: rel, bytes }]], ctx)
    expect(outcome.status).toBe('ok')
    expect(writeFileMock).toHaveBeenCalledWith(planPath, bytes)
  })

  it('plan mode: an EDIT-shaped plan update (read then write) commits', async () => {
    const ctx = overlayCtx('plan')
    const planPath = getPlanFilePathForSession('/proj', 's1')
    const rel = planPath.slice('/proj/'.length)
    readFileBytesMock.mockResolvedValue(new Uint8Array([35]))
    statMock.mockResolvedValue(FILE_STAT)
    writeFileMock.mockResolvedValue(undefined)
    const overlay = newOverlay()
    const read = await handleScriptFsOp(overlay, 'readFile', { path: rel }, ctx, invokingRow)
    expect(read).toMatchObject({ bytes: new Uint8Array([35]) })
    const bytes = new Uint8Array([35, 33])
    await handleScriptFsOp(overlay, 'writeFile', { path: rel, bytes }, ctx, invokingRow)
    const outcome = await commitOverlay(overlay, ctx, invokingRow)
    expect(outcome.status).toBe('ok')
    expect(writeFileMock).toHaveBeenCalledWith(planPath, bytes)
  })

  it('plan mode: mkdir of exactly the plan dir commits (write-helper retry)', async () => {
    const ctx = overlayCtx('plan')
    statMock.mockRejectedValue(NF())
    const planDir = dirnameRuntimePath(getPlanFilePathForSession('/proj', 's1'))
    mkdirMock.mockResolvedValue(undefined)
    const outcome = await scriptThenCommit(
      [['mkdir', { path: planDir.slice('/proj/'.length) }]],
      ctx,
    )
    expect(outcome.status).toBe('ok')
    expect(mkdirMock).toHaveBeenCalledWith(planDir)
  })

  it('plan mode: any OTHER mutation is denied at commit', async () => {
    const planPath = getPlanFilePathForSession('/proj', 's1')
    const planRelDir = dirnameRuntimePath(planPath).slice('/proj/'.length)
    statMock.mockResolvedValue(FILE_STAT) // so remove-of-plan-file records before commit denies

    // A sibling .md in the plan dir — strict equality, no prefix widening.
    const sibling = await scriptThenCommit(
      [['writeFile', { path: `${planRelDir}/other.md`, bytes: new Uint8Array(0) }]],
      overlayCtx('plan'),
    )
    expect(sibling).toMatchObject({ status: 'denied', message: expect.stringContaining('are allowed until you exit') })

    // Deleting the plan file is NOT part of the carve-out (write-only).
    const del = await scriptThenCommit(
      [['remove', { path: planPath.slice('/proj/'.length) }]],
      overlayCtx('plan'),
    )
    expect(del.status).toBe('denied')

    // mkdir anywhere but the plan dir stays blocked too.
    statMock.mockRejectedValue(NF())
    const mk = await scriptThenCommit([['mkdir', { path: 'src/newdir' }]], overlayCtx('plan'))
    expect(mk.status).toBe('denied')

    expect(writeFileMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
    expect(unlinkMock).not.toHaveBeenCalled()
    expect(mkdirMock).not.toHaveBeenCalled()
  })

  it('remove dispatches unlink for files and recursive rm for directories', async () => {
    statMock.mockResolvedValue(FILE_STAT)
    unlinkMock.mockResolvedValue(undefined)
    const f = await scriptThenCommit([['remove', { path: 'a.txt' }]], overlayCtx())
    expect(f.status).toBe('ok')
    expect(unlinkMock).toHaveBeenCalledWith('/proj/a.txt')

    statMock.mockResolvedValue(DIR_STAT)
    rmMock.mockResolvedValue(undefined)
    const d = await scriptThenCommit([['remove', { path: 'dir' }]], overlayCtx())
    expect(d.status).toBe('ok')
    expect(rmMock).toHaveBeenCalledWith('/proj/dir', { recursive: true })
  })

  it('a workspace write fires a Write PreToolUse hook; a block denies the commit', async () => {
    statMock.mockRejectedValue(NF())
    preHookMock.mockResolvedValue({ blocked: true, message: 'no writes' })
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array(0) }]],
      overlayCtx(),
    )
    expect(outcome.status).toBe('denied')
    expect((preHookMock.mock.calls[0] as unknown[])[0]).toBe('Write')
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a protected-path ask auto-denies in a headless context', async () => {
    statMock.mockRejectedValue(NF())
    const confirm = vi.fn()
    const ctx = overlayCtx('default', { suppressAsks: true }, { requestToolUseConfirm: confirm })
    const outcome = await scriptThenCommit(
      [['writeFile', { path: '.git/config', bytes: new Uint8Array(0) }]],
      ctx,
    )
    expect(outcome.status).toBe('denied')
    expect(headlessMock).toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

describe('commitOverlay — native move (fs.rename)', () => {
  it('commits ONE fs.rename with both paths resolved absolute', async () => {
    statMock.mockResolvedValue(FILE_STAT)
    renameMock.mockResolvedValue(undefined)
    const outcome = await scriptThenCommit(
      [['move', { path: 'a.txt', newPath: 'sub/b.txt' }]],
      overlayCtx(),
    )
    expect(outcome.status).toBe('ok')
    expect(renameMock).toHaveBeenCalledWith('/proj/a.txt', '/proj/sub/b.txt')
  })

  it('resolves newRoot for an anchored destination (getDirectory trees)', async () => {
    statMock.mockResolvedValue(FILE_STAT)
    renameMock.mockResolvedValue(undefined)
    const confirm = vi.fn(async () => ({ behavior: 'allow' }) as ToolUseConfirmResolution)
    const outcome = await scriptThenCommit(
      [['move', { path: 'a.txt', newPath: 'b.txt', newRoot: '/elsewhere' }]],
      overlayCtx('default', {}, { requestToolUseConfirm: confirm }),
    )
    expect(outcome.status).toBe('ok')
    expect(renameMock).toHaveBeenCalledWith('/proj/a.txt', '/elsewhere/b.txt')
  })

  it('write-gates BOTH ends: a Write deny denies the commit before fs.rename', async () => {
    statMock.mockResolvedValue(FILE_STAT)
    const outcome = await scriptThenCommit(
      [['move', { path: 'a.txt', newPath: 'b.txt' }]],
      overlayCtx('default', { denyRuleBook: { session: ['Write'] } }),
    )
    expect(outcome.status).toBe('denied')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('fires a Write PreToolUse hook once per path', async () => {
    statMock.mockResolvedValue(FILE_STAT)
    renameMock.mockResolvedValue(undefined)
    await scriptThenCommit([['move', { path: 'a.txt', newPath: 'b.txt' }]], overlayCtx())
    const hookPaths = preHookMock.mock.calls.map(
      c => ((c as unknown[])[1] as { file_path: string }).file_path,
    )
    expect((preHookMock.mock.calls[0] as unknown[])[0]).toBe('Write')
    expect(hookPaths).toEqual(['/proj/a.txt', '/proj/b.txt'])
  })

  it('a hook block on the DESTINATION denies the move', async () => {
    statMock.mockResolvedValue(FILE_STAT)
    preHookMock.mockImplementation(async (...args: unknown[]) => {
      const target = (args[1] as { file_path: string }).file_path
      return target === '/proj/b.txt'
        ? { blocked: true, message: 'not there' }
        : { blocked: false, message: '' }
    })
    const outcome = await scriptThenCommit(
      [['move', { path: 'a.txt', newPath: 'b.txt' }]],
      overlayCtx(),
    )
    expect(outcome.status).toBe('denied')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('refuses a destination inside the source on the ABSOLUTE forms (script phase)', async () => {
    statMock.mockResolvedValue(DIR_STAT)
    await expect(
      handleScriptFsOp(newOverlay(), 'move', { path: 'dir', newPath: 'dir/sub' }, overlayCtx(), invokingRow),
    ).rejects.toMatchObject({ name: 'InvalidModificationError' })
    // Mixed spelling of the same containment — decided on the absolute forms.
    await expect(
      handleScriptFsOp(newOverlay(), 'move', { path: 'dir', newPath: 'sub', newRoot: '/proj/dir' }, overlayCtx(), invokingRow),
    ).rejects.toMatchObject({ name: 'InvalidModificationError' })
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('plan mode denies a move like any other mutation', async () => {
    statMock.mockResolvedValue(FILE_STAT)
    const outcome = await scriptThenCommit(
      [['move', { path: 'a.txt', newPath: 'b.txt' }]],
      overlayCtx('plan'),
    )
    expect(outcome).toMatchObject({
      status: 'denied',
      message: expect.stringContaining('are allowed until you exit'),
    })
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('a host without fs.rename surfaces NotSupportedError during the script (the fallback signal)', async () => {
    renameGate.enabled = false
    statMock.mockResolvedValue(FILE_STAT)
    await expect(
      handleScriptFsOp(newOverlay(), 'move', { path: 'a.txt', newPath: 'b.txt' }, overlayCtx(), invokingRow),
    ).rejects.toMatchObject({ name: 'NotSupportedError' })
  })

  it('surfaces the fs layer’s AlreadyExistsError as a partial commit', async () => {
    statMock.mockResolvedValue(FILE_STAT)
    const occupied = new Error('FS_ERROR: Destination already exists')
    occupied.name = 'AlreadyExistsError'
    renameMock.mockRejectedValue(occupied)
    const outcome = await scriptThenCommit(
      [['move', { path: 'a.txt', newPath: 'b.txt' }]],
      overlayCtx(),
    )
    expect(outcome).toMatchObject({
      status: 'partial',
      message: expect.stringContaining('Destination already exists'),
    })
  })
})

describe('commitOverlay — file-snapshot capture (fileSnapshots templates)', () => {
  type RecorderCalls = {
    tracked: Array<{ path: string; seq: number }>
    dirs: Array<{ path: string; seq: number }>
  }

  function fakeRecorder(opts?: { fail?: boolean }): {
    recorder: {
      trackBeforeMutation: (p: string, t: { seq: number }) => Promise<void>
      trackBeforeDirectoryRemoval: (p: string, t: { seq: number }) => Promise<void>
    }
    calls: RecorderCalls
  } {
    const calls: RecorderCalls = { tracked: [], dirs: [] }
    return {
      calls,
      recorder: {
        async trackBeforeMutation(path, turn) {
          if (opts?.fail) throw new Error('File snapshot capture failed for ' + path)
          calls.tracked.push({ path, seq: turn.seq })
        },
        async trackBeforeDirectoryRemoval(path, turn) {
          calls.dirs.push({ path, seq: turn.seq })
        },
      },
    }
  }

  function snapContext(recorder: unknown): ToolCallContext {
    const ctx = makeContext([], {
      readAppState: makeAppState('default'),
      messages: [
        { type: 'user', uuid: 'u1', message: { content: 'first' } },
        { type: 'assistant', message: { content: [] } },
        { type: 'user', uuid: 'u2', message: { content: 'second turn prompt' } },
      ],
    } as never)
    ;(ctx.options as unknown as Record<string, unknown>).sessionId = 's1'
    ;(ctx.options as unknown as Record<string, unknown>).fileSnapshotRecorder = recorder
    return ctx
  }

  it('captures the before-image BEFORE the write executes, attributed to the current turn', async () => {
    const { recorder, calls } = fakeRecorder()
    statMock.mockRejectedValue(NF())
    const order: string[] = []
    writeFileMock.mockImplementation(async () => {
      order.push('write')
    })
    const wrapped = {
      ...recorder,
      trackBeforeMutation: async (p: string, t: { seq: number }) => {
        order.push('capture')
        return recorder.trackBeforeMutation(p, t)
      },
    }
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      snapContext(wrapped),
    )
    expect(outcome.status).toBe('ok')
    expect(order).toEqual(['capture', 'write'])
    expect(calls.tracked).toEqual([{ path: '/proj/a.txt', seq: 2 }])
  })

  it('a forked run’s write lands on the spawning session’s turn, not on its own message count', async () => {
    const { recorder, calls } = fakeRecorder()
    statMock.mockRejectedValue(NF())
    writeFileMock.mockResolvedValue(undefined)
    const child = deriveChildToolContext(snapContext(recorder), {
      messages: [
        { type: 'user', uuid: 'c1', message: { content: 'child task' } },
      ] as unknown as Message[],
    })
    // The child loop replaces its messages each step; the inherited turn stays.
    const stepped = { ...child, messages: [...child.messages] }
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      stepped,
    )
    expect(outcome.status).toBe('ok')
    expect(calls.tracked).toEqual([{ path: '/proj/a.txt', seq: 2 }])
  })

  it('routes a file remove to trackBeforeMutation and a directory remove to the walk', async () => {
    const { recorder, calls } = fakeRecorder()
    statMock.mockResolvedValue(FILE_STAT)
    unlinkMock.mockResolvedValue(undefined)
    await scriptThenCommit([['remove', { path: 'file.txt' }]], snapContext(recorder))
    expect(calls.tracked).toEqual([{ path: '/proj/file.txt', seq: 2 }])

    statMock.mockResolvedValue(DIR_STAT)
    rmMock.mockResolvedValue(undefined)
    await scriptThenCommit([['remove', { path: 'dir' }]], snapContext(recorder))
    expect(calls.dirs).toEqual([{ path: '/proj/dir', seq: 2 }])
  })

  it('a move captures BOTH ends: file source + destination before-image', async () => {
    const { recorder, calls } = fakeRecorder()
    statMock.mockResolvedValue(FILE_STAT)
    renameMock.mockResolvedValue(undefined)
    await scriptThenCommit([['move', { path: 'a.txt', newPath: 'b.txt' }]], snapContext(recorder))
    expect(calls.tracked).toEqual([
      { path: '/proj/a.txt', seq: 2 },
      { path: '/proj/b.txt', seq: 2 },
    ])
    expect(renameMock).toHaveBeenCalled()
  })

  it('a DIRECTORY move routes the source through the tree walk', async () => {
    const { recorder, calls } = fakeRecorder()
    statMock.mockResolvedValue(DIR_STAT)
    readdirMock.mockResolvedValue([])
    renameMock.mockResolvedValue(undefined)
    await scriptThenCommit([['move', { path: 'olddir', newPath: 'newdir' }]], snapContext(recorder))
    expect(calls.dirs).toEqual([{ path: '/proj/olddir', seq: 2 }])
    expect(calls.tracked).toEqual([{ path: '/proj/newdir', seq: 2 }])
  })

  it('captures nothing for reads and mkdir', async () => {
    const { recorder, calls } = fakeRecorder()
    statMock.mockRejectedValue(NF())
    readFileBytesMock.mockResolvedValue(new Uint8Array([1]))
    mkdirMock.mockResolvedValue(undefined)
    // readFile served from a pending write so no disk read is needed.
    const overlay = newOverlay()
    const ctx = snapContext(recorder)
    await handleScriptFsOp(overlay, 'writeFile', { path: 'seed.txt', bytes: new Uint8Array([1]) }, ctx, invokingRow)
    await handleScriptFsOp(overlay, 'readFile', { path: 'seed.txt' }, ctx, invokingRow)
    await handleScriptFsOp(overlay, 'mkdir', { path: 'newdir' }, ctx, invokingRow)
    writeFileMock.mockResolvedValue(undefined)
    await commitOverlay(overlay, ctx, invokingRow)
    // Only the write's before-image is captured; the mkdir and read record nothing.
    expect(calls.tracked).toEqual([{ path: '/proj/seed.txt', seq: 2 }])
    expect(calls.dirs).toEqual([])
  })

  it('a capture failure fails that op as a partial commit (mutated-but-unsnapshotted is refused)', async () => {
    const { recorder } = fakeRecorder({ fail: true })
    statMock.mockRejectedValue(NF())
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array(0) }]],
      snapContext(recorder),
    )
    expect(outcome).toMatchObject({
      status: 'partial',
      message: expect.stringContaining('snapshot capture failed'),
    })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('without a recorder (non-snapshot sessions) writes commit exactly as before', async () => {
    statMock.mockRejectedValue(NF())
    writeFileMock.mockResolvedValue(undefined)
    const ctx = makeContext([], { readAppState: makeAppState('default') } as never)
    ;(ctx.options as unknown as Record<string, unknown>).sessionId = 's1'
    const outcome = await scriptThenCommit([['writeFile', { path: 'a.txt', bytes: new Uint8Array(0) }]], ctx)
    expect(outcome.status).toBe('ok')
    expect(writeFileMock).toHaveBeenCalled()
  })
})

describe('commitOverlay — conflict detection (transactional guard)', () => {
  it('aborts the WHOLE save when a mutated file changed on disk during the run', async () => {
    const ctx = overlayCtx()
    // Baseline at first touch, then a different mtime at the commit re-stat.
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 100 })
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 200 })
    writeFileMock.mockResolvedValue(undefined)
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'conflict', paths: ['/proj/a.txt'] })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('commits when the baseline is unchanged', async () => {
    const ctx = overlayCtx()
    statMock.mockResolvedValue({ isDirectory: () => false, size: 4, mtimeMs: 100 })
    writeFileMock.mockResolvedValue(undefined)
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome.status).toBe('ok')
    expect(writeFileMock).toHaveBeenCalled()
  })

  it('a new file (absent then still absent) is not a conflict', async () => {
    const ctx = overlayCtx()
    statMock.mockRejectedValue(NF())
    writeFileMock.mockResolvedValue(undefined)
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'new.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome.status).toBe('ok')
  })

  it('a file deleted out from under the run is a conflict', async () => {
    const ctx = overlayCtx()
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 100 }) // baseline
      .mockRejectedValueOnce(NF()) // vanished at commit
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome.status).toBe('conflict')
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

describe('SuperEditTool.call — isError on failure paths', () => {
  it('flags a thrown script as an error and rolls back (no disk write)', async () => {
    runJsMock.mockImplementation(async (opts: { onFsCall: (op: RunJsFsOp, p: Record<string, unknown>) => Promise<unknown> }) => {
      statMock.mockRejectedValue(NF())
      await opts.onFsCall('writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) })
      throw new Error('boom')
    })
    const res = await SuperEditTool.call({ code: 'x' }, overlayCtx(), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/SuperEdit error: boom/)
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('flags a commit CONFLICT as an error and names the changed file', async () => {
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 1 })
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 2 })
    runJsMock.mockImplementation(async (opts: { onFsCall: (op: RunJsFsOp, p: Record<string, unknown>) => Promise<unknown> }) => {
      await opts.onFsCall('writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) })
      return { result: 'done', logs: [] }
    })
    const res = await SuperEditTool.call({ code: 'x' }, overlayCtx(), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/changed on disk/)
    expect(res.data).toContain('/proj/a.txt')
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('flags a permission DENIAL (plan mode) as an error', async () => {
    statMock.mockRejectedValue(NF())
    runJsMock.mockImplementation(async (opts: { onFsCall: (op: RunJsFsOp, p: Record<string, unknown>) => Promise<unknown> }) => {
      await opts.onFsCall('writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) })
      return { result: 'done', logs: [] }
    })
    const res = await SuperEditTool.call({ code: 'x' }, overlayCtx('plan'), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/are allowed until you exit/)
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a clean run is NOT flagged as an error', async () => {
    statMock.mockRejectedValue(NF())
    writeFileMock.mockResolvedValue(undefined)
    runJsMock.mockImplementation(async (opts: { onFsCall: (op: RunJsFsOp, p: Record<string, unknown>) => Promise<unknown> }) => {
      await opts.onFsCall('writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) })
      return { result: 'done', logs: [] }
    })
    const res = await SuperEditTool.call({ code: 'x' }, overlayCtx(), canUseTool, invokingRow)
    expect(res.isError).toBeFalsy()
    expect(res.data).toContain('done')
    expect(writeFileMock).toHaveBeenCalledWith('/proj/a.txt', new Uint8Array([1]))
  })
})

describe('commitOverlay — commit failures', () => {
  // An abort during the commit phase must propagate as an
  // interrupt, not be recorded as a completed error tool result.
  it('rethrows as an interrupt when the turn is aborted during commit', async () => {
    const ctx = overlayCtx()
    statMock.mockRejectedValue(NF())
    runJsMock.mockImplementation(
      async (opts: { onFsCall: (op: RunJsFsOp, p: Record<string, unknown>) => Promise<unknown> }) => {
        await opts.onFsCall('writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) })
        // Stop pressed after the script recorded, before/while committing.
        ctx.cancelSource.abort()
        return { result: 'done', logs: [] }
      },
    )
    await expect(
      SuperEditTool.call({ code: 'x' }, ctx, canUseTool, invokingRow),
    ).rejects.toThrow(/interrupted/)
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  // When a committed write fails and the parent-creation retry ALSO
  // fails, the ORIGINAL write error is surfaced, not the misleading mkdir one.
  it('surfaces the original write error when the parent-creation retry fails', async () => {
    const ctx = overlayCtx()
    statMock.mockRejectedValue(NF())
    writeFileMock.mockRejectedValue(new Error('EACCES original write failure'))
    mkdirMock.mockRejectedValue(new Error('mkdir parent-is-a-file failure'))
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome).toMatchObject({
      status: 'partial',
      message: expect.stringContaining('original write failure'),
    })
    expect(outcome).not.toMatchObject({ message: expect.stringContaining('mkdir') })
  })

  // A file the script only READ that changed on disk mid-run
  // aborts the whole save, even though it was never written.
  it('conflicts on a read-only input file that changed under the run', async () => {
    const ctx = overlayCtx()
    let inputStats = 0
    statMock.mockImplementation(async (p: string) => {
      if (p === '/proj/input.txt') {
        inputStats++
        // mtime shifts between the script's read (baseline) and the commit re-stat.
        return { isDirectory: () => false, size: 5, mtimeMs: inputStats === 1 ? 100 : 200 }
      }
      throw NF() // out.txt is a new file
    })
    readFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
    writeFileMock.mockResolvedValue(undefined)

    const overlay = newOverlay()
    // Read the input (seeds its baseline), then write a DIFFERENT file.
    await handleScriptFsOp(overlay, 'readFile', { path: 'input.txt' }, ctx, invokingRow)
    await handleScriptFsOp(overlay, 'writeFile', { path: 'out.txt', bytes: new Uint8Array([9]) }, ctx, invokingRow)
    const outcome = await commitOverlay(overlay, ctx, invokingRow)

    expect(outcome).toMatchObject({ status: 'conflict', paths: ['/proj/input.txt'] })
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

// ── scope-disposed hardening ─────────────────────────────────────────────────
// SuperEdit resolves fs from `context.options.fsOperations`, not the realm-shared `installProcessFs` slot, and a
// transport-dead failure reports `unavailable`, never a conflict.

/** The rejection a disposed AgentWorkerBridgeTransport produces. */
const disposedErr = (): Error => {
  const e = new Error('Runtime scope was disposed.')
  e.name = 'AbortError'
  return e
}

describe('commitOverlay — a dead fs transport is not a disk conflict', () => {
  it('reports `unavailable` (not conflict) when the commit re-stat rejects AbortError', async () => {
    const ctx = overlayCtx()
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 100 }) // baseline
      .mockRejectedValueOnce(disposedErr()) // transport died before commit
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'unavailable', path: '/proj/a.txt' })
    expect(outcome).not.toMatchObject({ status: 'conflict' })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a generic stat failure still reads as "file vanished" → conflict (unchanged)', async () => {
    const ctx = overlayCtx()
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 100 })
      .mockRejectedValueOnce(NF())
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome.status).toBe('conflict')
  })

  it('reports `unavailable` when the FIRST write rejects at the transport layer', async () => {
    const ctx = overlayCtx()
    statMock.mockRejectedValue(NF()) // new file: absent at baseline and commit
    writeFileMock.mockRejectedValue(disposedErr())
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'unavailable', path: '/proj/a.txt' })
  })

  it('stays `partial` (with the committed list) when the transport dies after an op landed', async () => {
    const ctx = overlayCtx()
    statMock.mockRejectedValue(NF())
    // a.txt lands; b.txt hits the dead pipe. Persistent per-path rejection —
    // executeOpOnDisk's missing-parent retry (mkdir + rewrite) must ALSO fail,
    // or a single mockRejectedValueOnce is silently recovered by the retry.
    writeFileMock.mockImplementation((p: string) =>
      p === '/proj/b.txt' ? Promise.reject(disposedErr()) : Promise.resolve(undefined),
    )
    mkdirMock.mockRejectedValue(disposedErr())
    const outcome = await scriptThenCommit(
      [
        ['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }],
        ['writeFile', { path: 'b.txt', bytes: new Uint8Array([2]) }],
      ],
      ctx,
    )
    expect(outcome).toMatchObject({
      status: 'partial',
      committed: ['writeFile /proj/a.txt'],
      failedPath: '/proj/b.txt',
    })
  })

  it('the call-level headline says "bridge unavailable — retry", never "changed on disk"', async () => {
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 100 })
      .mockRejectedValueOnce(disposedErr())
    runJsMock.mockImplementation(async (opts: { onFsCall: (op: RunJsFsOp, p: Record<string, unknown>) => Promise<unknown> }) => {
      await opts.onFsCall('writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) })
      return { result: 'done', logs: [] }
    })
    const res = await SuperEditTool.call({ code: 'x' }, overlayCtx(), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/filesystem bridge is\s+unavailable/)
    expect(res.data).toMatch(/Retry the same SuperEdit call/)
    expect(res.data).not.toMatch(/changed on disk while the script was running/)
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

describe('SuperEditTool — fs resolved from the owning context, not the shared slot', () => {
  /** A context-published fs whose calls are tracked separately from the
   *  module-slot mocks; the module slot stays POISONED (rejects AbortError)
   *  so any accidental fallback fails the assertions loudly. */
  function contextFsCtx() {
    const ctxStat = vi.fn()
    const ctxWrite = vi.fn()
    const ctxReadFile = vi.fn()
    const ctx = overlayCtx()
    ;(ctx.options as unknown as Record<string, unknown>).fsOperations = {
      readFile: ctxReadFile,
      stat: ctxStat,
      readdir: vi.fn(),
      readFileBytes: vi.fn(),
      writeFile: ctxWrite,
      mkdir: vi.fn(),
      unlink: vi.fn(),
      rm: vi.fn(),
    }
    for (const m of [statMock, writeFileMock, readFileMock]) {
      m.mockRejectedValue(disposedErr())
    }
    return { ctx, ctxStat, ctxWrite, ctxReadFile }
  }

  it('a write commits through context.options.fsOperations while the module slot is dead', async () => {
    const { ctx, ctxStat, ctxWrite } = contextFsCtx()
    ctxStat.mockRejectedValue(NF()) // new file
    ctxWrite.mockResolvedValue(undefined)
    runJsMock.mockImplementation(async (opts: { onFsCall: (op: RunJsFsOp, p: Record<string, unknown>) => Promise<unknown> }) => {
      await opts.onFsCall('writeFile', { path: 'a.txt', bytes: new Uint8Array([7]) })
      return { result: 'done', logs: [] }
    })
    const res = await SuperEditTool.call({ code: 'x' }, ctx, canUseTool, invokingRow)
    expect(res.isError).toBeFalsy()
    expect(ctxWrite).toHaveBeenCalledWith('/proj/a.txt', new Uint8Array([7]))
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a `path` script read goes through the context fs too', async () => {
    const { ctx, ctxReadFile } = contextFsCtx()
    ctxReadFile.mockResolvedValue('return 1')
    runJsMock.mockResolvedValue({ result: '1', logs: [] })
    const res = await SuperEditTool.call({ path: 'scripts/x.js' }, ctx, canUseTool, invokingRow)
    expect(res.isError).toBeFalsy()
    expect(ctxReadFile).toHaveBeenCalledWith('/proj/scripts/x.js', { encoding: 'utf-8' })
    expect(readFileMock).not.toHaveBeenCalled()
  })
})

// ── `inputs` — code/data separation at the tool boundary ─────────────────────
//
// The worker-side value semantics (verbatim hostile strings, {} default) are
// pinned in run-js-worker-core.test.ts; here we pin the tool contract: the
// object is validated as a plain map and forwarded to the broker UNTOUCHED —
// never serialized into the code string.

describe('SuperEditTool — `inputs` data channel', () => {
  it('forwards `inputs` to the broker verbatim, outside the code string', async () => {
    runJsMock.mockResolvedValue({ result: 'ok', logs: [] })
    const hostile = { content: 'a `b` ${c} "d" \\e\nf' }
    await SuperEditTool.call(
      { code: 'await writeTextFile("x.md", inputs.content)', inputs: hostile },
      makeContext([]),
      canUseTool,
      invokingRow,
    )
    const opts = runJsMock.mock.calls.at(-1)![0] as { code: string; inputs?: unknown }
    expect(opts.inputs).toEqual(hostile)
    // The data value must not have been interpolated into the parsed source.
    expect(opts.code).not.toContain(hostile.content)
  })

  it('omitted `inputs` is normalized to {} at the tool boundary', async () => {
    // The documented contract is "`inputs` is {} when omitted" — guaranteed
    // HERE, not left to the worker-side defensive default.
    runJsMock.mockResolvedValue({ result: 'ok', logs: [] })
    await SuperEditTool.call({ code: 'return 1' }, makeContext([]), canUseTool, invokingRow)
    const opts = runJsMock.mock.calls.at(-1)![0] as { inputs?: unknown }
    expect(opts.inputs).toEqual({})
  })

  it('emitStart carries `inputs` so the drawer detail can render the payload', async () => {
    const log = { started: [] as Array<{ inputs?: Record<string, unknown> }> }
    setSideTaskSink({
      forkStarted: () => {},
      forkProgress: () => {},
      forkFinished: () => {},
      fastCallStarted: () => {},
      fastCallFinished: () => {},
      runJsStarted: s => log.started.push(s),
      runJsFinished: () => {},
    })
    try {
      runJsMock.mockResolvedValue({ result: 'ok', logs: [] })
      const input = {
        code: 'await writeTextFile(inputs.path, inputs.content)',
        inputs: { path: 'a.md', content: 'BODY' },
      }
      const ctx = makeContext([])
      ;(ctx.options as unknown as { sessionId: string }).sessionId = 's1'
      await SuperEditTool.call(
        input,
        ctx,
        canUseTool,
        { message: { content: [{ type: 'tool_use', id: 'toolu_in', name: 'SuperEdit', input }] } } as unknown as Message,
      )
      expect(log.started).toHaveLength(1)
      expect(log.started[0]!.inputs).toEqual({ path: 'a.md', content: 'BODY' })
    } finally {
      setSideTaskSink(null)
    }
  })

  it('two same-code calls in one message resolve to their OWN ids via `inputs`', async () => {
    // The code/data split makes identical generic code the expected shape —
    // without `inputs` in the match, both calls would last-wins collapse onto
    // one drawer task.
    const log = { started: [] as Array<{ callId: string }> }
    setSideTaskSink({
      forkStarted: () => {},
      forkProgress: () => {},
      forkFinished: () => {},
      fastCallStarted: () => {},
      fastCallFinished: () => {},
      runJsStarted: s => log.started.push(s),
      runJsFinished: () => {},
    })
    try {
      runJsMock.mockResolvedValue({ result: 'ok', logs: [] })
      const code = 'await replaceTextFile(inputs.path, inputs.find, inputs.replace)'
      const inputsA = { path: 'a.ts', find: 'x', replace: 'y' }
      const inputsB = { path: 'b.ts', find: 'p', replace: 'q' }
      const parent = {
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_A', name: 'SuperEdit', input: { code, inputs: inputsA } },
            { type: 'tool_use', id: 'toolu_B', name: 'SuperEdit', input: { code, inputs: inputsB } },
          ],
        },
      } as unknown as Message
      const ctx = makeContext([])
      ;(ctx.options as unknown as { sessionId: string }).sessionId = 's1'
      await SuperEditTool.call({ code, inputs: inputsA }, ctx, canUseTool, parent)
      await SuperEditTool.call({ code, inputs: inputsB }, ctx, canUseTool, parent)
      expect(log.started.map(s => s.callId)).toEqual(['toolu_A', 'toolu_B'])
    } finally {
      setSideTaskSink(null)
    }
  })

  it('matches same-message calls with raw null fields to distinct task ids', async () => {
    const log = { started: [] as Array<{ callId: string }> }
    setSideTaskSink({
      forkStarted: () => {}, forkProgress: () => {}, forkFinished: () => {},
      fastCallStarted: () => {}, fastCallFinished: () => {},
      runJsStarted: s => log.started.push(s), runJsFinished: () => {},
    })
    try {
      runJsMock.mockResolvedValue({ result: 'ok', logs: [] })
      const code = 'return inputs.value'
      const inputA = { code, path: null, inputs: { value: 'a' }, description: null, timeoutSec: null }
      const inputB = { code, path: null, inputs: { value: 'b' }, description: null, timeoutSec: null }
      const parent = { message: { content: [
        { type: 'tool_use', id: 'toolu_A', name: 'SuperEdit', input: inputA },
        { type: 'tool_use', id: 'toolu_B', name: 'SuperEdit', input: inputB },
      ] } } as unknown as Message
      const ctx = makeContext([])
      ;(ctx.options as unknown as { sessionId: string }).sessionId = 's1'
      await SuperEditTool.call(inputA as never, ctx, canUseTool, parent)
      await SuperEditTool.call(inputB as never, ctx, canUseTool, parent)
      expect(log.started.map(s => s.callId)).toEqual(['toolu_A', 'toolu_B'])
    } finally {
      setSideTaskSink(null)
    }
  })

  it('validateInput rejects a non-object `inputs` (array, string)', async () => {
    const ctx = makeContext([])
    for (const bad of [['a'], 'str'] as unknown[]) {
      const r = await SuperEditTool.checkInput!(
        { code: 'x', inputs: bad as never },
        ctx,
      )
      expect(r.result).toBe(false)
      expect((r as { message?: string }).message).toMatch(
        /`inputs` must be a plain object/,
      )
    }
    expect(
      (await SuperEditTool.checkInput!({ code: 'x', inputs: { a: 1 } }, ctx)).result,
    ).toBe(true)
  })

  it('validateInput treats explicit null optional values as omitted', async () => {
    // The tool boundary accepts explicitly-null optional values the same way it
    // accepts omitted ones, before the rest of the implementation uses them.
    const ctx = makeContext([])
    const r = await SuperEditTool.checkInput!(
      {
        code: 'x',
        path: null as unknown as string,
        inputs: null as unknown as Record<string, unknown>,
        description: null as unknown as string,
        timeoutSec: null as unknown as number,
      },
      ctx,
    )
    expect(r.result).toBe(true)
  })

  it('does not opt into strict schemas because `inputs` is an arbitrary map', () => {
    // OpenAI strict schemas require every object node to have a closed
    // `properties` shape. SuperEdit's inputs intentionally accepts arbitrary
    // caller-defined keys, so it cannot be represented without changing the API.
    expect(SuperEditTool.inputJSONSchemaStrict).toBeUndefined()
  })

  it('makes `inputs` the ONE required field', () => {
    // Not because a script must carry data — `{}` is valid and is what an
    // omitted one already normalized to — but because an optional field is one
    // a model can decline to think about. `required` is read where the JSON is
    // GENERATED; the tool description is only read.
    const schema = SuperEditTool.argsSchema as {
      required?: string[]
      properties: Record<string, unknown>
    }
    expect(schema.required).toEqual(['inputs'])
    // `code`/`path` stay out on purpose: their either-or rule is not
    // expressible here, and requiring both would make every legal call invalid.
    expect(schema.required).not.toContain('code')
    expect(schema.required).not.toContain('path')
    expect(Object.keys(schema.properties)).toContain('inputs')
  })

  it('still accepts an empty `inputs` — required does not mean non-empty', async () => {
    // The whole normalization contract survives the schema change: `{}`, an
    // explicit null, and omission are all valid and all reach the broker as {}.
    const ctx = makeContext([])
    expect((await SuperEditTool.checkInput!({ code: 'x', inputs: {} }, ctx)).result).toBe(true)
    runJsMock.mockResolvedValue({ result: 'ok', logs: [] })
    await SuperEditTool.call({ code: 'return 1', inputs: {} }, ctx, canUseTool, invokingRow)
    expect((runJsMock.mock.calls.at(-1)![0] as { inputs?: unknown }).inputs).toEqual({})
  })

  it('names `inputs` when the script did not PARSE and the call sent none', async () => {
    // The one failure the split exists to prevent. V8 says "Invalid or
    // unexpected token" — a token, never the fix — so the tool supplies the
    // fix at the moment the model is about to rewrite the script.
    runJsMock.mockRejectedValue(
      new RunJsFailure(
        'Invalid or unexpected token',
        [],
        undefined,
        undefined,
        'SyntaxError',
        true,
      ),
    )
    const res = await SuperEditTool.call(
      { code: 'await writeTextFile("a.md", "unterminated)' },
      makeContext([]),
      canUseTool,
      invokingRow,
    )
    expect(res.isError).toBe(true)
    expect(res.data).toContain('SuperEdit error: Invalid or unexpected token')
    expect(res.data).toContain('this call sent no `inputs`')
    expect(res.data).toContain('read it back as `inputs.<name>`')
    // The concrete call shape is what makes this actionable rather than a scolding.
    expect(res.data).toContain('"code": "await writeTextFile(path, inputs.body)"')
    // And it does not insist — an ordinary typo throws SyntaxError too.
    expect(res.data).toContain('ordinary syntax error')
  })

  it('shortens the parse guidance when the call already used `inputs`', async () => {
    // A model that already split its data needs to hear that the REMAINING
    // literal is the suspect, not the whole lesson: the example is dropped.
    runJsMock.mockRejectedValue(
      new RunJsFailure('Unexpected identifier', [], undefined, undefined, 'SyntaxError', true),
    )
    const res = await SuperEditTool.call(
      { code: 'await writeTextFile(inputs.path, "unterminated)', inputs: { path: 'a.md' } },
      makeContext([]),
      canUseTool,
      invokingRow,
    )
    expect(res.data).toContain('Any text still embedded in the script')
    expect(res.data).not.toContain('this call sent no `inputs`')
    expect(res.data).not.toContain('"code": "await writeTextFile(path, inputs.body)"')
    expect(res.data).toContain('ordinary syntax error')
  })

  it('adds NO parse guidance to a SyntaxError thrown while the script RAN', async () => {
    // `JSON.parse` on malformed data / `new RegExp` with an unbalanced group
    // throw SyntaxError at runtime; the script parsed fine, so the fix is the
    // data or the regex, not moving text into `inputs`.
    runJsMock.mockRejectedValue(
      new RunJsFailure(
        'Unexpected token } in JSON at position 12',
        [],
        undefined,
        { line: 1, column: 7 },
        'SyntaxError',
        false,
      ),
    )
    const res = await SuperEditTool.call(
      { code: 'return JSON.parse(await readTextFile("package.json"))' },
      makeContext([]),
      canUseTool,
      invokingRow,
    )
    expect(res.data).toContain('SuperEdit error: Unexpected token')
    expect(res.data).not.toContain('did not parse')
    expect(res.data).not.toContain('`inputs.<name>`')
  })

  it('adds NO parse guidance to a runtime throw — `inputs` would not have helped', async () => {
    // Gated on the script error's own name. A ReferenceError is a logic bug;
    // sending the model to move data around is advice about the wrong problem.
    runJsMock.mockRejectedValue(
      new RunJsFailure(
        'x is not defined',
        [],
        undefined,
        { line: 1, column: 11 },
        'ReferenceError',
      ),
    )
    const res = await SuperEditTool.call(
      { code: 'const y = x + 1;' },
      makeContext([]),
      canUseTool,
      invokingRow,
    )
    expect(res.data).toContain('SuperEdit error: x is not defined')
    expect(res.data).not.toContain('did not parse')
    expect(res.data).not.toContain('`inputs.<name>`')
  })

  it('adds NO parse guidance when the worker sent no error name', async () => {
    // The protocol field is additive + optional (older host, timeout, worker
    // crash): absent must read as "not a parse failure", never as one.
    runJsMock.mockRejectedValue(new RunJsFailure('SuperEdit timed out after 20ms.', []))
    const res = await SuperEditTool.call({ code: 'x' }, makeContext([]), canUseTool, invokingRow)
    expect(res.data).toContain('SuperEdit error: SuperEdit timed out after 20ms.')
    expect(res.data).not.toContain('did not parse')
  })
})

// ── transport-failure classification everywhere ─────

describe('transport-failure classification', () => {
  it('an ok:false transport ENVELOPE at the commit re-stat is `unavailable`, not a conflict', async () => {
    // A dead host-side pipe answers {ok:false, code:'transport_disposed'},
    // which BrowserFsOperations.send flattens into a plain Error — no
    // AbortError name, no 'scope was disposed' prose.
    const ctx = overlayCtx()
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 100 })
      .mockRejectedValueOnce(
        new Error('transport_disposed: DirectPortBridgeTransport has been disposed'),
      )
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'unavailable', attempted: false })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a transport death during the permission/hook GATE is `unavailable`, not `denied`', async () => {
    // The gate rides the same bridge; reporting its death as a denial reads
    // as user refusal and the model abandons the edit.
    const ctx = overlayCtx()
    statMock.mockRejectedValue(NF())
    preHookMock.mockRejectedValue(disposedErr())
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'unavailable', attempted: false })
    expect(outcome).not.toMatchObject({ status: 'denied' })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('an execute-phase transport death HEDGES: the op may have reached disk', async () => {
    statMock.mockRejectedValue(NF())
    writeFileMock.mockRejectedValue(disposedErr())
    mkdirMock.mockRejectedValue(disposedErr())
    runJsMock.mockImplementation(async (opts: { onFsCall: (op: RunJsFsOp, p: Record<string, unknown>) => Promise<unknown> }) => {
      await opts.onFsCall('writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) })
      return { result: 'done', logs: [] }
    })
    const res = await SuperEditTool.call({ code: 'x' }, overlayCtx(), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/may or may not have reached disk/)
    expect(res.data).not.toMatch(/nothing to\s+re-read/)
  })

  it('a pre-execute transport death still says nothing was written (attempted: false)', async () => {
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 100 })
      .mockRejectedValueOnce(disposedErr())
    runJsMock.mockImplementation(async (opts: { onFsCall: (op: RunJsFsOp, p: Record<string, unknown>) => Promise<unknown> }) => {
      await opts.onFsCall('writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) })
      return { result: 'done', logs: [] }
    })
    const res = await SuperEditTool.call({ code: 'x' }, overlayCtx(), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/No files were written/)
    expect(res.data).toMatch(/nothing to\s+re-read/)
  })

  it('a SCRIPT-phase transport death reports the bridge, never a script-line error', async () => {
    runJsMock.mockRejectedValue(
      new RunJsFailure('Runtime scope was disposed.', [], undefined, { line: 3, column: 7 }),
    )
    const res = await SuperEditTool.call({ code: 'line1\nline2\nline3' }, overlayCtx(), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/filesystem bridge is\s+unavailable/)
    expect(res.data).toMatch(/not a script or path problem/)
    expect(res.data).not.toMatch(/script line 3/)
  })

  it('a script-phase read against a dead transport rethrows identity-intact, not NotFoundError', async () => {
    // overlayFs must not rewrite a transport death into a fabricated
    // not-found — the model would "fix" a path that was never wrong.
    const ctx = overlayCtx()
    statMock.mockRejectedValue(disposedErr())
    readFileBytesMock.mockRejectedValue(disposedErr())
    const overlay = newOverlay()
    await expect(
      handleScriptFsOp(overlay, 'readFile', { path: 'a.txt' }, ctx, invokingRow),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      handleScriptFsOp(overlay, 'stat', { path: 'a.txt' }, ctx, invokingRow),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a `path` code-read transport death names the bridge, not the path', async () => {
    readFileMock.mockRejectedValue(disposedErr())
    const res = await SuperEditTool.call({ path: 'scripts/x.js' }, overlayCtx(), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/filesystem bridge is\s+unavailable/)
    expect(res.data).toMatch(/not a problem with scripts\/x\.js/)
  })

  it('a transport death during SNAPSHOT capture stays `unavailable`, not an OperationError partial', async () => {
    // captureSnapshotForOp rewraps capture failures as OperationError; a
    // transport death must keep its identity or the execute-phase check
    // misclassifies the outcome as `partial`. And because the failure was in
    // the SNAPSHOT phase, the target mutation was never issued —
    // `attempted: false`, so the headline says nothing was written instead
    // of over-conservatively hedging.
    const ctx = makeContext([], { readAppState: makeAppState('default') } as never)
    ;(ctx.options as unknown as Record<string, unknown>).sessionId = 's1'
    ;(ctx.options as unknown as Record<string, unknown>).fileSnapshotRecorder = {
      trackBeforeMutation: async () => {
        throw disposedErr()
      },
      trackBeforeDirectoryRemoval: async () => {
        throw disposedErr()
      },
    }
    statMock.mockRejectedValue(NF())
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'unavailable', attempted: false })
    expect(outcome).not.toMatchObject({ status: 'partial' })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a transport death in the write FALLBACK is not overwritten by the original write error', async () => {
    // First write fails for a business reason (missing parent); the mkdir
    // fallback hits the dead pipe. The infrastructure failure's identity must
    // win, or the outcome misclassifies as `partial` carrying the stale
    // business error.
    const ctx = overlayCtx()
    statMock.mockRejectedValue(NF())
    writeFileMock.mockRejectedValue(new Error('FS_ERROR: parent missing'))
    mkdirMock.mockRejectedValue(disposedErr())
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'deep/a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'unavailable', attempted: true })
    expect(outcome).not.toMatchObject({
      status: 'partial',
      message: expect.stringContaining('parent missing'),
    })
  })

  it('a transport death in the rename FALLBACK is not overwritten either', async () => {
    const ctx = overlayCtx()
    statMock.mockResolvedValue(FILE_STAT)
    renameMock.mockRejectedValue(new Error('FS_ERROR: destination parent missing'))
    mkdirMock.mockRejectedValue(disposedErr())
    const outcome = await scriptThenCommit(
      [['move', { path: 'a.txt', newPath: 'deep/b.txt' }]],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'unavailable', attempted: true })
  })

  it("a snapshot pre-stat transport death is not read as 'absent'", async () => {
    const tracked: string[] = []
    const ctx = makeContext([], { readAppState: makeAppState('default') } as never)
    ;(ctx.options as unknown as Record<string, unknown>).sessionId = 's1'
    ;(ctx.options as unknown as Record<string, unknown>).fileSnapshotRecorder = {
      trackBeforeMutation: async (p: string) => {
        tracked.push(p)
      },
      trackBeforeDirectoryRemoval: async (p: string) => {
        tracked.push(p)
      },
    }
    // Baseline stat (script phase) sees a real file; the snapshot pre-stat
    // (commit phase) hits the dead pipe.
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 1, mtimeMs: 1 }) // baseline
      .mockResolvedValueOnce({ isDirectory: () => false, size: 1, mtimeMs: 1 }) // conflict re-stat
      .mockRejectedValueOnce(disposedErr()) // trackRemovalOrMutation stat
    const outcome = await scriptThenCommit([['remove', { path: 'a.txt' }]], ctx)
    expect(outcome).toMatchObject({ status: 'unavailable', attempted: false })
    // The dead-pipe stat must not have fallen through to a file-shaped track.
    expect(tracked).toEqual([])
    expect(unlinkMock).not.toHaveBeenCalled()
  })
})

// ── fs error taxonomy (host ENOENT/EACCES/EBUSY/EUNKNOWN wire codes) ─────────
//
// The host now discriminates stat failures (nexus_fs_host.cc). Only a
// not-found-shaped failure reads as "absent"; a discriminated transient
// failure is surfaced honestly — closing the rounds 2-3 known limitation
// where a transient double-failure could slip a commit past the conflict
// check.

const eaccesErr = (): Error =>
  new Error('FS_ERROR: EACCES: permission denied')

describe('commitOverlay — fs error taxonomy', () => {
  it('a discriminated transient re-stat failure is `unverifiable`, not a conflict or absent', async () => {
    const ctx = overlayCtx()
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 100 }) // baseline
      .mockRejectedValueOnce(eaccesErr()) // commit re-stat
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'unverifiable', path: '/proj/a.txt' })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("the host's ENOENT wire code still reads as absent (new file commits)", async () => {
    const ctx = overlayCtx()
    statMock.mockRejectedValue(new Error('FS_ERROR: ENOENT: no such file or directory'))
    writeFileMock.mockResolvedValue(undefined)
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'new.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome.status).toBe('ok')
    expect(writeFileMock).toHaveBeenCalled()
  })

  it("an OLDER host's ambiguous stat wording keeps the conservative absent behavior", async () => {
    // Degradability: pre-taxonomy hosts say "File not found or permission
    // denied" for every stat failure — the guest must not turn that into
    // `unverifiable`, or a genuinely-new file could never commit there.
    const ctx = overlayCtx()
    statMock.mockRejectedValue(
      new Error('FS_ERROR: File not found or permission denied'),
    )
    writeFileMock.mockResolvedValue(undefined)
    const outcome = await scriptThenCommit(
      [['writeFile', { path: 'new.txt', bytes: new Uint8Array([1]) }]],
      ctx,
    )
    expect(outcome.status).toBe('ok')
  })

  it('the call-level headline says "could not be verified", not "changed on disk"', async () => {
    statMock
      .mockResolvedValueOnce({ isDirectory: () => false, size: 4, mtimeMs: 100 })
      .mockRejectedValueOnce(eaccesErr())
    runJsMock.mockImplementation(async (opts: { onFsCall: (op: RunJsFsOp, p: Record<string, unknown>) => Promise<unknown> }) => {
      await opts.onFsCall('writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) })
      return { result: 'done', logs: [] }
    })
    const res = await SuperEditTool.call({ code: 'x' }, overlayCtx(), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/could not\s+be verified/)
    expect(res.data).toMatch(/EACCES/)
    expect(res.data).not.toMatch(/changed on disk/)
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a transient BASELINE stat failure fails the script loudly instead of seeding null', async () => {
    // A
    // discriminated transient failure at recordWrite's baseline capture can
    // no longer pair with a later failure into a null-vs-null "no conflict".
    const ctx = overlayCtx()
    statMock.mockRejectedValue(eaccesErr())
    const overlay = newOverlay()
    await expect(
      handleScriptFsOp(
        overlay,
        'writeFile',
        { path: 'a.txt', bytes: new Uint8Array([1]) },
        ctx,
        invokingRow,
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('EACCES') })
  })

  it('a detected CONFLICT outranks a later unverifiable path', async () => {
    // a.txt genuinely changed on disk; b.txt's re-stat then fails EACCES.
    // The conflict must win — 're-read then retry' is safe under both
    // hypotheses; 'retry the same call' would clobber the concurrent edit.
    const ctx = overlayCtx()
    statMock.mockImplementation(async (p: string) => {
      if (p === '/proj/a.txt') {
        return { isDirectory: () => false, size: 4, mtimeMs: statMock.mock.calls.filter(c => c[0] === '/proj/a.txt').length > 1 ? 200 : 100 }
      }
      if (p === '/proj/b.txt') {
        // baseline ok, commit re-stat EACCES
        if (statMock.mock.calls.filter(c => c[0] === '/proj/b.txt').length > 1) {
          throw eaccesErr()
        }
        return { isDirectory: () => false, size: 4, mtimeMs: 100 }
      }
      throw NF()
    })
    const outcome = await scriptThenCommit(
      [
        ['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }],
        ['writeFile', { path: 'b.txt', bytes: new Uint8Array([2]) }],
      ],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'conflict', paths: ['/proj/a.txt'] })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('an unverifiable path does not stop the scan when the conflict comes LATER', async () => {
    const ctx = overlayCtx()
    statMock.mockImplementation(async (p: string) => {
      if (p === '/proj/a.txt') {
        if (statMock.mock.calls.filter(c => c[0] === '/proj/a.txt').length > 1) {
          throw eaccesErr()
        }
        return { isDirectory: () => false, size: 4, mtimeMs: 100 }
      }
      if (p === '/proj/b.txt') {
        return { isDirectory: () => false, size: 4, mtimeMs: statMock.mock.calls.filter(c => c[0] === '/proj/b.txt').length > 1 ? 200 : 100 }
      }
      throw NF()
    })
    const outcome = await scriptThenCommit(
      [
        ['writeFile', { path: 'a.txt', bytes: new Uint8Array([1]) }],
        ['writeFile', { path: 'b.txt', bytes: new Uint8Array([2]) }],
      ],
      ctx,
    )
    expect(outcome).toMatchObject({ status: 'conflict', paths: ['/proj/b.txt'] })
  })

  it('a discriminated transient failure at the SNAPSHOT stat aborts the op, never a file-shaped dir snapshot', async () => {
    const tracked: string[] = []
    const dirs: string[] = []
    const ctx = makeContext([], { readAppState: makeAppState('default') } as never)
    ;(ctx.options as unknown as Record<string, unknown>).sessionId = 's1'
    ;(ctx.options as unknown as Record<string, unknown>).fileSnapshotRecorder = {
      trackBeforeMutation: async (p: string) => {
        tracked.push(p)
      },
      trackBeforeDirectoryRemoval: async (p: string) => {
        dirs.push(p)
      },
    }
    // Baseline + conflict re-stat see a directory; the snapshot pre-stat
    // hits a one-shot EBUSY.
    let statCalls = 0
    statMock.mockImplementation(async () => {
      statCalls += 1
      if (statCalls === 3) throw new Error('FS_ERROR: EBUSY: file is in use or locked')
      return { isDirectory: () => true, size: 0, mtimeMs: 1 }
    })
    const outcome = await scriptThenCommit([['remove', { path: 'build' }]], ctx)
    expect(outcome).toMatchObject({ status: 'partial' })
    expect(
      (outcome as { message?: string }).message ?? '',
    ).toMatch(/EBUSY/)
    expect(tracked).toEqual([])
    expect(dirs).toEqual([])
    expect(rmMock).not.toHaveBeenCalled()
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('a transient read failure reaches the script identity-intact, not as NotFoundError', async () => {
    const ctx = overlayCtx()
    statMock.mockRejectedValue(eaccesErr())
    readFileBytesMock.mockRejectedValue(new Error('FS_ERROR: Failed to read file'))
    const overlay = newOverlay()
    await expect(
      handleScriptFsOp(overlay, 'readFile', { path: 'a.txt' }, ctx, invokingRow),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Failed to read file'),
    })
    // A genuinely-missing read still maps to the platform NotFoundError.
    readFileBytesMock.mockRejectedValue(
      new Error('FS_ERROR: ENOENT: no such file or directory'),
    )
    statMock.mockRejectedValue(new Error('FS_ERROR: ENOENT: no such file or directory'))
    await expect(
      handleScriptFsOp(overlay, 'readFile', { path: 'b.txt' }, ctx, invokingRow),
    ).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('a read whose post-read stat hits ENOENT still enters the conflict check', async () => {
    // Delete-then-rewrite race: the read gets old bytes, the stat lands in
    // the deletion window, the file reappears by commit time. The seeded
    // ABSENT baseline turns the reappearance into a conflict instead of an
    // unchecked stale-derived commit.
    const ctx = overlayCtx()
    readFileBytesMock.mockResolvedValue(new Uint8Array([1, 2]))
    let inputStats = 0
    statMock.mockImplementation(async (p: string) => {
      if (p === '/proj/input.txt') {
        inputStats += 1
        if (inputStats === 1) throw NF() // post-read stat: deletion window
        return { isDirectory: () => false, size: 9, mtimeMs: 500 } // reappeared
      }
      throw NF() // out.txt is new
    })
    writeFileMock.mockResolvedValue(undefined)
    const overlay = newOverlay()
    await handleScriptFsOp(overlay, 'readFile', { path: 'input.txt' }, ctx, invokingRow)
    await handleScriptFsOp(overlay, 'writeFile', { path: 'out.txt', bytes: new Uint8Array([9]) }, ctx, invokingRow)
    const outcome = await commitOverlay(overlay, ctx, invokingRow)
    expect(outcome).toMatchObject({ status: 'conflict', paths: ['/proj/input.txt'] })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a transient post-read stat failure fails the read loudly', async () => {
    const ctx = overlayCtx()
    readFileBytesMock.mockResolvedValue(new Uint8Array([1]))
    statMock.mockRejectedValue(eaccesErr())
    const overlay = newOverlay()
    await expect(
      handleScriptFsOp(overlay, 'readFile', { path: 'input.txt' }, ctx, invokingRow),
    ).rejects.toMatchObject({ message: expect.stringContaining('EACCES') })
  })

  it('an unenumerable EXISTING directory rethrows instead of listing as empty', async () => {
    // The host readdir wording is cause-blind; the disambiguating stat says
    // the directory exists — so presenting an overlay-only (empty) listing
    // would invite `readdir().length === 0 → remove(dir)` on a real tree.
    const ctx = overlayCtx()
    readdirMock.mockRejectedValue(new Error('FS_ERROR: Path is not a directory'))
    statMock.mockResolvedValue(DIR_STAT)
    const overlay = newOverlay()
    await expect(
      handleScriptFsOp(overlay, 'readdir', { path: 'build' }, ctx, invokingRow),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Path is not a directory'),
    })
  })

  it('a readdir of a genuinely absent path still reads as NotFoundError', async () => {
    const ctx = overlayCtx()
    readdirMock.mockRejectedValue(new Error('FS_ERROR: Path is not a directory'))
    statMock.mockRejectedValue(NF())
    const overlay = newOverlay()
    await expect(
      handleScriptFsOp(overlay, 'readdir', { path: 'gone' }, ctx, invokingRow),
    ).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('recordMove classifies a directory from its memoized baseline, surviving a transient stat', async () => {
    const ctx = overlayCtx()
    // Seed the baseline via a script-phase stat (the fileHelpers.move probe).
    statMock.mockResolvedValue(DIR_STAT)
    readdirMock.mockResolvedValue([])
    const overlay = newOverlay()
    await handleScriptFsOp(overlay, 'stat', { path: 'src' }, ctx, invokingRow)
    // The source now transiently refuses stats (the destination is simply
    // absent); the move must take the directory branch off the MEMOIZED
    // baseline without issuing the old third stat — which would throw here.
    statMock.mockImplementation(async (p: string) => {
      if (p === '/proj/src') throw eaccesErr()
      throw NF()
    })
    await handleScriptFsOp(
      overlay,
      'move',
      { path: 'src', newPath: 'dst' },
      ctx,
      invokingRow,
    )
    const listing = await overlay.readdirForScript('/proj/dst')
    expect(listing).toEqual([]) // a directory (empty), not a file
  })
})

describe('formatScriptLocation', () => {
  const at = (line: number, column: number) => ({ line, column })

  it('quotes a line that fits whole, with no window header', () => {
    const out = formatScriptLocation('const a = 1;\nboom();', at(2, 1))
    expect(out).toBe('(script line 2:1)\n> boom();')
  })

  it('resolves the column inside the REPORTED line, not the first one', () => {
    // `line 10:C` must send the reader to line 10's own text. Reading the
    // column off line 1 would quote source that has nothing to do with the
    // failure — the worst kind of wrong, since the label asserts a position.
    const lines = Array.from({ length: 9 }, (_, i) => `const v${i} = ${i};`)
    lines.push('const big = boom(x);')
    const out = formatScriptLocation(lines.join('\n'), at(10, 13))
    expect(out).toBe('(script line 10:13)\n> const big = boom(x);')
  })

  it('never windows a MULTI-line script, however long the failing line is', () => {
    // The model laid this script out itself and `line` already names the
    // statement; cutting the line would drop context to save nothing. Only a
    // one-line script gets the column window.
    const long = `const big = '${'A'.repeat(400)}' + boom(x);`
    const out = formatScriptLocation(`const a = 1;\n${long}`, at(2, 415))
    expect(out).toBe(`(script line 2:415)\n> ${long}`)
    expect(out).not.toContain('Source from column')
  })

  it('windows a one-line script whose trailing newline does not make it two', () => {
    const line = `${'y'.repeat(200)}boom();`
    const out = formatScriptLocation(`${line}\n`, at(1, 201))
    expect(out).toBe(`(script line 1:201)\n\nSource from column 161:\n> ${'y'.repeat(40)}boom();`)
  })

  it('strips a trailing CR so a CRLF script does not quote a stray carriage return', () => {
    const out = formatScriptLocation('const a = 1;\r\nboom();\r\n', at(2, 1))
    expect(out).toBe('(script line 2:1)\n> boom();')
  })

  it('caps a one-line script at 120 characters and marks the cut', () => {
    const line = 'y'.repeat(400)
    const out = formatScriptLocation(line, at(1, 51))
    expect(out).toBe(
      `(script line 1:51)\n\nSource from column 11:\n> ${'y'.repeat(120)}\u2026`,
    )
  })

  it('omits the cut marker when the window reaches the end of the line', () => {
    const line = `${'z'.repeat(200)}END`
    const out = formatScriptLocation(line, at(1, 184))
    expect(out).toContain('Source from column 144:\n> ')
    expect(out.endsWith('END')).toBe(true)
    expect(out).not.toContain('\u2026')
  })

  it('clamps a column past the end of the line and labels where it really starts', () => {
    // V8 can report a column one past the last character; an empty window
    // would be worse than a one-character one, and the label must not claim
    // a start the snippet does not have.
    const line = 'q'.repeat(200)
    const out = formatScriptLocation(line, at(1, 9999))
    expect(out).toBe(`(script line 1:9999)\n\nSource from column 160:\n> ${'q'.repeat(41)}`)
  })

  it('keeps lead-in before the failing column so the receiver stays visible', () => {
    // V8 points at the failing TOKEN: for `inputs.body.split(...)` on an
    // undefined body that is `split`, and the message names only the
    // property. A window starting AT the column would drop `inputs.body` —
    // the one thing the model needs to fix.
    const line = `${'const pad = 1; '.repeat(12)}const parts = inputs.body.split(inputs.sep);`
    const column = line.indexOf('split') + 1
    const out = formatScriptLocation(line, at(1, column))
    expect(out).toContain('inputs.body.split(inputs.sep);')
    expect(out).toContain(`Source from column ${column - 40}:`)
  })

  it('reports the coordinates alone when the line is out of range', () => {
    expect(formatScriptLocation('one line only', at(7, 3))).toBe('(script line 7:3)')
  })
})
