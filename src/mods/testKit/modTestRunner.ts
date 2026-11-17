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

export type ModTestFile = {
  file: string
  /** The file did not compile, load or run: no case result. */
  error?: string
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
  loadTypeScript?: () => Promise<typeof TS>
}

export const MOD_TEST_FILE = /\.test\.(ts|tsx|mts|js|jsx|mjs)$/
const MAX_FILES = 50
const MAX_DEPTH = 6
const DEFAULT_TIMEOUT_MS = 60_000

const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}/${name}`

/** The test files under `folder`, sorted; dot folders and `node_modules` skipped. */
export async function findModTestFiles(folder: string, fs: Pick<ModTestFs, 'readdir'>): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return
    let entries: Awaited<ReturnType<ModTestFs['readdir']>>
    try {
      entries = await fs.readdir(dir)
    } catch {
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
  return tests.map(raw => {
    const test = (raw ?? {}) as { name?: unknown; ok?: unknown; message?: unknown; frames?: unknown }
    const at = test.ok === true ? undefined : locate(lines, test.frames)
    return {
      name: String(test.name ?? ''),
      ok: test.ok === true,
      ...(test.ok === true ? {} : { message: String(test.message ?? 'failed') }),
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
    return { file, error: error instanceof ModCompileError ? error.message : `it did not compile: ${errorText(error)}`, tests: [] }
  }
  let worker: ModWorkerHandle
  try {
    worker = await options.openWorker()
  } catch (error) {
    return { file, error: `no worker to run it in: ${errorText(error)}`, tests: [] }
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let failure: string | undefined
  const dispatcher = new ModDispatcher({
    budgetMs: timeoutMs,
    catchMs: 1_000,
    onHookFailure: report => {
      failure = report.failure.kind === 'timeout' ? `the tests ran past ${timeoutMs} ms` : (report.failure.message ?? 'the run failed')
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
    const result = await dispatcher.dispatch('test.run', {}, () => undefined)
    const tests = casesOf(result, lines)
    if (!tests) return { file, error: failure ?? 'the run returned no results', tests: [] }
    return { file, tests }
  } catch (error) {
    return { file, error: errorText(error), tests: [] }
  } finally {
    instance.dispose()
    worker.close()
  }
}

/** Every test file under the folder, one after the other. Never rejects. */
export async function runModTests(options: ModTestOptions): Promise<ModTestReport> {
  const files: ModTestFile[] = []
  for (const file of await findModTestFiles(options.folder, options.fs)) files.push(await runFile(file, options))
  const cases = files.flatMap(file => file.tests)
  return {
    folder: options.folder,
    files,
    passed: cases.filter(test => test.ok).length,
    failed: cases.filter(test => !test.ok).length + files.filter(file => file.error !== undefined).length,
  }
}

/** The report as text, one line per case. */
export function formatModTestReport(report: ModTestReport): string {
  const lines: string[] = []
  if (report.files.length === 0) return `No test files (*.test.ts, *.test.js, …) under ${report.folder}.`
  for (const file of report.files) {
    lines.push(file.file)
    if (file.error !== undefined) lines.push(`  ✗ ${file.error}`)
    for (const test of file.tests) {
      const where = test.at ? ` (${test.at.file}:${test.at.line})` : ''
      lines.push(test.ok ? `  ✓ ${test.name}` : `  ✗ ${test.name}: ${test.message ?? ''}${where}`)
    }
  }
  lines.push(`${report.passed} passed, ${report.failed} failed`)
  return lines.join('\n')
}
