import { beforeEach, describe, expect, it } from 'vitest'

import { makeFetch, makeMemFs } from './_helpers/memFs'
import {
  fetchSkillFiles,
  getSkillsDirectory,
  installSkill,
  listInstalledSkills,
  sanitizeRelPath,
  sanitizeSkillDirName,
  uninstallSkill,
  type SkillInstallInput,
} from '../skillLibrary/skillInstall'
import { reconcileInstallError } from '../browser/webview/settings/sections/skillsInstallReconcile'
import {
  handleSkillsBridgeRequest,
  resetSkillsRescanSignatureForTests,
} from '../browser/bridge/adapter/skillsBridgeAdapter'

const HOME = '/home/user'

function makeSkill(over: Partial<SkillInstallInput> = {}): SkillInstallInput {
  return {
    id: 'anthropic/pdf',
    name: 'pdf',
    publisher: 'anthropic',
    repo: 'anthropics/skills',
    branch: 'main',
    path: 'skills/pdf',
    files: ['SKILL.md', 'scripts/run.py'],
    ...over,
  }
}

describe('skills install pipeline', () => {
  it('downloads every file + writes a provenance sidecar', async () => {
    const fs = makeMemFs()
    const fetchImpl = makeFetch({
      'SKILL.md': '---\nname: pdf\n---\nbody',
      'scripts/run.py': 'print(1)',
    })

    const { entry, fileCount } = await installSkill(makeSkill(), {
      homeDir: HOME,
      fs,
      fetchImpl,
      now: () => '2026-01-01T00:00:00.000Z',
    })

    expect(fileCount).toBe(2)
    expect(entry.id).toBe('anthropic/pdf')
    expect(entry.dir).toBe('pdf')

    const dir = getSkillsDirectory(HOME) + '/pdf'
    const written = fs.dump()
    expect(written).toContain(dir + '/SKILL.md')
    expect(written).toContain(dir + '/scripts/run.py')
    // Provenance sidecar records the catalog id for listInstalled/uninstall.
    const prov = JSON.parse(await fs.readFile(dir + '/.velloc-skill.json', { encoding: 'utf-8' }))
    expect(prov).toMatchObject({ id: 'anthropic/pdf', name: 'pdf', branch: 'main' })
  })

  it('round-trips install → listInstalled → uninstall by catalog id', async () => {
    const fs = makeMemFs()
    const fetchImpl = makeFetch({ 'SKILL.md': '---\nname: pdf\n---\n' })

    await installSkill(makeSkill({ files: ['SKILL.md'] }), {
      homeDir: HOME,
      fs,
      fetchImpl,
    })

    const installed = await listInstalledSkills(HOME, fs)
    expect(installed.map((s) => s.id)).toEqual(['anthropic/pdf'])

    expect(await uninstallSkill('anthropic/pdf', HOME, fs)).toBe(true)
    expect(await listInstalledSkills(HOME, fs)).toEqual([])
    // Idempotent: uninstalling again is a no-op false.
    expect(await uninstallSkill('anthropic/pdf', HOME, fs)).toBe(false)
  })

  it('lists a manually-placed skill pack with the description the settings row needs', async () => {
    const fs = makeMemFs()
    const skillsRoot = getSkillsDirectory(HOME)
    // A hand-dropped pack: top-level SKILL.md (block-scalar description, as
    // real packs write it), nested sub-skills, NO provenance sidecar.
    await fs.writeFile(
      skillsRoot + '/xiaohongshu-skills/SKILL.md',
      '---\nname: xiaohongshu-skills\ndescription: |\n  Automation pack.\n  Publish and search.\n---\n\n# Body\n',
    )
    await fs.writeFile(skillsRoot + '/xiaohongshu-skills/skills/xhs-auth/SKILL.md', 'sub')
    // No frontmatter at all → the first body line, heading marker stripped.
    await fs.writeFile(skillsRoot + '/plain/SKILL.md', '# Plain skill\n\nmore')
    // Not a skill (no SKILL.md, no sidecar) → never listed.
    await fs.writeFile(skillsRoot + '/notes/readme.txt', 'x')

    const listed = await listInstalledSkills(HOME, fs)
    // readdir order is the fs's; the UI sorts, so the test does too.
    expect([...listed].sort((a, b) => a.dir.localeCompare(b.dir))).toEqual([
      {
        id: 'local/plain',
        name: 'plain',
        dir: 'plain',
        description: 'Plain skill',
      },
      {
        id: 'local/xiaohongshu-skills',
        name: 'xiaohongshu-skills',
        dir: 'xiaohongshu-skills',
        description: 'Automation pack. Publish and search.',
      },
    ])
  })

  it('skips path-traversal entries instead of escaping the skill dir', async () => {
    const fs = makeMemFs()
    const fetchImpl = makeFetch({
      'SKILL.md': 'ok',
      '../evil.sh': 'pwn', // must never be fetched/written
    })

    await installSkill(makeSkill({ files: ['SKILL.md', '../evil.sh'] }), {
      homeDir: HOME,
      fs,
      fetchImpl,
    })

    const written = fs.dump()
    expect(written.some((p) => p.includes('evil'))).toBe(false)
    expect(
      written.every((p) => p.startsWith(getSkillsDirectory(HOME) + '/pdf')),
    ).toBe(true)
  })

  it('clean-replaces a prior install (no stale files linger)', async () => {
    const fs = makeMemFs()
    // First install has an extra file.
    await installSkill(makeSkill({ files: ['SKILL.md', 'old.md'] }), {
      homeDir: HOME,
      fs,
      fetchImpl: makeFetch({ 'SKILL.md': 'v1', 'old.md': 'stale' }),
    })
    // Reinstall without old.md — it must be gone.
    await installSkill(makeSkill({ files: ['SKILL.md'] }), {
      homeDir: HOME,
      fs,
      fetchImpl: makeFetch({ 'SKILL.md': 'v2' }),
    })

    const written = fs.dump()
    expect(written.some((p) => p.endsWith('/old.md'))).toBe(false)
    expect(written).toContain(getSkillsDirectory(HOME) + '/pdf/SKILL.md')
  })

  it('sanitizes dir names + relative paths', () => {
    expect(sanitizeSkillDirName('weird name/../x')).toBe('x')
    expect(sanitizeSkillDirName('  ../../etc ')).toBe('etc')
    expect(sanitizeRelPath('a/b/c.md')).toBe('a/b/c.md')
    expect(sanitizeRelPath('../escape')).toBeNull()
    expect(sanitizeRelPath('/abs')).toBe('abs')
    expect(sanitizeRelPath('a/../b')).toBeNull()
  })

  // --- regressions for the four reported install bugs ---------------------

  it('Bug 1: a failed download does NOT destroy the existing install', async () => {
    const fs = makeMemFs()
    const skillsRoot = getSkillsDirectory(HOME)
    const dir = skillsRoot + '/pdf'

    // A clean v1 install.
    await installSkill(makeSkill({ files: ['SKILL.md', 'a.md'] }), {
      homeDir: HOME,
      fs,
      fetchImpl: makeFetch({ 'SKILL.md': 'v1', 'a.md': 'A' }),
    })
    expect(await fs.readFile(dir + '/SKILL.md', { encoding: 'utf-8' })).toBe('v1')

    // Reinstall where a file 404s — must reject WITHOUT touching the install.
    await expect(
      installSkill(makeSkill({ files: ['SKILL.md', 'missing.md'] }), {
        homeDir: HOME,
        fs,
        fetchImpl: makeFetch({ 'SKILL.md': 'v2' }), // missing.md → 404
      }),
    ).rejects.toThrow(/Failed to download/)

    // The v1 install survives intact (not deleted, not half-overwritten).
    expect(await fs.readFile(dir + '/SKILL.md', { encoding: 'utf-8' })).toBe('v1')
    expect(await fs.readFile(dir + '/a.md', { encoding: 'utf-8' })).toBe('A')
  })

  it('Bug 1b: SKILL.md is written last, so a mid-write failure leaves no half-skill', async () => {
    const fs = makeMemFs()
    // Fail the write of a resource file; SKILL.md must then never be written.
    const realWrite = fs.writeFile.bind(fs)
    fs.writeFile = (async (path: string, data: string | Uint8Array, opts?: { encoding?: string }) => {
      if (String(path).endsWith('/break.md')) throw new Error('disk full')
      return realWrite(path, data, opts)
    }) as typeof fs.writeFile

    await expect(
      installSkill(makeSkill({ files: ['SKILL.md', 'break.md'] }), {
        homeDir: HOME,
        fs,
        fetchImpl: makeFetch({ 'SKILL.md': 'body', 'break.md': 'x' }),
      }),
    ).rejects.toThrow()

    const dir = getSkillsDirectory(HOME) + '/pdf'
    // No SKILL.md ⇒ the loader skips the dir (not a loadable half-skill).
    await expect(fs.readFile(dir + '/SKILL.md', { encoding: 'utf-8' })).rejects.toThrow()
  })

  it('Bug 2: a skill over the file cap throws instead of silently truncating + "succeeding"', async () => {
    const fs = makeMemFs()
    const many = Array.from({ length: 1001 }, (_, i) => `f${i}.txt`)
    const contents: Record<string, string> = { 'SKILL.md': 'x' }
    for (const f of many) contents[f] = 'x'

    await expect(
      installSkill(makeSkill({ files: ['SKILL.md', ...many] }), {
        homeDir: HOME,
        fs,
        fetchImpl: makeFetch(contents),
      }),
    ).rejects.toThrow(/exceeding the install limit/)

    // It threw BEFORE writing anything — no partial skill on disk.
    expect(fs.dump()).toEqual([])
  })

  it('Bug 3: anthropic/pdf and openai/pdf coexist (no bare-name clobber)', async () => {
    const fs = makeMemFs()
    const skillsRoot = getSkillsDirectory(HOME)

    await installSkill(
      makeSkill({ id: 'anthropic/pdf', publisher: 'anthropic', files: ['SKILL.md'] }),
      { homeDir: HOME, fs, fetchImpl: makeFetch({ 'SKILL.md': 'anthropic pdf' }) },
    )
    await installSkill(
      makeSkill({ id: 'openai/pdf', publisher: 'openai', files: ['SKILL.md'] }),
      { homeDir: HOME, fs, fetchImpl: makeFetch({ 'SKILL.md': 'openai pdf' }) },
    )

    // Two distinct dirs — neither clobbered the other.
    expect(await fs.readFile(skillsRoot + '/pdf/SKILL.md', { encoding: 'utf-8' })).toBe('anthropic pdf')
    expect(await fs.readFile(skillsRoot + '/openai-pdf/SKILL.md', { encoding: 'utf-8' })).toBe('openai pdf')
    expect((await listInstalledSkills(HOME, fs)).map((s) => s.id).sort()).toEqual([
      'anthropic/pdf',
      'openai/pdf',
    ])

    // Uninstalling one leaves the other.
    await uninstallSkill('anthropic/pdf', HOME, fs)
    expect((await listInstalledSkills(HOME, fs)).map((s) => s.id)).toEqual(['openai/pdf'])
  })

  it('Bug 4a: downloads files concurrently so a large skill finishes under the bridge timeout', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const N = 20
    const many = Array.from({ length: N }, (_, i) => `f${i}.txt`)
    // Records peak concurrency: each call bumps the in-flight count and yields a
    // microtask before resolving, so siblings start first.
    const concurrentFetch: typeof fetch = (async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight--
      return new Response(new TextEncoder().encode('x'), { status: 200 })
    }) as typeof fetch

    const got = await fetchSkillFiles(
      makeSkill({ files: ['SKILL.md', ...many] }),
      concurrentFetch,
    )
    // Every file fetched (no truncation/loss) AND they overlapped (parallel),
    // not one sequential round-trip each (which blew the timeout for 300+ files).
    expect(got.length).toBe(N + 1)
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it('Bug 4b: an install error reconciles to SUCCESS when the worker landed it despite a timeout', () => {
    // Request errored (e.g. timed out) but a fresh listInstalled shows it landed.
    expect(
      reconcileInstallError('pdf', 'timed out', new Set(['anthropic/pdf']), 'anthropic/pdf'),
    ).toEqual({ ok: true, toast: 'Installed pdf' })

    // Genuinely not installed → reported as failure.
    expect(
      reconcileInstallError('pdf', 'HTTP 404', new Set(), 'anthropic/pdf'),
    ).toEqual({ ok: false, toast: 'Install failed: HTTP 404' })

    // Couldn't even re-list (null) → failure.
    expect(reconcileInstallError('pdf', 'network down', null, 'anthropic/pdf').ok).toBe(false)
  })

  // --- regressions for the three install-pipeline hardening bugs -----------

  it('data loss: collision fallback does NOT clobber an unrelated manually-placed skill', async () => {
    const fs = makeMemFs()
    const skillsRoot = getSkillsDirectory(HOME)

    // The user hand-authored a skill sitting in the namespaced-collision slot
    // (SKILL.md, NO provenance sidecar — i.e. not catalog-owned).
    await fs.writeFile(skillsRoot + '/openai-pdf/SKILL.md', 'hand authored')

    // anthropic/pdf takes the natural `pdf` dir.
    await installSkill(
      makeSkill({ id: 'anthropic/pdf', publisher: 'anthropic', files: ['SKILL.md'] }),
      { homeDir: HOME, fs, fetchImpl: makeFetch({ 'SKILL.md': 'anthropic pdf' }) },
    )

    // openai/pdf collides on `pdf` → falls back to `openai-pdf`, which the user
    // already owns. It must pick a non-colliding dir, NOT overwrite the user's.
    await installSkill(
      makeSkill({ id: 'openai/pdf', publisher: 'openai', files: ['SKILL.md'] }),
      { homeDir: HOME, fs, fetchImpl: makeFetch({ 'SKILL.md': 'openai pdf' }) },
    )

    // The hand-authored skill survives untouched.
    expect(
      await fs.readFile(skillsRoot + '/openai-pdf/SKILL.md', { encoding: 'utf-8' }),
    ).toBe('hand authored')
    // openai/pdf landed somewhere else and is intact.
    const openai = (await listInstalledSkills(HOME, fs)).find((s) => s.id === 'openai/pdf')
    expect(openai).toBeTruthy()
    expect(openai!.dir).not.toBe('openai-pdf')
    expect(
      await fs.readFile(skillsRoot + '/' + openai!.dir + '/SKILL.md', { encoding: 'utf-8' }),
    ).toBe('openai pdf')
  })

  it('orphan: reinstalling onto a freed natural dir removes the stale namespaced dir', async () => {
    const fs = makeMemFs()
    const skillsRoot = getSkillsDirectory(HOME)

    await installSkill(
      makeSkill({ id: 'anthropic/pdf', publisher: 'anthropic', files: ['SKILL.md'] }),
      { homeDir: HOME, fs, fetchImpl: makeFetch({ 'SKILL.md': 'a' }) },
    )
    // openai/pdf is parked in the namespaced dir because of the collision.
    await installSkill(
      makeSkill({ id: 'openai/pdf', publisher: 'openai', files: ['SKILL.md'] }),
      { homeDir: HOME, fs, fetchImpl: makeFetch({ 'SKILL.md': 'o1' }) },
    )
    expect(
      await fs.readFile(skillsRoot + '/openai-pdf/SKILL.md', { encoding: 'utf-8' }),
    ).toBe('o1')

    // Free the natural `pdf` dir, then reinstall openai/pdf — it resolves back
    // to `pdf` and MUST clean up the now-stale `openai-pdf` orphan.
    await uninstallSkill('anthropic/pdf', HOME, fs)
    await installSkill(
      makeSkill({ id: 'openai/pdf', publisher: 'openai', files: ['SKILL.md'] }),
      { homeDir: HOME, fs, fetchImpl: makeFetch({ 'SKILL.md': 'o2' }) },
    )

    // Exactly one dir owns openai/pdf (the natural one); the orphan is gone.
    expect(fs.dump().some((p) => p.startsWith(skillsRoot + '/openai-pdf/'))).toBe(false)
    expect(await fs.readFile(skillsRoot + '/pdf/SKILL.md', { encoding: 'utf-8' })).toBe('o2')
    expect((await listInstalledSkills(HOME, fs)).map((s) => s.id)).toEqual(['openai/pdf'])
    // Uninstall removes it fully, leaving nothing behind.
    expect(await uninstallSkill('openai/pdf', HOME, fs)).toBe(true)
    expect(await listInstalledSkills(HOME, fs)).toEqual([])
  })

  it('unloadable: install refuses a catalog entry with no exact-case SKILL.md', async () => {
    const fs = makeMemFs()

    // Casing mismatch — no exact `SKILL.md`, so the loader would never load it.
    await expect(
      installSkill(makeSkill({ files: ['skill.md', 'scripts/run.py'] }), {
        homeDir: HOME,
        fs,
        fetchImpl: makeFetch({ 'skill.md': 'body', 'scripts/run.py': 'x' }),
      }),
    ).rejects.toThrow(/no SKILL\.md/)

    // Nothing landed — crucially NO provenance sidecar — so listInstalled
    // doesn't report a phantom, loader-invisible skill.
    expect(fs.dump()).toEqual([])
    expect(await listInstalledSkills(HOME, fs)).toEqual([])
  })
})

