/**
 * Runs a plugin's tests (F-25): each `*.test.*` file under the plugin folder
 * is compiled with the plugin's own files and the test kit into one module,
 * loaded in a mod worker of its own, and its tests run there against a mock
 * `$`. Nothing a test does reaches the session.
 */

import KIT_SOURCE from './kitRuntime.js?raw'
import { ModCompileError, compileModModule, type ModCompileFs } from '../modCompiler'
import { ModDispatcher } from '../ModDispatcher'
import { ModInstance } from '../ModInstance'
import type { ModWorkerHandle } from '../ModRuntime'
import { sourceLocationOf, type ModFrame, type ModLineMap, type ModSourceLocation } from '../modLineMap'
import type * as TS from 'typescript'

export type ModTestCase = {
  name: string
  ok: boolean
  /** Why it failed. */
  message?: string
  /** Where it failed, in the source, when the stack says. */
  at?: ModSourceLocation
}

/** Why a file has no case results. */
export type ModTestFileErrorKind = 'compile' | 'noWorker' | 'timeout' | 'run' | 'noResults' | 'unreadable'

export type ModTestFile = {
  file: string
  /** The file did not compile, load or run: no case result. */
  error?: string
  /** Set with `error`; `error` is the detail. */
  errorKind?: ModTestFileErrorKind
  tests: ModTestCase[]
}

export type ModTestReport = {
  folder: string
  files: ModTestFile[]
  passed: number
  failed: number
}

/** The worker one test file runs in. */
export type ModTestWorker = ModWorkerHandle

