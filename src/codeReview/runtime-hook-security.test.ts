import { beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, realpath, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { Message } from '../runtime/RuntimeTypes'
import type { GitStreamSpawner } from './git-adapter'
import type { ReviewModelRequest } from './runner'
import { getOrCreateReviewService } from './runtime'
import { attachTransientHook } from '../lifecycleHooks/sessionScopedHooks'

const mocks = vi.hoisted(() => ({ model: vi.fn() }))
vi.mock('../engine/turnInterpreter', () => ({ runTurnLoop: vi.fn() }))
vi.mock('./runner', async importOriginal => {
  const original = await importOriginal<typeof import('./runner')>()
  return { ...original, createReviewModelRunner: () => mocks.model }
})

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const blob = 'c'.repeat(40)
let root: string
const clean = (path: string) => path.replace(/\\/g, '/')
const missing = () => Object.assign(new Error('ENOENT: missing'), { name: 'NotFoundError' })

function fixture() {
  const files = new Map<string, string>([[`${root}/a.ts`, 'export const a = 2\n'], [`${root}/b.ts`, 'export const b = 2\n']])
  const writes = vi.fn(async (path: string, data: string | Uint8Array) => { files.set(clean(path), typeof data === 'string' ? data : new TextDecoder().decode(data)) })
  const atomic = vi.fn(async (path: string, content: string) => { JSON.parse(content); files.set(clean(path), content) })
  const fs = {
    realpath: vi.fn(async (path: string) => clean(path)),
    readFile: vi.fn(async (path: string) => { const value = files.get(clean(path)); if (value === undefined) throw missing(); return value }),
    readFileBytes: vi.fn(async (path: string) => { const value = files.get(clean(path)); if (value === undefined) throw missing(); return new TextEncoder().encode(value) }),
    stat: vi.fn(async (path: string) => {
      const directory = [root, `${root}/.git`].includes(clean(path))
      if (!directory && !files.has(clean(path))) throw missing()
      return { size: files.get(clean(path))?.length ?? 0, mtimeMs: 1, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false }
    }),
    readdir: vi.fn(async () => []), mkdir: vi.fn(async () => {}), writeFile: writes,
  } as unknown as RuntimeFs
  const spawn = vi.fn<GitStreamSpawner>(async (spec, handlers) => {
    let output = '', exitCode = 0
    if (spec.args.includes('rev-parse')) output = spec.args.at(-1)?.includes('@{upstream}') ? base : head
    else if (spec.args.includes('rev-list')) output = `${head} ${base}\n`
    else if (spec.args.includes('hash-object')) output = base
    else if (spec.args.includes('symbolic-ref')) exitCode = 1
    else if (spec.args.includes('merge-base')) output = base
    else if (spec.args.includes('ls-tree')) output = `100644 blob ${blob}\ta.ts\0` + `100644 blob ${blob}\tb.ts\0`
    else if (spec.args.includes('ls-files')) output = spec.args.includes('--stage') ? `100644 ${blob} 0\ta.ts\0` + `100644 ${blob} 0\tb.ts\0` : 'a.ts\0b.ts\0'
    else if (spec.args.includes('config') && spec.args.includes('core.filemode')) output = 'false\n'
    else if (spec.args.includes('cat-file')) output = 'export const value = 1\n'
    else if (spec.args.includes('diff')) output = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    else throw new Error(`Unexpected native call: ${spec.args.join(' ')}`)
    handlers.onOutput?.('stdout', new TextEncoder().encode(output))
    handlers.onExit?.({ exitCode, timedOut: false, killed: false, durationMs: 1 })
    return { streamId: 'fixture', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
  })
  const permission = vi.fn(async () => ({ behavior: 'allow' as const }))
  const controller = new AbortController()
  const context = {
    options: { runtimeConfig: {}, projectRoot: root, cwd: root, homeDir: 'D:/review-home', sessionStoragePath: 'D:/review-storage', sessionId: crypto.randomUUID(), mainLoopModel: 'model-first', mainLoopProviderId: 'provider-first', tools: [], fsOperations: fs,
      reviewRuntime: { spawnArgv: spawn, atomicWrite: atomic, promptContextProvider: { gatherSystemPromptSources: async () => ({ defaultSystemPrompt: [], userContext: {}, systemContext: {} }) } } },
    readAppState: () => ({ permissionRules: { mode: 'default', denyRuleBook: {} } }), cancelSource: controller, fileReadLedger: new Map(), messages: [],
  } as unknown as ToolCallContext
  return { context, permission, fs, files, writes, atomic, spawn }
}

async function invoke(request: ReviewModelRequest, name: string, input: Record<string, unknown>) {
  const tool = request.tools.find(tool => tool.name === name)!
  return tool.call(input, { options: {} } as ToolCallContext, () => ({ behavior: 'allow' }), { uuid: crypto.randomUUID() } as Message)
}

async function report(request: ReviewModelRequest, withCandidates = false) {
  const manifest = JSON.parse(request.blocks.find(block => block.source === 'scope-manifest')!.text)
  const plan = JSON.parse(request.blocks.find(block => block.source === 'resolved-policy')!.text)
  const candidates = withCandidates ? manifest.files.map((file: { path: string; anchors: Array<{ anchorKey: string; side: string; span: { start: number } }> }) => {
    const anchor = file.anchors.find(anchor => anchor.side === 'working-copy')!
    return { location: { anchorKey: anchor.anchorKey, path: file.path, line: anchor.span.start }, statement: { headline: 'Incorrect value', details: `Changed value in ${file.path}`, scenario: 'Caller receives an incorrect value' }, kind: 'correctness', impact: 'major', support: [{ path: file.path, quote: '2', relevance: 'Changed value' }], assessment: { disposition: 'plausible', reason: 'Supported by the changed expression' }, angle: 'lines' }
  }) : []
  if (candidates.length) await invoke(request, 'ReviewLedger', { operation: 'append-candidates', candidates })
  const coverage = { angles: plan.angles, limitations: [], complete: true }
  await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage })
  return { text: JSON.stringify({ candidates, coverage }), interrupted: false }
}