describe('skills bridge adapter — reload fan-out on install/uninstall', () => {
  // Regression: installing/uninstalling a marketplace skill must fan out a
  // reload so the on-disk skill set is re-read across open sessions. Without it a freshly installed
  // skill stays invisible until a new session is created.
  beforeEach(() => resetSkillsRescanSignatureForTests())

  function makeRequest(
    action: 'install' | 'uninstall' | 'listInstalled' | 'rescan',
    payload: unknown,
  ) {
    // The adapter only reads `route.action` + `payload`; a minimal route is
    // enough (cast through `unknown` since we omit the unused route fields).
    return {
      id: 'req-1',
      route: { namespace: 'skills', capability: 'skills', action },
      payload,
    } as unknown as Parameters<typeof handleSkillsBridgeRequest>[0]
  }

  it('install fans out exactly one reload', async () => {
    const fs = makeMemFs()
    const fetchImpl = makeFetch({ 'SKILL.md': '---\nname: pdf\n---\nbody' })
    let reloads = 0
    const res = await handleSkillsBridgeRequest(
      makeRequest('install', { skill: makeSkill({ files: ['SKILL.md'] }) }),
      { homeDir: HOME, fs, fetchImpl, reloadSkills: () => { reloads += 1 } },
    )
    expect(res.ok).toBe(true)
    expect(reloads).toBe(1)
  })

  it('uninstall reloads only when a skill was actually removed', async () => {
    const fs = makeMemFs()
    const fetchImpl = makeFetch({ 'SKILL.md': '---\nname: pdf\n---\n' })
    await installSkill(makeSkill({ files: ['SKILL.md'] }), { homeDir: HOME, fs, fetchImpl })

    let reloads = 0
    const ctx = { homeDir: HOME, fs, reloadSkills: () => { reloads += 1 } }

    const removed = await handleSkillsBridgeRequest(
      makeRequest('uninstall', { id: 'anthropic/pdf' }),
      ctx,
    )
    expect(removed.ok).toBe(true)
    expect(reloads).toBe(1)

    // No-op uninstall (nothing removed) must NOT fan out a reload.
    const again = await handleSkillsBridgeRequest(
      makeRequest('uninstall', { id: 'anthropic/pdf' }),
      ctx,
    )
    expect(again.ok).toBe(true)
    expect(reloads).toBe(1)
  })

  it('listInstalled is a read: it never fans a reload out, whatever changed on disk', async () => {
    // The listing is served at `observe` on the runtime protocol. It used to
    // rescan-and-reload on a change (and always on the first listing of a
    // worker's life) — a manager-level fan-out any observer could trigger by
    // opening the Skills page. The reloads live on the mutations only.
    const fs = makeMemFs()
    const skillsRoot = getSkillsDirectory(HOME)
    let reloads = 0
    const ctx = { homeDir: HOME, fs, reloadSkills: () => { reloads += 1 } }
    const list = () => handleSkillsBridgeRequest(makeRequest('listInstalled', {}), ctx)

    await list()
    expect(reloads).toBe(0)
    // A folder the user dropped in by hand shows in the listing — and still
    // reloads nothing: it reaches open sessions on their next reload.
    await fs.writeFile(skillsRoot + '/mine/SKILL.md', '---\ndescription: Mine.\n---\n')
    const res = await list()
    expect(res.ok).toBe(true)
    expect(res.ok && (res.result as { skills: Array<{ id: string }> }).skills.map((s) => s.id)).toEqual(['local/mine'])
    expect(reloads).toBe(0)
    await fs.rm(skillsRoot + '/mine', { recursive: true, force: true })
    await list()
    expect(reloads).toBe(0)
  })

  it('the listInstalled that follows an install adds no reload to the install’s one', async () => {
    const fs = makeMemFs()
    const fetchImpl = makeFetch({ 'SKILL.md': '---\nname: pdf\n---\nbody' })
    let reloads = 0
    const ctx = { homeDir: HOME, fs, fetchImpl, reloadSkills: () => { reloads += 1 } }
    await handleSkillsBridgeRequest(
      makeRequest('install', { skill: makeSkill({ files: ['SKILL.md'] }) }),
      ctx,
    )
    // The settings hook refreshes right after an install.
    await handleSkillsBridgeRequest(makeRequest('listInstalled', {}), ctx)
    expect(reloads).toBe(1)
  })

  it('rescan reloads once when the on-disk set changed, and not while it stays the same', async () => {
    // The settings Skills page sends it after listing (at `control`): it is
    // what makes a folder dropped in by hand load into the open sessions.
    const fs = makeMemFs()
    const skillsRoot = getSkillsDirectory(HOME)
    let reloads = 0
    const ctx = { homeDir: HOME, fs, reloadSkills: () => { reloads += 1 } }
    const rescan = async () => {
      const res = await handleSkillsBridgeRequest(makeRequest('rescan', {}), ctx)
      expect(res.ok).toBe(true)
      return res.ok && (res.result as { reloaded: boolean }).reloaded
    }

    // First rescan of the worker's life always reloads — a session may have
    // booted before the folder was dropped.
    expect(await rescan()).toBe(true)
    expect(reloads).toBe(1)
    // Re-opening the page with nothing changed on disk is free.
    expect(await rescan()).toBe(false)
    expect(reloads).toBe(1)

    // The user drops a folder in by hand — no install ran, nothing fanned out.
    await fs.writeFile(skillsRoot + '/mine/SKILL.md', '---\ndescription: Mine.\n---\n')
    expect(await rescan()).toBe(true)
    expect(reloads).toBe(2)
    expect(await rescan()).toBe(false)
    expect(reloads).toBe(2)

    // An edited description is a change too (the model listing shows it).
    await fs.writeFile(skillsRoot + '/mine/SKILL.md', '---\ndescription: Mine, edited.\n---\n')
    expect(await rescan()).toBe(true)
    expect(reloads).toBe(3)

    // Removing it by hand is a change too.
    await fs.rm(skillsRoot + '/mine', { recursive: true, force: true })
    expect(await rescan()).toBe(true)
    expect(reloads).toBe(4)
  })

  it('the rescan that follows an install adds no reload to the install’s one', async () => {
    const fs = makeMemFs()
    const fetchImpl = makeFetch({ 'SKILL.md': '---\nname: pdf\n---\nbody' })
    let reloads = 0
    const ctx = { homeDir: HOME, fs, fetchImpl, reloadSkills: () => { reloads += 1 } }
    await handleSkillsBridgeRequest(
      makeRequest('install', { skill: makeSkill({ files: ['SKILL.md'] }) }),
      ctx,
    )
    // The settings hook lists and rescans right after an install.
    await handleSkillsBridgeRequest(makeRequest('listInstalled', {}), ctx)
    const res = await handleSkillsBridgeRequest(makeRequest('rescan', {}), ctx)
    expect(res.ok && (res.result as { reloaded: boolean }).reloaded).toBe(false)
    expect(reloads).toBe(1)
  })
})
