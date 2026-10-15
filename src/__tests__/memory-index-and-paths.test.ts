import { describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { buildMemorySystemPrompt, clampMemoryIndex } from '../memory/memoryPrompt'
import { defaultMemoryDir, getMemoryDir, joinPath } from '../memory/memoryPaths'

function rc(env: Record<string, string> = {}): RuntimeConfig {
  return {
    getEnv: (name: string) => env[name],
    flagOn: (name: string) => ['1', 'true', 'yes'].includes(env[name] ?? ''),
    now: () => 0,
    createUUID: () => 'id',
    createTimestamp: () => '2026-01-01T00:00:00.000Z',
    getMaxStructuredOutputRetries: () => 5,
  }
}

describe('clampMemoryIndex', () => {
  it('returns short text trimmed and unflagged', () => {
    expect(clampMemoryIndex('  - a\n- b \n')).toEqual({
      content: '- a\n- b',
      lineCount: 2,
      byteCount: 7,
      cutByLines: false,
      cutBySize: false,
    })
  })

  it('keeps the first 200 lines and names the line limit', () => {
    const raw = Array.from({ length: 250 }, (_, i) => `l${i}`).join('\n')
    const out = clampMemoryIndex(raw)
    expect(out.cutByLines).toBe(true)
    expect(out.cutBySize).toBe(false)
    expect(out.content.split('\n\n> WARNING')[0]!.split('\n')).toHaveLength(200)
    expect(out.content).toMatch(
      /\n\n> WARNING: MEMORY\.md exceeded 250 lines \(limit: 200\)\. Only part of it was loaded into memory context\.$/,
    )
  })

  it('cuts an oversized index at the last newline before the byte limit', () => {
    const line = 'x'.repeat(999)
    const raw = Array.from({ length: 30 }, () => line).join('\n') // 29_999 chars
    const out = clampMemoryIndex(raw)
    const kept = out.content.split('\n\n> WARNING')[0]!
    expect(kept.length).toBeLessThanOrEqual(25_000)
    expect(kept.endsWith(line)).toBe(true)
    expect(out.content).toContain('exceeded 29999 bytes (limit: 25000).')
  })

  it('hard-cuts at the byte limit when there is no newline to cut at', () => {
    const out = clampMemoryIndex('y'.repeat(30_000))
    expect(out.content.split('\n\n> WARNING')[0]).toHaveLength(25_000)
  })

  it('names both counts when both limits are exceeded', () => {
    const raw = Array.from({ length: 300 }, () => 'z'.repeat(200)).join('\n')
    const out = clampMemoryIndex(raw)
    expect(out.content).toContain(`exceeded 300 lines and ${raw.length} bytes.`)
  })
})

describe('buildMemorySystemPrompt options', () => {
  const quietFs = { mkdir: async () => {} } as unknown as RuntimeFs

  it('appends the extra guidelines env var as a final line, ignoring blanks', async () => {
    const withExtra = await buildMemorySystemPrompt({
      cwd: '/p',
      fs: quietFs,
      runtimeConfig: rc({ VELLOC_MEMORY_PROMPT_ADDENDUM: '  Keep it short.  ' }),
    })
    expect(withExtra!.endsWith('\nKeep it short.')).toBe(true)
    const blank = await buildMemorySystemPrompt({
      cwd: '/p',
      fs: quietFs,
      runtimeConfig: rc({ VELLOC_MEMORY_PROMPT_ADDENDUM: '   ' }),
    })
    // One line break after the last bullet, the same as with no addendum.
    expect(blank!.endsWith('on your own initiative.\n')).toBe(true)
  })

  it('uses the display name as the heading', async () => {
    const prompt = await buildMemorySystemPrompt({
      cwd: '/p',
      fs: quietFs,
      runtimeConfig: rc(),
      displayName: 'project notes',
    })
    expect(prompt!.startsWith('# project notes\n')).toBe(true)
  })

  it('still returns the prompt when the directory cannot be created', async () => {
    const failing = {
      mkdir: async () => {
        throw new Error('EPERM')
      },
    } as unknown as RuntimeFs
    const prompt = await buildMemorySystemPrompt({ cwd: '/p', fs: failing, runtimeConfig: rc() })
    expect(prompt).toContain('Your memory is a folder of notes at `/p/')
  })
})

describe('joinPath', () => {
  it('follows the base separator style', () => {
    expect(joinPath('C:\\a', 'b', 'c')).toBe('C:\\a\\b\\c')
    expect(joinPath('/a/', '/b/', 'c')).toBe('/a/b/c')
    expect(joinPath('C:/a\\mixed', 'b')).toBe('C:/a\\mixed/b')
  })

  it('skips empty parts and starts from the first part when the base is empty', () => {
    expect(joinPath('/a', '', '/', 'b')).toBe('/a/b')
    expect(joinPath('', 'rel', 'x')).toBe('rel/x')
  })
})

describe('memory directory edge cases', () => {
  const remote = { VELLOC_MEMORY_ROOT: '/rr' }

  it('drops a drive letter from the remote slug', () => {
    expect(getMemoryDir('D:\\work\\repo', rc(remote))).toBe('/rr/projects/work-repo/memory/')
  })

  it('falls back to "workspace" when nothing usable is left of the slug', () => {
    expect(getMemoryDir('/', rc(remote))).toBe('/rr/projects/workspace/memory/')
  })

  it('falls back to the default when the settings directory is invalid', () => {
    const config = rc()
    expect(
      getMemoryDir('/p', config, { memorySettings: { autoMemoryDirectory: 'relative' } }),
    ).toBe('/p/.velloc/memory/')
  })

  it('defaultMemoryDir agrees with the default branch of getMemoryDir', () => {
    const where = { cwd: '/home/u/x', projectRoot: '/work/repo', homeDir: '/home/u' }
    expect(defaultMemoryDir(where)).toBe(getMemoryDir(where.cwd, rc(), where))
    expect(defaultMemoryDir({ cwd: '/c', projectRoot: '/work/repo' })).toBe('/work/repo/memory/')
  })
})
