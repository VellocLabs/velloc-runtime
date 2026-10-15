import { describe, expect, it, vi } from 'vitest'
import {
  assertUntrustedReadAllowed,
  checkWithinRoot,
} from '../permissions/untrustedReadBoundary'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

/**
 * The read boundary for a child session on an untrusted provider.
 *
 * Every assertion here is about one property: what this session can read is
 * what leaks to the third-party relay on its next request. The absence case
 * matters just as much — an ordinary session must be untouched.
 */

const ROOT = '/repo/.velloc/worktrees/team-worker-a'
const STORAGE = '/home/u/.velloc/projects'

function ctx(opts: Partial<{ untrustedReadRoot: string; cwd: string }> = {}) {
  return {
    options: {
      cwd: opts.cwd ?? ROOT,
      sessionStoragePath: STORAGE,
      ...(opts.untrustedReadRoot !== undefined
        ? { untrustedReadRoot: opts.untrustedReadRoot }
        : {}),
    },
  }
}

/** An fs whose `realpath` resolves the given links. */
function fsWithLinks(links: Record<string, string>): RuntimeFs {
  return {
    realpath: vi.fn(async (p: string) => links[p] ?? p),
  } as unknown as RuntimeFs
}

describe('checkWithinRoot', () => {
  it('accepts the root itself and anything under it', () => {
    expect(checkWithinRoot(ROOT, ROOT).ok).toBe(true)
    expect(checkWithinRoot(`${ROOT}/src/app.ts`, ROOT).ok).toBe(true)
  })

  it('rejects a sibling whose path merely shares a prefix', () => {
    // `…/team-worker-a-evil` starts with the root string but is not inside it.
    expect(checkWithinRoot(`${ROOT}-evil/secrets`, ROOT).ok).toBe(false)
  })

  it('rejects a path outside the root', () => {
    expect(checkWithinRoot('/etc/passwd', ROOT).ok).toBe(false)
    expect(checkWithinRoot('/repo/other', ROOT).ok).toBe(false)
  })

  it('rejects the session-storage tree even when it is inside the root', () => {
    const verdict = checkWithinRoot(`${STORAGE}/other-session/transcript.jsonl`, '/home/u', [
      STORAGE,
    ])
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('session storage')
  })
})

