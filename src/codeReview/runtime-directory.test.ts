import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { Message } from '../runtime/RuntimeTypes'
import type { GitStreamSpawner } from './git-adapter'
import type { ReviewModelRequest } from './runner'
import { getOrCreateReviewService } from './runtime'
import { resolveRuntimePath } from '../utils/runtimePaths'

const mocks = vi.hoisted(() => ({ gate: vi.fn(), model: vi.fn(), edit: vi.fn() }))
vi.mock('../engine/turnInterpreter', () => ({ runTurnLoop: vi.fn() }))
vi.mock('../permissions/filesystemPermission', () => ({ vetFileRead: async () => ({ behavior: 'allow' }) }))
vi.mock('../permissions/untrustedReadBoundary', () => ({ assertUntrustedReadAllowed: async () => ({ ok: true }) }))
vi.mock('../toolkit/run/toolPermissionGate', () => ({
  buildFilePermissionContext: (context: unknown) => context,
  decideToolPermission: mocks.gate,
  requestQueuedToolUseConfirm: async () => ({ behavior: 'deny' }),
  resolveHeadlessPermissionDecision: async () => ({ behavior: 'deny' }),
}))
vi.mock('../memory/instructionFiles', () => ({ gatherInstructionDocs: async () => [], getNestedInstructionFilesForPath: async () => [], getConditionalRulesForPath: async () => [], formatMemoryFilesForPrompt: () => '' }))
vi.mock('../toolkit/builtin/superEdit', () => ({ SuperEditTool: { name: 'SuperEdit', call: (...args: unknown[]) => mocks.edit(...args) } }))
vi.mock('./runner', async importOriginal => {
  const original = await importOriginal<typeof import('./runner')>()
  return { ...original, createReviewModelRunner: () => (request: ReviewModelRequest) => mocks.model(request) }
})

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const blob = 'c'.repeat(40)
const root = 'D:/review-fixture'
const nested = `${root}/nested`
const clean = (path: string) => path.replace(/\\/g, '/')
const missing = () => Object.assign(new Error('ENOENT: missing'), { name: 'NotFoundError' })

function fixture(shared?: { files: Map<string, string>; directories: Set<string>; sessionId: string }) {
  const files = shared?.files ?? new Map<string, string>([[`${root}/a.ts`, 'export const a = 2\n'], [`${nested}/a.ts`, 'export const a = 3\n']])
  const directories = shared?.directories ?? new Set([root, `${root}/.git`, nested, `${nested}/.git`, `${root}/plain`, 'D:/outside', 'D:/outside/.git'])
  const sessionId = shared?.sessionId ?? crypto.randomUUID()
  const links = new Map([[`${root}/escape`, 'D:/outside']])
  const atomic = vi.fn(async (path: string, content: string) => { files.set(clean(path), content) })
  const fs = {
    realpath: vi.fn(async (path: string) => {
      const value = links.get(clean(path)) ?? clean(path)
      if (!directories.has(value) && !files.has(value) && !value.startsWith('D:/review-storage')) throw missing()
      return value
    }),
    readFile: vi.fn(async (path: string) => { const value = files.get(clean(path)); if (value === undefined) throw missing(); return value }),
    readFileBytes: vi.fn(async (path: string) => { const value = files.get(clean(path)); if (value === undefined) throw missing(); return new TextEncoder().encode(value) }),
    stat: vi.fn(async (path: string) => {
      const directory = directories.has(clean(path))
      if (!directory && !files.has(clean(path))) throw missing()
      return { size: files.get(clean(path))?.length ?? 0, mtimeMs: 1, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false }
    }),
    readdir: vi.fn(async () => []), mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => { files.set(clean(path), typeof data === 'string' ? data : new TextDecoder().decode(data)) }),
  } as unknown as RuntimeFs
  const spawn = vi.fn<GitStreamSpawner>(async (spec, handlers) => {
    let output = '', exitCode = 0
    if (spec.args.includes('rev-parse')) output = spec.args.at(-1)?.includes('@{upstream}') ? base : head
    else if (spec.args.includes('rev-list')) output = `${head} ${base}\n`
    else if (spec.args.includes('hash-object')) output = base
    else if (spec.args.includes('symbolic-ref')) exitCode = 1
    else if (spec.args.includes('merge-base')) output = base
    else if (spec.args.includes('ls-tree')) output = `100644 blob ${blob}\ta.ts\0`
    else if (spec.args.includes('ls-files')) output = spec.args.includes('--stage') ? `100644 ${blob} 0\ta.ts\0` : 'a.ts\0'
    else if (spec.args.includes('config') && spec.args.includes('core.filemode')) output = 'false\n'
    else if (spec.args.includes('cat-file')) output = 'export const a = 1\n'
    else if (spec.args.includes('diff')) output = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    else throw new Error(`Unexpected native call: ${spec.args.join(' ')}`)
    handlers.onOutput?.('stdout', new TextEncoder().encode(output))
    handlers.onExit?.({ exitCode, timedOut: false, killed: false, durationMs: 1 })
    return { streamId: 'fixture', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
  })
  const context = {
    options: { runtimeConfig: {}, projectRoot: root, cwd: root, homeDir: 'D:/review-home', sessionStoragePath: 'D:/review-storage', sessionId, mainLoopModel: 'model', mainLoopProviderId: 'provider', tools: [], fsOperations: fs,
      reviewRuntime: { spawnArgv: spawn, atomicWrite: atomic, promptContextProvider: { gatherSystemPromptSources: async () => ({ defaultSystemPrompt: [], userContext: {}, systemContext: {} }) } } },
    readAppState: () => ({ permissionRules: { mode: 'default', denyRuleBook: {} } }), cancelSource: new AbortController(), fileReadLedger: new Map(), messages: [],
  } as unknown as ToolCallContext
  const permission = vi.fn(async () => ({ behavior: 'allow' as const }))
  return { context, permission, files, directories, sessionId, fs, spawn }
}

