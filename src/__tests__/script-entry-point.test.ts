import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error — plain .mjs build script, no types
import { isMainModule } from '../../scripts/lib/isMainModule.mjs'

/**
 * The run-when-executed guard at the bottom of scripts/*.mjs (scripts/lib/isMainModule.mjs) must hold when the
 * script is launched through a directory junction, where import.meta.url is the real path and process.argv[1] the
 * junction path. `junction` is honoured on Windows and an ordinary directory symlink elsewhere.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

let tmp: string
let realDir: string
let linkDir: string
let scriptsLink: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nexus-script-entry-'))
  realDir = join(tmp, 'real')
  mkdirSync(realDir)
  writeFileSync(join(realDir, 'mod.mjs'), '')
  writeFileSync(join(realDir, 'other.mjs'), '')
  linkDir = join(tmp, 'link')
  symlinkSync(realDir, linkDir, 'junction')
  // Points at the REAL scripts/ directory, so it is removed by unlinking the
  // link itself — never by a recursive delete that could follow it.
  scriptsLink = join(tmp, 'scripts-link')
  symlinkSync(join(repoRoot, 'scripts'), scriptsLink, 'junction')
})

afterAll(() => {
  if (!tmp) return
  for (const link of [scriptsLink, linkDir]) {
    if (link && existsSync(link)) unlinkSync(link)
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe('isMainModule', () => {
  const modUrl = () => pathToFileURL(join(realDir, 'mod.mjs')).href

  it('is true when argv[1] names the module through a junction', () => {
    expect(isMainModule(modUrl(), join(linkDir, 'mod.mjs'))).toBe(true)
  })

  it('is true when argv[1] is the module’s own path', () => {
    expect(isMainModule(modUrl(), join(realDir, 'mod.mjs'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('ignores case on Windows', () => {
    expect(isMainModule(modUrl(), join(linkDir, 'mod.mjs').toUpperCase())).toBe(true)
  })

  it('is false for a different file, or no entry file at all', () => {
    expect(isMainModule(modUrl(), join(linkDir, 'other.mjs'))).toBe(false)
    expect(isMainModule(modUrl(), join(linkDir, 'missing.mjs'))).toBe(false)
    expect(isMainModule(modUrl(), undefined)).toBe(false)
  })

  describe('when realpath fails', () => {
    // realpath can throw for a path the loader ran happily (a network or
    // subst drive, an unreadable parent). It used to collapse to "imported",
    // and the script exited 0 having done nothing — the very failure the
    // real-path comparison was added to prevent.
    let spy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      spy = vi.spyOn(fs, 'realpathSync').mockImplementation(() => {
        throw Object.assign(new Error('EPERM: realpath refused'), { code: 'EPERM' })
      })
    })
    afterEach(() => { spy.mockRestore() })

    it('falls back to the normalised path and still recognises the entry', () => {
      expect(isMainModule(modUrl(), join(realDir, 'mod.mjs'))).toBe(true)
      // Unnormalised spelling of the same path.
      expect(isMainModule(modUrl(), join(realDir, '.', 'x', '..', 'mod.mjs'))).toBe(true)
      expect(spy).toHaveBeenCalled()
    })

    it.runIf(process.platform === 'win32')('ignores case on Windows in the fallback too', () => {
      expect(isMainModule(modUrl(), join(realDir, 'mod.mjs').toUpperCase())).toBe(true)
    })

    it('is still false for a different file', () => {
      expect(isMainModule(modUrl(), join(realDir, 'other.mjs'))).toBe(false)
    })
  })

  it('is false when the module URL is not a file: URL', () => {
    expect(isMainModule('http://localhost/mod.mjs', join(realDir, 'mod.mjs'))).toBe(false)
  })
})

/**
 * Run `node <script> ...args` and resolve on the first stdout line matching
 * `ready`, or on exit. The process is killed either way.
 */
function runScript(
  script: string, args: string[], ready?: RegExp,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: tmp })
    let stdout = ''
    let stderr = ''
    const finish = (code: number | null) => {
      clearTimeout(timer)
      child.kill()
      done({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timed out — stdout: ${stdout} stderr: ${stderr}`))
    }, 15_000)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      if (ready?.test(stdout)) finish(null)
    })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('exit', code => finish(code))
    child.on('error', reject)
  })
}

describe('scripts run their main() when launched through a junction', () => {
  it('dev_remote_relay.mjs listens and reports its port', async () => {
    const result = await runScript(
      join(scriptsLink, 'dev_remote_relay.mjs'),
      ['--port', '0', '--token', 'entry-test', '--text-only'],
      /\[dev-relay\] ws:\/\/127\.0\.0\.1:\d+/,
    )
    // Before the fix: exited 0 with empty stdout.
    expect(result.stdout, `stderr: ${result.stderr}`).toMatch(/\[dev-relay\] ws:\/\/127\.0\.0\.1:\d+/)
  })

  it('pack_artifact.mjs reaches its argument check', async () => {
    // No --out: main() fails fast with exit 1, before building anything.
    const result = await runScript(join(scriptsLink, 'pack_artifact.mjs'), [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('pack_artifact: --out <dir> is required')
  })
})
