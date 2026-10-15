import { describe, expect, it } from 'vitest'
import { OverlayFs, type OverlayDisk } from '../browser/runJs/overlayFs'

/**
 * In-memory disk for the overlay's read-through / baseline / enumeration paths.
 * A missing path THROWS an ENOENT-worded error (as BrowserFsOperations does) —
 * the overlay treats only NOT-FOUND-shaped failures as absent; transport-dead
 * and discriminated transient failures (EACCES/EBUSY/…) rethrow.
 */
class FakeDisk implements OverlayDisk {
  files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>()
  dirs = new Set<string>()

  seedFile(path: string, text: string, mtimeMs = 100): this {
    this.files.set(path, { bytes: new TextEncoder().encode(text), mtimeMs })
    // Register ancestor directories so readdir/stat see the tree.
    let p = path
    while (p.includes('/')) {
      p = p.slice(0, p.lastIndexOf('/'))
      if (p) this.dirs.add(p)
    }
    return this
  }
  seedDir(path: string): this {
    this.dirs.add(path)
    return this
  }

  async stat(path: string): Promise<{ size: number; mtimeMs?: number; isDirectory(): boolean }> {
    const f = this.files.get(path)
    if (f) return { size: f.bytes.length, mtimeMs: f.mtimeMs, isDirectory: () => false }
    if (this.dirs.has(path)) return { size: 0, mtimeMs: 0, isDirectory: () => true }
    throw Object.assign(new Error(`ENOENT: ${path}`), { name: 'Error' })
  }
  async readFileBytes(path: string): Promise<Uint8Array> {
    const f = this.files.get(path)
    if (!f) throw new Error(`ENOENT: ${path}`)
    return f.bytes
  }
  async readdir(path: string): Promise<Array<{ name: string; isDirectory(): boolean }>> {
    if (!this.dirs.has(path)) throw new Error(`ENOTDIR: ${path}`)
    const prefix = `${path}/`
    const names = new Map<string, boolean>() // name → isDirectory
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash < 0) names.set(rest, false)
      else names.set(rest.slice(0, slash), true)
    }
    for (const d of this.dirs) {
      if (!d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      const slash = rest.indexOf('/')
      names.set(slash < 0 ? rest : rest.slice(0, slash), true)
    }
    return [...names.entries()].map(([name, isDir]) => ({
      name,
      isDirectory: () => isDir,
    }))
  }
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const enc = (s: string) => new TextEncoder().encode(s)

describe('OverlayFs — read-through of pending writes', () => {
  it('reads back a pending write (bytes + stat), disk untouched', async () => {
    const disk = new FakeDisk().seedFile('/ws/a.txt', 'old')
    const fs = new OverlayFs(disk)
    await fs.recordWrite('/ws/a.txt', enc('new content'))

    expect(dec((await fs.readFileForScript('/ws/a.txt')).bytes)).toBe('new content')
    const st = await fs.statForScript('/ws/a.txt')
    expect(st).toMatchObject({ kind: 'file', size: 'new content'.length })
    // The fake disk still holds the old bytes — nothing was committed.
    expect(dec(disk.files.get('/ws/a.txt')!.bytes)).toBe('old')
  })

  it('a second read reflects the first pending write (read-modify-write chains)', async () => {
    const disk = new FakeDisk().seedFile('/ws/a.txt', 'v0')
    const fs = new OverlayFs(disk)
    const first = dec((await fs.readFileForScript('/ws/a.txt')).bytes)
    await fs.recordWrite('/ws/a.txt', enc(`${first}+v1`))
    // The re-read must see v1, not the stale disk content.
    const second = dec((await fs.readFileForScript('/ws/a.txt')).bytes)
    expect(second).toBe('v0+v1')
  })

  it('a fresh write to a new file is visible before commit', async () => {
    const fs = new OverlayFs(new FakeDisk().seedDir('/ws'))
    await fs.recordWrite('/ws/new.txt', enc('hi'))
    expect(dec((await fs.readFileForScript('/ws/new.txt')).bytes)).toBe('hi')
    const listing = await fs.readdirForScript('/ws')
    expect(listing).toContainEqual({ name: 'new.txt', kind: 'file' })
  })

  it('merges disk + overlay in readdir and drops tombstones', async () => {
    const disk = new FakeDisk().seedFile('/ws/keep.txt', 'k').seedFile('/ws/drop.txt', 'd')
    const fs = new OverlayFs(disk)
    await fs.recordWrite('/ws/added.txt', enc('a'))
    await fs.recordRemove('/ws/drop.txt')
    const names = (await fs.readdirForScript('/ws')).map(e => e.name).sort()
    expect(names).toEqual(['added.txt', 'keep.txt'])
  })
})