export type ModTestFs = ModCompileFs & {
  readdir(path: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>
}

export type ModTestOptions = {
  /** The plugin folder, absolute. */
  folder: string
  fs: ModTestFs
  /** A fresh mod worker for one test file; closed when it is done. */
  openWorker: () => Promise<ModWorkerHandle>
  /** The time one file's tests may take, all together. */
  timeoutMs?: number
  /** The time one case may take. */
  caseTimeoutMs?: number
  /** How long before the file's budget the kit stops starting cases. */
  fileMarginMs?: number
  /** Stop: the file running is cut short and its worker closed. */
  signal?: AbortSignal
  loadTypeScript?: () => Promise<typeof TS>
}

export const MOD_TEST_FILE = /\.test\.(ts|tsx|mts|js|jsx|mjs)$/
const MAX_FILES = 50
const MAX_DEPTH = 6
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_CASE_TIMEOUT_MS = 10_000
/** The kit stops starting cases this long before the file's budget ends. */
const FILE_MARGIN_MS = 2_000
const MAX_CASES = 500
const MAX_NAME = 200
const MAX_MESSAGE = 2_000

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}/${name}`

/**
 * The test files under `folder`, sorted; dot folders and `node_modules`
 * skipped. Rejects when `folder` itself cannot be listed; a subfolder that
 * cannot is passed to `onUnreadable`.
 */
export async function findModTestFiles(
  folder: string,
  fs: Pick<ModTestFs, 'readdir'>,
  onUnreadable: (dir: string, error: unknown) => void = () => {},
): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return
    let entries: Awaited<ReturnType<ModTestFs['readdir']>>
    try {
      entries = await fs.readdir(dir)
    } catch (error) {
      if (depth === 0) throw error
      onUnreadable(dir, error)
      return
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_FILES) return
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        await walk(join(dir, entry.name), depth + 1)
      } else if (entry.isFile() && MOD_TEST_FILE.test(entry.name)) {
        found.push(join(dir, entry.name))
      }
    }
  }
  await walk(folder.replace(/\\/g, '/'), 0)
  return found
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function locate(lines: ModLineMap | undefined, frames: unknown): ModSourceLocation | undefined {
  if (!lines || !Array.isArray(frames)) return undefined
  for (const frame of frames as ModFrame[]) {
    const at = typeof frame?.line === 'number' ? sourceLocationOf(lines, frame.line) : undefined
    if (at) return at
  }
  return undefined
}

function casesOf(value: unknown, lines: ModLineMap | undefined): ModTestCase[] | undefined {
  const tests = (value as { tests?: unknown } | null | undefined)?.tests
  if (!Array.isArray(tests)) return undefined
  return tests.slice(0, MAX_CASES).map(raw => {
    const test = (raw ?? {}) as { name?: unknown; ok?: unknown; message?: unknown; frames?: unknown }
    const at = test.ok === true ? undefined : locate(lines, test.frames)
    return {
      name: clip(String(test.name ?? ''), MAX_NAME),
      ok: test.ok === true,
      ...(test.ok === true ? {} : { message: clip(String(test.message ?? 'failed'), MAX_MESSAGE) }),
      ...(at ? { at } : {}),
    }
  })
}

async function runFile(file: string, options: ModTestOptions): Promise<ModTestFile> {
  let source: string
  let lines: ModLineMap | undefined
  try {
    const built = await compileModModule({
      entry: file,
      root: options.folder,
      fs: options.fs,
      testKit: KIT_SOURCE,
      ...(options.loadTypeScript ? { loadTypeScript: options.loadTypeScript } : {}),
    })
    source = built.source
    lines = built.lines
  } catch (error) {
    return { file, error: clip(errorText(error), MAX_MESSAGE), errorKind: 'compile', tests: [] }
  }
  options.signal?.throwIfAborted()
  let worker: ModWorkerHandle
  try {
    worker = await options.openWorker()
  } catch (error) {
    return { file, error: clip(errorText(error), MAX_MESSAGE), errorKind: 'noWorker', tests: [] }
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let failure: Pick<ModTestFile, 'error' | 'errorKind'> | undefined
  const dispatcher = new ModDispatcher({
    budgetMs: timeoutMs,
    catchMs: 1_000,
    onHookFailure: report => {
      failure =
        report.failure.kind === 'timeout'
          ? { error: `${timeoutMs}`, errorKind: 'timeout' }
          : { error: clip(report.failure.message ?? '', MAX_MESSAGE), errorKind: 'run' }
    },
  })
  const instance = new ModInstance({
    key: 'test',
    plugin: 'test',
    tier: 'user',
    generation: 1,
    peer: worker.port,
    dispatcher,
    // Security: a test's `$` is the kit's mock; a call that still crosses
    // the port is refused, never served from the session.
    serveCall: async call => {
      throw new Error(`$.${call.noun}.${call.method} is not served to a test`)
    },
  })
  try {
    await instance.load(source, {})
    const run = {
      caseMs: options.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
      fileMs: Math.max(0, timeoutMs - (options.fileMarginMs ?? FILE_MARGIN_MS)),
    }
    const result = await dispatcher.dispatch('test.run', run, () => undefined, options.signal ? { signal: options.signal } : {})
    const tests = casesOf(result, lines)
    if (!tests) return { file, ...(failure ?? { error: '', errorKind: 'noResults' }), tests: [] }
    return { file, tests }
  } catch (error) {
    options.signal?.throwIfAborted()
    return { file, error: clip(errorText(error), MAX_MESSAGE), errorKind: 'run', tests: [] }
  } finally {
    instance.dispose()
    worker.close()
  }
}

/**
 * Every test file under the folder, one after the other. Rejects when the
 * folder cannot be listed, and on `signal`'s abort.
 */
export async function runModTests(options: ModTestOptions): Promise<ModTestReport> {
  const files: ModTestFile[] = []
  const found = await findModTestFiles(options.folder, options.fs, (dir, error) =>
    files.push({ file: dir, error: clip(errorText(error), MAX_MESSAGE), errorKind: 'unreadable', tests: [] }),
  )
  for (const file of found) {
    options.signal?.throwIfAborted()
    files.push(await runFile(file, options))
  }
  const cases = files.flatMap(file => file.tests)
  return {
    folder: options.folder,
    files,
    passed: cases.filter(test => test.ok).length,
    failed: cases.filter(test => !test.ok).length + files.filter(file => file.error !== undefined).length,
  }
}

/** The report as text, one line per case. */
const FILE_ERROR_TEXT: Record<ModTestFileErrorKind, (detail: string) => string> = {
  compile: detail => `it did not compile: ${detail}`,
  noWorker: detail => `no worker to run it in: ${detail}`,
  timeout: ms => `the tests ran past ${ms} ms`,
  run: detail => `the run failed: ${detail}`,
  noResults: () => 'the run returned no results',
  unreadable: detail => `this folder could not be read: ${detail}`,
}

/** A file's error as model-facing text. */
export const modTestFileErrorText = (file: ModTestFile): string =>
  FILE_ERROR_TEXT[file.errorKind ?? 'run'](file.error ?? '')

export function formatModTestReport(report: ModTestReport): string {
  const lines: string[] = []
  if (report.files.length === 0) return `No test files (*.test.ts, *.test.js, …) under ${report.folder}.`
  for (const file of report.files) {
    lines.push(file.file)
    if (file.error !== undefined) lines.push(`  ✗ ${modTestFileErrorText(file)}`)
    for (const test of file.tests) {
      const where = test.at ? ` (${test.at.file}:${test.at.line})` : ''
      lines.push(test.ok ? `  ✓ ${test.name}` : `  ✗ ${test.name}: ${test.message ?? ''}${where}`)
    }
  }
  lines.push(`${report.passed} passed, ${report.failed} failed`)
  return lines.join('\n')
}