describe('assertUntrustedReadAllowed', () => {
  it('is a NO-OP without a boundary — every ordinary session is unaffected', async () => {
    const verdict = await assertUntrustedReadAllowed(
      '/etc/passwd',
      ctx(),
      fsWithLinks({}),
    )
    expect(verdict.ok).toBe(true)
  })

  it('allows a relative path that resolves inside the root', async () => {
    const verdict = await assertUntrustedReadAllowed(
      'src/app.ts',
      ctx({ untrustedReadRoot: ROOT }),
      fsWithLinks({}),
    )
    expect(verdict.ok).toBe(true)
  })

  it('rejects a relative path that climbs out', async () => {
    const verdict = await assertUntrustedReadAllowed(
      '../../../etc/passwd',
      ctx({ untrustedReadRoot: ROOT }),
      fsWithLinks({}),
    )
    expect(verdict.ok).toBe(false)
  })

  it('rejects an absolute path outside the root', async () => {
    const verdict = await assertUntrustedReadAllowed(
      '/home/u/.ssh/id_rsa',
      ctx({ untrustedReadRoot: ROOT }),
      fsWithLinks({}),
    )
    expect(verdict.ok).toBe(false)
  })

  it('rejects a SYMLINK inside the root that points outside it', async () => {
    // The escape the literal check alone would miss.
    const verdict = await assertUntrustedReadAllowed(
      `${ROOT}/link-to-home`,
      ctx({ untrustedReadRoot: ROOT }),
      fsWithLinks({ [`${ROOT}/link-to-home`]: '/home/u/.ssh/id_rsa' }),
    )
    expect(verdict.ok).toBe(false)
  })

  it('asks the host to resolve LINKS, not just normalize (the Windows junction escape)', async () => {
    // On Windows the default `fs.realpath` only normalizes: a junction under
    // the root came back under the root and the read went through. Model the
    // host faithfully — links are resolved only when asked.
    const WIN_ROOT = 'C:\\repo\\worker-a'
    const junction = `${WIN_ROOT}\\vendor`
    const realpath = vi.fn(async (p: string, options?: { resolveLinks?: boolean }) =>
      options?.resolveLinks && p.startsWith(junction)
        ? `C:\\Users\\u\\.ssh${p.slice(junction.length)}`
        : p,
    )
    const fs = { realpath } as unknown as RuntimeFs
    const verdict = await assertUntrustedReadAllowed(
      `${junction}\\id_rsa`,
      { options: { cwd: WIN_ROOT, untrustedReadRoot: WIN_ROOT } },
      fs,
    )
    expect(verdict.ok).toBe(false)
    expect(realpath).toHaveBeenCalledWith(`${junction}\\id_rsa`, { resolveLinks: true })
  })

  it('allows files under a root that is ITSELF reached through a link', async () => {
    // A project opened via a junction: every file resolves to the real tree,
    // which is not under the literal root. Refusing all of it would break the
    // session; the resolved root is the same directory.
    const LINKED_ROOT = '/links/worker-a'
    const REAL_ROOT = '/data/real/worker-a'
    const fs = {
      realpath: vi.fn(async (p: string) =>
        p.startsWith(LINKED_ROOT) ? `${REAL_ROOT}${p.slice(LINKED_ROOT.length)}` : p,
      ),
    } as unknown as RuntimeFs
    const context = { options: { cwd: LINKED_ROOT, untrustedReadRoot: LINKED_ROOT } }
    expect((await assertUntrustedReadAllowed('src/app.ts', context, fs)).ok).toBe(true)
    // …but a link inside it that leaves the real tree is still an escape.
    const escaping = {
      realpath: vi.fn(async (p: string) => {
        if (p === `${LINKED_ROOT}/out`) return '/etc'
        return p.startsWith(LINKED_ROOT) ? `${REAL_ROOT}${p.slice(LINKED_ROOT.length)}` : p
      }),
    } as unknown as RuntimeFs
    expect((await assertUntrustedReadAllowed('out', context, escaping)).ok).toBe(false)
  })

  it('resolves the root and the storage tree ONCE per session, not once per path', async () => {
    // Each realpath is a host round trip. The root and the storage tree are
    // constants for the session's life, and a SuperEdit run over hundreds of
    // files paid two or three of them per file for the same answer.
    const LINKED_ROOT = '/links/worker-a'
    const REAL_ROOT = '/data/real/worker-a'
    const REAL_STORAGE = '/mnt/profile/.velloc/projects'
    const realpath = vi.fn(async (p: string) => {
      if (p === STORAGE) return REAL_STORAGE
      return p.startsWith(LINKED_ROOT) ? `${REAL_ROOT}${p.slice(LINKED_ROOT.length)}` : p
    })
    const fs = { realpath } as unknown as RuntimeFs
    const context = {
      options: { cwd: LINKED_ROOT, untrustedReadRoot: LINKED_ROOT, sessionStoragePath: STORAGE },
    }
    for (let i = 0; i < 5; i += 1) {
      expect((await assertUntrustedReadAllowed(`src/file-${i}.ts`, context, fs)).ok).toBe(true)
    }
    const calls = realpath.mock.calls.map(c => c[0] as string)
    expect(calls.filter(p => p === LINKED_ROOT)).toHaveLength(1)
    expect(calls.filter(p => p === STORAGE)).toHaveLength(1)
    // The checked paths themselves are still resolved every time.
    expect(calls.filter(p => p.startsWith(`${LINKED_ROOT}/src/`))).toHaveLength(5)
  })

  it('rejects a link into the session-storage tree even when storage is reached through a link', async () => {
    const HOME = '/home/u'
    const REAL_STORAGE = '/mnt/profile/.velloc/projects'
    const fs = {
      realpath: vi.fn(async (p: string) => {
        if (p === STORAGE) return REAL_STORAGE
        if (p === `${HOME}/notes/lead`) return `${REAL_STORAGE}/lead-1`
        return p
      }),
    } as unknown as RuntimeFs
    const verdict = await assertUntrustedReadAllowed(
      `${HOME}/notes/lead`,
      { options: { cwd: HOME, untrustedReadRoot: '/', sessionStoragePath: STORAGE } },
      fs,
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('session storage')
  })

  it('rejects the session-storage tree', async () => {
    // Sibling sessions' transcripts are where the user's unrelated work is.
    const verdict = await assertUntrustedReadAllowed(
      `${STORAGE}/lead-1/transcript.jsonl`,
      { options: { cwd: ROOT, untrustedReadRoot: '/home/u', sessionStoragePath: STORAGE } },
      fsWithLinks({}),
    )
    expect(verdict.ok).toBe(false)
  })

  it('still checks the literal path when realpath fails (a file yet to exist)', async () => {
    const fs = {
      realpath: vi.fn(async () => {
        throw new Error('ENOENT')
      }),
    } as unknown as RuntimeFs
    expect(
      (await assertUntrustedReadAllowed(`${ROOT}/new.ts`, ctx({ untrustedReadRoot: ROOT }), fs)).ok,
    ).toBe(true)
    expect(
      (await assertUntrustedReadAllowed('/etc/new.ts', ctx({ untrustedReadRoot: ROOT }), fs)).ok,
    ).toBe(false)
  })

  it('works with no fs at all (no realpath available)', async () => {
    expect(
      (await assertUntrustedReadAllowed('src/a.ts', ctx({ untrustedReadRoot: ROOT }), undefined)).ok,
    ).toBe(true)
    expect(
      (await assertUntrustedReadAllowed('/etc/passwd', ctx({ untrustedReadRoot: ROOT }), undefined))
        .ok,
    ).toBe(false)
  })
})