describe('OverlayFs — removals and tombstones', () => {
  it('a removed file reads back as NotFound', async () => {
    const disk = new FakeDisk().seedFile('/ws/a.txt', 'x')
    const fs = new OverlayFs(disk)
    await fs.recordRemove('/ws/a.txt')
    await expect(fs.statForScript('/ws/a.txt')).rejects.toMatchObject({ name: 'NotFoundError' })
    await expect(fs.readFileForScript('/ws/a.txt')).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('removing a directory hides its children by ancestor tombstone', async () => {
    const disk = new FakeDisk().seedFile('/ws/d/x.txt', 'x').seedFile('/ws/d/y.txt', 'y')
    const fs = new OverlayFs(disk)
    await fs.recordRemove('/ws/d')
    await expect(fs.statForScript('/ws/d/x.txt')).rejects.toMatchObject({ name: 'NotFoundError' })
    await expect(fs.readdirForScript('/ws/d')).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('removing a nonexistent path throws NotFound, as eager execution does', async () => {
    const fs = new OverlayFs(new FakeDisk().seedDir('/ws'))
    await expect(fs.recordRemove('/ws/ghost.txt')).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('a write UNDER a removed-then-recreated directory is opaque (no stale disk child)', async () => {
    const disk = new FakeDisk().seedFile('/ws/d/old.txt', 'o')
    const fs = new OverlayFs(disk)
    await fs.recordRemove('/ws/d')
    await fs.recordMkdir('/ws/d')
    await fs.recordWrite('/ws/d/new.txt', enc('n'))
    const names = (await fs.readdirForScript('/ws/d')).map(e => e.name)
    // The fresh dir only holds new.txt; the removed old.txt does not reappear.
    expect(names).toEqual(['new.txt'])
    await expect(fs.statForScript('/ws/d/old.txt')).rejects.toMatchObject({ name: 'NotFoundError' })
  })
})

describe('OverlayFs — directories', () => {
  it('mkdir of a NEW path is opaque; mkdir of an existing disk dir stays transparent', async () => {
    const disk = new FakeDisk().seedFile('/ws/exists/a.txt', 'a')
    const fs = new OverlayFs(disk)
    await fs.recordMkdir('/ws/fresh')
    // fresh: opaque, empty
    expect(await fs.readdirForScript('/ws/fresh')).toEqual([])
    // existing: transparent, disk child still listed
    await fs.recordMkdir('/ws/exists')
    expect((await fs.readdirForScript('/ws/exists')).map(e => e.name)).toEqual(['a.txt'])
  })

  it('infers an intermediate directory implied by a deeper pending write', async () => {
    const fs = new OverlayFs(new FakeDisk().seedDir('/ws'))
    await fs.recordWrite('/ws/deep/nested/x.txt', enc('x'))
    expect(await fs.statForScript('/ws/deep')).toMatchObject({ kind: 'directory' })
    expect(await fs.statForScript('/ws/deep/nested')).toMatchObject({ kind: 'directory' })
    expect((await fs.readdirForScript('/ws/deep')).map(e => e.name)).toEqual(['nested'])
  })
})

describe('OverlayFs — moves (read-view)', () => {
  it('a file move exposes source bytes at the destination and empties the source', async () => {
    const disk = new FakeDisk().seedFile('/ws/a.txt', 'payload')
    const fs = new OverlayFs(disk)
    await fs.recordMove('/ws/a.txt', '/ws/b.txt')
    expect(dec((await fs.readFileForScript('/ws/b.txt')).bytes)).toBe('payload')
    await expect(fs.statForScript('/ws/a.txt')).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('a file move carries the pending bytes when the source was written first', async () => {
    const disk = new FakeDisk().seedFile('/ws/a.txt', 'disk')
    const fs = new OverlayFs(disk)
    await fs.recordWrite('/ws/a.txt', enc('edited'))
    await fs.recordMove('/ws/a.txt', '/ws/b.txt')
    expect(dec((await fs.readFileForScript('/ws/b.txt')).bytes)).toBe('edited')
  })

  it('a directory move exposes the whole subtree at the destination', async () => {
    const disk = new FakeDisk()
      .seedFile('/ws/src/x.txt', 'X')
      .seedFile('/ws/src/sub/y.txt', 'Y')
    const fs = new OverlayFs(disk)
    await fs.recordMove('/ws/src', '/ws/dst')
    expect(dec((await fs.readFileForScript('/ws/dst/x.txt')).bytes)).toBe('X')
    expect(dec((await fs.readFileForScript('/ws/dst/sub/y.txt')).bytes)).toBe('Y')
    expect(await fs.statForScript('/ws/dst/sub')).toMatchObject({ kind: 'directory' })
    await expect(fs.statForScript('/ws/src/x.txt')).rejects.toMatchObject({ name: 'NotFoundError' })
  })
})

describe('OverlayFs — commit plan', () => {
  it('reports no changes for a read-only run', async () => {
    const disk = new FakeDisk().seedFile('/ws/a.txt', 'a')
    const fs = new OverlayFs(disk)
    await fs.readFileForScript('/ws/a.txt')
    expect(fs.hasChanges()).toBe(false)
  })

  it('logs mutations verbatim and lists distinct targets with first-touch baselines', async () => {
    const disk = new FakeDisk().seedFile('/ws/a.txt', 'aaaa', 111).seedDir('/ws')
    const fs = new OverlayFs(disk)
    await fs.recordWrite('/ws/a.txt', enc('AA'))
    await fs.recordWrite('/ws/a.txt', enc('BBB')) // same path twice → one target
    await fs.recordWrite('/ws/new.txt', enc('n'))
    await fs.recordMove('/ws/a.txt', '/ws/moved.txt')

    const plan = fs.getCommitPlan()
    expect(plan.ops.map(o => o.op)).toEqual(['writeFile', 'writeFile', 'writeFile', 'move'])
    // Targets: a.txt (baseline the disk file), new.txt (absent), moved.txt (absent).
    const byPath = new Map(plan.targets.map(t => [t.path, t.baseline]))
    expect([...byPath.keys()].sort()).toEqual(['/ws/a.txt', '/ws/moved.txt', '/ws/new.txt'])
    expect(byPath.get('/ws/a.txt')).toMatchObject({ kind: 'file', size: 4, mtimeMs: 111 })
    expect(byPath.get('/ws/new.txt')).toBeNull()
    expect(byPath.get('/ws/moved.txt')).toBeNull()
  })

  it("a read-miss seeds a mutated path's baseline at the pre-read state", async () => {
    const disk = new FakeDisk().seedFile('/ws/a.txt', 'seed', 222)
    const fs = new OverlayFs(disk)
    await fs.readFileForScript('/ws/a.txt') // seeds baseline
    await fs.recordWrite('/ws/a.txt', enc('changed'))
    const baseline = fs.getCommitPlan().targets.find(t => t.path === '/ws/a.txt')!.baseline
    expect(baseline).toMatchObject({ kind: 'file', size: 4, mtimeMs: 222 })
  })
})
