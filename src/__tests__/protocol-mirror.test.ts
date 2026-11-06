/**
 * The protocol mirror in the Chromium WebUI tree is up to date: `scripts/sync_runtime_protocol_mirror.py --check`
 * runs here. Skipped without the sibling repos or python.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const NEXUS_WEB = join(__dirname, '..', '..')
const SCRIPT = join(NEXUS_WEB, 'scripts', 'sync_runtime_protocol_mirror.py')
// The child is killed at SCRIPT_TIMEOUT_MS; the test timeout sits above it so
// the kill, not vitest, reports a stalled interpreter. The spawn is async so
// the worker thread stays free while the child runs.
const SCRIPT_TIMEOUT_MS = 60_000

interface CheckResult {
  code: number | string | null
  signal: NodeJS.Signals | null
  killed: boolean
  stdout: string
  stderr: string
}

function runCheck(): Promise<CheckResult> {
  return new Promise((resolve) => {
    execFile(
      'python',
      [SCRIPT, '--check'],
      { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; signal?: NodeJS.Signals; killed?: boolean }) | null
        resolve({
          code: failure ? (failure.code ?? null) : 0,
          signal: failure?.signal ?? null,
          killed: failure?.killed ?? false,
          stdout,
          stderr,
        })
      },
    )
  })
}

describe('the WebUI protocol mirror', () => {
  it(
    'matches the sources it was copied from',
    async () => {
      // The Chromium tree is what the mirror is written into; without it (a
      // nexus_web-only checkout) there is nothing to be stale. It sits one level
      // up from the main checkout and four from a worktree, so walk.
      const hasChromiumTree = (() => {
        let dir = NEXUS_WEB
        for (let i = 0; i < 6; i += 1) {
          if (existsSync(join(dir, 'src', 'custom_browser'))) return true
          dir = join(dir, '..')
        }
        return false
      })()
      if (!hasChromiumTree) {
        console.warn('[protocol-mirror] no sibling src/custom_browser checkout — skipped')
        return
      }
      const result = await runCheck()
      if (result.code === 'ENOENT') {
        console.warn('[protocol-mirror] python not on PATH — skipped')
        return
      }
      if (result.killed) {
        throw new Error(
          `the mirror check did not finish in ${SCRIPT_TIMEOUT_MS} ms (python killed, ${result.signal ?? 'no signal'})`,
        )
      }
      if (result.code !== 0) {
        throw new Error(`the WebUI protocol mirror is out of date:\n${result.stdout}${result.stderr}`)
      }
      expect(result.stdout).toContain('match their nexus_web sources')
    },
    SCRIPT_TIMEOUT_MS + 10_000,
  )
})