beforeEach(() => { vi.clearAllMocks(); mocks.model.mockImplementation(request => report(request)) })

it.skipIf(!process.env.VELLOC_REVIEW_TEST_SCRATCH).each(['test', 'typecheck', 'dev'].flatMap(name => ['manifest', 'instructions', 'hook-reject', 'execution-deny', 'collection-manifest', 'collection-instructions'].map(change => ({name, change}))))('does not reopen the final Read hook after input comparisons: $name $change', async ({name, change}) => {
  root = clean(await mkdtemp(join(process.env.VELLOC_REVIEW_TEST_SCRATCH!, 'review-hook-')))
  const originalScript = name === 'dev' ? 'vite' : 'vitest run'
  await writeFile(root + '/package.json', JSON.stringify({scripts: {[name]: originalScript}}))
  await writeFile(root + '/go.mod', '// present but no go test command\n')
  await writeFile(root + '/AGENTS.md', 'npm run dev at http://localhost:3000/\nUse the documented scripts.\n')
  const h = fixture()
  const state = {permissionRules: {mode: 'default', denyRuleBook: {}, askRuleBook: {}}, sessionHooks: new Map()}
  h.context.readAppState = () => state as any
  h.context.writeAppState = updater => { updater(state as any) }
  h.context.options.runtimeConfig = {getEnv: () => undefined} as any
  h.context.options.commands = []
  h.context.options.agentDefinitions = {enabledAgents: []} as any
  let approved = false, packageReads = 0, changed = false, paused = false, controlReached = false
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(r => {entered = r})
  const continuation = new Promise<void>(r => {release = r})
  const trace: string[] = []
  const disk = new Set([root + '/package.json', root + '/go.mod', root + '/AGENTS.md'])
  const originalRealpath = vi.mocked(h.fs.realpath!).getMockImplementation()!
  vi.mocked(h.fs.realpath!).mockImplementation(async (p, opts) => disk.has(clean(p)) ? clean(await realpath(clean(p))) : originalRealpath(p, opts))
  const originalRead = vi.mocked(h.fs.readFile).getMockImplementation()!
  vi.mocked(h.fs.readFile).mockImplementation(async (p, opts) => disk.has(clean(p)) ? readFile(clean(p), 'utf8') : originalRead(p, opts))
  const originalBytes = vi.mocked(h.fs.readFileBytes).getMockImplementation()!
  vi.mocked(h.fs.readFileBytes).mockImplementation(async (p, max) => {
    if (disk.has(clean(p))) {
      const bytes = new Uint8Array(await readFile(clean(p)))
      if (approved && clean(p) === root + '/package.json') {packageReads++; trace.push('package read ' + packageReads)}
      return bytes
    }
    return originalBytes(p, max)
  })
  const originalStat = vi.mocked(h.fs.stat).getMockImplementation()!
  vi.mocked(h.fs.stat).mockImplementation(async p => disk.has(clean(p)) ? lstat(clean(p)) : originalStat(p))
  h.context.requestToolUseConfirm = async request => { if (request.toolName === 'ReviewVerification') { approved = true; trace.push('execution approval') }; return {behavior: 'allow'} as any }
  h.context.platformCapabilities = {browser: {callTool: async (request: { args: { hook_stdin: string } }) => {
    const input = JSON.parse(request.args.hook_stdin)
    if (approved && input.tool_name === 'Read' && clean(input.tool_input.file_path) === root + '/go.mod' && packageReads === 3) {
      controlReached = true
      if (change === 'hook-reject') return { output: 'Read rejected', exit_code: 2 }
      if (change === 'execution-deny') state.permissionRules.mode = 'plan'
      if (change === 'collection-manifest') await writeFile(root + '/package.json', JSON.stringify({ scripts: { [name]: 'node unapproved-script.js' } }))
      if (change === 'collection-instructions') await writeFile(root + '/AGENTS.md', 'Do not execute any project scripts.\n')
    }
    if (input.tool_name === 'Read' && clean(input.tool_input.file_path) === root + '/go.mod' && approved && packageReads === 4 && !paused) {
      paused = true; trace.push('sealed go.mod hook waiting'); entered(); await continuation; trace.push('sealed go.mod hook resumed')
    }
    return {output: '', exit_code: 0}
  }}} as any
  attachTransientHook(h.context.writeAppState, h.context.options.sessionId, 'PreToolUse', 'Read', {type: 'command', command: 'read-policy-check', timeout: 30})
  const service = await getOrCreateReviewService(h.context, h.permission)
  const {runId} = await service.startUser('low'); await service.wait(runId)
  const originalSpawn = h.spawn.getMockImplementation()!
  const executed: unknown[] = []
  h.spawn.mockImplementation(async (spec, events) => {
    if (spec.file === 'git') return originalSpawn(spec, name === 'dev' ? {...events, onOutput: (stream, bytes) => events.onOutput?.(stream, new TextEncoder().encode(new TextDecoder().decode(bytes).replaceAll('a.ts', 'app.tsx')))} : events)
    const script = JSON.parse(await readFile(root + '/package.json','utf8')).scripts[name]
    executed.push({file: spec.file, args: spec.args, script, changed, instructions: await readFile(root + '/AGENTS.md', 'utf8')})
    trace.push('spawn: ' + script)
    if (name !== 'dev') events.onExit?.({exitCode: 0, killed: false, timedOut: false, durationMs: 1})
    return {streamId:'observed', write:async()=>true, closeStdin:async()=>true, kill:async()=>true, detach(){}}
  })
  mocks.model.mockResolvedValue({text:'{}', interrupted:false})
  if(name === 'dev') {
    h.files.set(root + '/app.tsx', 'new\n')
    mocks.model.mockImplementation(async request => {
      const tool = request.tools.find((tool:any) => tool.name === 'ReviewStartDevelopment')!
      await tool.call({}, {cancelSource: new AbortController()} as ToolCallContext, h.permission, {} as Message)
      return {text:'{}',interrupted:false}
    })
  }
  const done = service.requestVerification(runId).catch(error => {trace.push('result: '+ error.message)})
  await Promise.race([waiting, done])
  if (paused) {
  changed = true
  if(change === 'manifest') await writeFile(root + '/package.json', JSON.stringify({scripts: {[name]:'node unapproved-script.js'}}))
  else await writeFile(root + '/AGENTS.md', 'Do not execute any project scripts.\n')
  trace.push('disk mutation: ' + change)
  release()
  }
  await done
  if (paused) {
    expect(executed).toHaveLength(1)
    expect(executed[0]).toMatchObject({ changed: true, script: change === 'manifest' ? 'node unapproved-script.js' : originalScript })
  }
  expect(paused).toBe(false)
  if (['hook-reject', 'execution-deny', 'collection-manifest', 'collection-instructions'].includes(change)) {
    expect(controlReached).toBe(true)
    expect(executed, JSON.stringify(trace)).toEqual([])
    return
  }
  expect(executed, JSON.stringify(trace)).toHaveLength(1)
  expect(executed[0]).toMatchObject({ changed: false, script: originalScript, instructions: 'npm run dev at http://localhost:3000/\nUse the documented scripts.\n' })
}, 20000)