async function invoke(request: ReviewModelRequest, name: string, input: Record<string, unknown>) {
  const tool = request.tools.find(tool => tool.name === name)!
  return tool.call(input, { options: {} } as ToolCallContext, () => ({ behavior: 'allow' }), { uuid: crypto.randomUUID() } as Message)
}

async function report(request: ReviewModelRequest, withCandidates = false) {
  const plan = JSON.parse(request.blocks.find(block => block.source === 'resolved-policy')!.text)
  const manifest = JSON.parse(request.blocks.find(block => block.source === 'scope-manifest')!.text)
  const candidates = withCandidates ? manifest.files.map((file: { path: string; anchors: Array<{ anchorKey: string; side: string; span: { start: number } }> }) => {
    const anchor = file.anchors.find(anchor => anchor.side === 'working-copy')!
    return { location: { anchorKey: anchor.anchorKey, path: file.path, line: anchor.span.start }, statement: { headline: 'Incorrect value', details: `Changed value in ${file.path}`, scenario: 'Caller receives an incorrect value' }, kind: 'correctness', impact: 'major', support: [{ path: file.path, quote: '3', relevance: 'Changed value' }], assessment: { disposition: 'plausible', reason: 'Supported by the changed expression' }, angle: 'lines' }
  }) : []
  if (candidates.length) await invoke(request, 'ReviewLedger', { operation: 'append-candidates', candidates })
  const coverage = { angles: plan.angles, limitations: [], complete: true }
  await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage })
  if (request.tools.some(tool => tool.name === 'ReviewOutput')) await invoke(request, 'ReviewOutput', { operation: 'record', candidates, coverage })
  return { text: JSON.stringify({ candidates, coverage }), interrupted: false }
}

/** A stand-in for the edit tool that resolves a relative path from its call context's cwd, as the real tool does. */
async function editRelative(input: { path: string }, context: ToolCallContext) {
  await context.options.fsOperations!.writeFile(resolveRuntimePath(context.options.cwd, input.path), 'edited')
  return { data: 'edited' }
}

/** Rewrites one stored run file; only a fresh service reads the change. */
function tamperStoredRun(files: Map<string, string>, runId: string, change: (run: { run: { scope: { workspaceKey: string } } }) => void) {
  const [path, text] = [...files].find(([path]) => path.endsWith(`/code-review/${runId}.json`))!
  const value = JSON.parse(text)
  change(value)
  files.set(path, JSON.stringify(value))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.gate.mockResolvedValue({ decision: 'allow' })
  mocks.model.mockImplementation(request => report(request))
  mocks.edit.mockImplementation(editRelative)
})

