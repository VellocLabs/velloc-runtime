/**
 * The protocol mirror in the Chromium WebUI tree is up to date: `scripts/sync_runtime_protocol_mirror.py --check`
 * runs here. Skipped without the sibling repos or python.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const NEXUS_WEB = join(__dirname, '..', '..')
const SCRIPT = join(NEXUS_WEB, 'scripts', 'sync_runtime_protocol_mirror.py')

describe('the WebUI protocol mirror', () => {
  it('matches the sources it was copied from', () => {
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
    let output: string
    try {
      output = execFileSync('python', [SCRIPT, '--check'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string; code?: string }
      if (failure.code === 'ENOENT') {
        console.warn('[protocol-mirror] python not on PATH — skipped')
        return
      }
      throw new Error(
        `the WebUI protocol mirror is out of date:\n${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      )
    }
    expect(output).toContain('match their nexus_web sources')
  })
})