describe('code review -C <dir>', () => {
  it('reviews the repository in the named folder and records the folder for the run', async () => {
    const h = fixture()
    const service = await getOrCreateReviewService(h.context, h.permission)
    const snapshot = await service.wait((await service.startUser('low -C nested main..topic')).runId)
    expect(snapshot.run.scope).toMatchObject({ kind: 'range', workspaceKey: nested })
    const cwds = new Set(h.spawn.mock.calls.map(([spec]) => clean(spec.cwd)))
    expect(cwds).toEqual(new Set([nested]))
    const stored = [...h.files].find(([path]) => path.endsWith(`targets/${snapshot.run.id}.json`))
    expect(JSON.parse(stored![1])).toEqual({ target: 'main..topic', directory: 'nested' })
  })

  it('reviews the session root without -C, and both roots side by side in one session', async () => {
    const h = fixture()
    const service = await getOrCreateReviewService(h.context, h.permission)
    const first = await service.wait((await service.startUser('low')).runId)
    const second = await service.wait((await service.startUser('low -C nested')).runId)
    expect(first.run.scope.workspaceKey).toBe(root)
    expect(second.run.scope.workspaceKey).toBe(nested)
    expect(h.spawn.mock.calls.some(([spec]) => clean(spec.cwd) === root)).toBe(true)
    expect(h.spawn.mock.calls.some(([spec]) => clean(spec.cwd) === nested)).toBe(true)
  })

  it.each([
    ['a parent folder', '../outside'],
    ['an absolute path', 'D:/outside'],
    ['a link that resolves outside the session root', 'escape'],
    ['a missing folder', 'gone'],
    ['a folder without a repository', 'plain'],
  ])('refuses %s before running git', async (_label, directory) => {
    const h = fixture()
    const service = await getOrCreateReviewService(h.context, h.permission)
    const outcome = await service.startUser(`low -C "${directory}"`).then(({ runId }) => service.wait(runId)).then(() => 'ran', error => String(error))
    expect(outcome).toContain('invalid-root')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('accepts a -C folder whose .git is a file naming a linked worktree', async () => {
    const h = fixture()
    const linked = `${root}/linked`
    h.directories.add(linked).add(`${root}/.git/worktrees`).add(`${root}/.git/worktrees/linked`)
    h.files.set(`${linked}/.git`, `gitdir: ${root}/.git/worktrees/linked\n`)
    h.files.set(`${linked}/a.ts`, 'export const a = 4\n')
    const service = await getOrCreateReviewService(h.context, h.permission)
    const snapshot = await service.wait((await service.startUser('low -C linked')).runId)
    expect(snapshot.run.scope.workspaceKey).toBe(linked)
    expect(new Set(h.spawn.mock.calls.map(([spec]) => clean(spec.cwd)))).toEqual(new Set([linked]))
  })

  it('refuses a rerun whose stored -C folder no longer holds a repository instead of reviewing the session root', async () => {
    const h = fixture()
    const first = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await first.startUser('low -C nested')
    await first.wait(runId)
    h.directories.delete(`${nested}/.git`)
    const cold = fixture({ files: h.files, directories: h.directories, sessionId: h.sessionId })
    const service = await getOrCreateReviewService(cold.context, cold.permission)
    const outcome = await service.rerun(runId).then(({ runId: next }) => service.wait(next)).then(() => 'ran', error => String(error))
    expect(outcome).toContain('invalid-root')
    expect(cold.spawn).not.toHaveBeenCalled()
  })

  it('writes a repair in a -C run through a relative path into the named repository', async () => {
    const h = fixture()
    mocks.model.mockImplementation(request => report(request, true))
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('medium -C nested')
    const snapshot = await service.wait(runId)
    const selected = snapshot.diagnostics.find(diagnostic => diagnostic.anchor.path === 'a.ts')!
    mocks.model.mockImplementation(async request => {
      const receipt = JSON.parse((await invoke(request, 'SuperEdit', { path: 'a.ts' })).data as string)
      await invoke(request, 'ReviewActionLog', { updates: [{ diagnosticId: selected.id, observation: 'edited', explanation: 'Authorized selected-file edit', executionRefs: receipt.executionRefs }] })
      return { text: '', interrupted: false }
    })
    await service.requestRepair(runId, [selected.id])
    expect(h.files.get(`${nested}/a.ts`)).toBe('edited')
    expect(h.files.get(`${root}/a.ts`)).toBe('export const a = 2\n')
  })

  it('verifies two repositories at one revision automatically, each on its own', async () => {
    const h = fixture()
    h.files.set(`${nested}/a.ts`, h.files.get(`${root}/a.ts`)!)
    for (const folder of [root, nested]) h.files.set(`${folder}/package.json`, JSON.stringify({ scripts: { test: 'vitest run' } }))
    const original = h.spawn.getMockImplementation()!
    h.spawn.mockImplementation(async (spec, events) => {
      if (spec.file === 'git') return original(spec, events)
      events.onOutput?.('stdout', new TextEncoder().encode('PASS normal input; PASS empty input rejected'))
      events.onExit?.({ exitCode: 0, killed: false, timedOut: false, durationMs: 1 })
      return { streamId: 'check', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
    })
    mocks.model.mockImplementation(async (request: ReviewModelRequest) => {
      if (request.role !== 'behavior') return report(request)
      const ref = JSON.parse(request.blocks.find(block => block.source === 'repair-and-validation-summary')!.text).executions[0].ref
      await invoke(request, 'ReviewBehaviorCheck', { type: 'main-path', description: 'Normal input', evidence: [{ ref, quote: 'PASS normal input' }] })
      await invoke(request, 'ReviewBehaviorCheck', { type: 'boundary', description: 'Empty input', evidence: [{ ref, quote: 'PASS empty input rejected' }] })
      return { text: '', interrupted: false }
    })
    const service = await getOrCreateReviewService(h.context, h.permission)
    const first = await service.wait((await service.startUser('low', undefined, 'panel')).runId)
    expect(first.verifications.at(-1)).toMatchObject({ succeeded: true, missingCases: [] })
    const second = await service.wait((await service.startUser('low -C nested', undefined, 'panel')).runId)
    expect(second.verifications.length).toBeGreaterThan(0)
    expect(h.spawn.mock.calls.filter(([spec]) => spec.file !== 'git').map(([spec]) => clean(spec.cwd))).toEqual([root, nested])
  })

  it('refuses a stored workspace key that changes under normalization', async () => {
    const h = fixture()
    const first = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await first.startUser('low -C nested')
    await first.wait(runId)
    tamperStoredRun(h.files, runId, value => { value.run.scope.workspaceKey = `${root}/../outside` })
    const cold = fixture({ files: h.files, directories: h.directories, sessionId: h.sessionId })
    const service = await getOrCreateReviewService(cold.context, cold.permission)
    await expect(service.requestVerification(runId)).rejects.toThrow('verification-workspace-mismatch')
    expect(cold.spawn.mock.calls.every(([spec]) => clean(spec.cwd) === nested)).toBe(true)
  })

  it('reassesses the other roots after an edit when one root fails', async () => {
    const h = fixture()
    mocks.model.mockImplementation(request => report(request, true))
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low -C nested')
    await service.wait(runId)
    mocks.model.mockImplementation(async (request: ReviewModelRequest) => {
      const material = JSON.parse(request.blocks.find(block => block.source === 'reassessment-evidence')!.text)
      return { interrupted: false, text: JSON.stringify({ updates: material.diagnostics.map((d: { id: string }) => ({ diagnosticId: d.id, outcome: 'resolved', explanation: 'The expression now restores the required value.', mutationRefs: [material.mutations[0].ref], evidence: [{ path: 'a.ts', quote: 'export const a = 1', relevance: 'The original value contract is restored.' }] })) }) }
    })
    const realpath = vi.mocked(h.fs.realpath!).getMockImplementation()!
    let failed = false
    vi.mocked(h.fs.realpath!).mockImplementation(async (path, options) => {
      if (!failed && clean(path) === `${nested}/a.ts`) { failed = true; throw new Error('EIO: device error') }
      return realpath(path, options)
    })
    const { captureWorkspaceMutation, observeWorkspaceMutation } = await import('./mutation-observer')
    const before = await captureWorkspaceMutation(h.context, [`${nested}/a.ts`])
    h.files.set(`${nested}/a.ts`, 'export const a = 1\n')
    await observeWorkspaceMutation(h.context, 'write', before)
    await vi.waitFor(async () => expect((await service.store.getSnapshot(runId)).actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'repair', state: 'applied' })])))
    expect(failed).toBe(true)
  })
})
