import { describe, expect, it } from 'vitest'
import {
  createGetDirectory,
  createWorkspaceFacade,
} from '../browser/runJs/workspaceFacade'
import type { RunJsFsOp } from '../browser/runJs/runJsProtocol'

type Call = { op: RunJsFsOp; payload: Record<string, unknown> }

/** Stub broker: records calls, delegates results to `impl`. Same seam the
 *  real facade gets (a `callFs` closure over the data pipe). */
function stubFs(
  impl: (op: RunJsFsOp, payload: Record<string, unknown>) => unknown,
): { calls: Call[]; callFs: (op: RunJsFsOp, payload: Record<string, unknown>) => Promise<unknown> } {
  const calls: Call[] = []
  return {
    calls,
    callFs: async (op, payload) => {
      calls.push({ op, payload })
      return impl(op, payload)
    },
  }
}

function notFound(): never {
  const err = new Error('no such entry')
  err.name = 'NotFoundError'
  throw err
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const text = (b: unknown) => new TextDecoder().decode(b as Uint8Array)

describe('workspaceFacade — names and handles', () => {
  it('rejects spec-invalid child names with TypeError', async () => {
    const { callFs } = stubFs(() => null)
    const root = createWorkspaceFacade('proj', callFs)
    // Note: 'a/b' is a VALID multi-segment name (superset), and 'a\b' is its
    // separator-alias spelling; see the multi-segment tests. These are the
    // still-invalid forms — including '..' escapes spelled with backslashes.
    for (const bad of ['', '.', '..', 'a\\..\\b', 'a/../b', '../x', '..\\x']) {
      await expect(root.getFileHandle(bad)).rejects.toThrow(TypeError)
      await expect(root.getDirectoryHandle(bad)).rejects.toThrow(TypeError)
      await expect(root.removeEntry(bad)).rejects.toThrow(TypeError)
    }
  })

  it("accepts '\\' as a separator alias and normalizes the relative path to '/'", async () => {
    // The model pastes Windows paths verbatim; rejecting them sent it into a
    // per-segment getDirectoryHandle walk. A real Windows filename can never
    // contain '\', so the alias changes no previously-working case.
    const { calls, callFs } = stubFs(() => ({ kind: 'file', size: 1 }))
    const root = createWorkspaceFacade('proj', callFs)
    await root.getFileHandle('src\\browser\\runJs\\RunJsBroker.ts')
    expect(calls[0]!.payload.path).toBe('src/browser/runJs/RunJsBroker.ts')
  })

  it('getFileHandle: file → handle; directory → TypeMismatchError; missing → NotFoundError', async () => {
    const { callFs } = stubFs((op, payload) => {
      if (op !== 'stat') throw new Error('unexpected op')
      if (payload.path === 'a.txt') return { kind: 'file', size: 1 }
      if (payload.path === 'src') return { kind: 'directory', size: 0 }
      return notFound()
    })
    const root = createWorkspaceFacade('proj', callFs)
    const file = await root.getFileHandle('a.txt')
    expect(file.kind).toBe('file')
    expect(file.name).toBe('a.txt')
    await expect(root.getFileHandle('src')).rejects.toMatchObject({
      name: 'TypeMismatchError',
    })
    await expect(root.getFileHandle('missing.txt')).rejects.toMatchObject({
      name: 'NotFoundError',
    })
  })

  it('create options synthesize the entry (empty write / mkdir)', async () => {
    const { calls, callFs } = stubFs(op => (op === 'stat' ? notFound() : null))
    const root = createWorkspaceFacade('proj', callFs)
    await root.getFileHandle('new.txt', { create: true })
    expect(calls).toContainEqual({
      op: 'writeFile',
      payload: { path: 'new.txt', bytes: new Uint8Array(0) },
    })
    await root.getDirectoryHandle('newdir', { create: true })
    expect(calls).toContainEqual({ op: 'mkdir', payload: { path: 'newdir' } })
  })

  it('nested handles build workspace-relative paths from validated names', async () => {
    const { calls, callFs } = stubFs(() => ({ kind: 'directory', size: 0 }))
    const root = createWorkspaceFacade('proj', callFs)
    const src = await root.getDirectoryHandle('src')
    await src.getDirectoryHandle('browser')
    expect(calls.map(c => c.payload.path)).toEqual(['src', 'src/browser'])
  })

  it('accepts multi-segment names (deliberate superset) but still rejects .. escapes', async () => {
    const { calls, callFs } = stubFs(() => ({ kind: 'file', size: 1 }))
    const root = createWorkspaceFacade('proj', callFs)
    await root.getFileHandle('src/browser/runJs/RunJsBroker.ts')
    expect(calls[0]!.payload.path).toBe('src/browser/runJs/RunJsBroker.ts')
    for (const bad of ['../x', 'a/../b', 'a//b', 'a/./b']) {
      await expect(root.getFileHandle(bad)).rejects.toThrow(TypeError)
    }
  })
})

describe('getDirectory — arbitrary absolute directory anchor', () => {
  it('stats the path, returns a handle, and stamps root on every op', async () => {
    const { calls, callFs } = stubFs((op, payload) => {
      if (op === 'stat') {
        // '' is the anchor dir; 'a.txt' is a file underneath it.
        return payload.path === ''
          ? { kind: 'directory', size: 0 }
          : { kind: 'file', size: 1 }
      }
      if (op === 'readFile') return { bytes: new TextEncoder().encode('x') }
      return null
    })
    const getDirectory = createGetDirectory(callFs)
    const dir = await getDirectory('/abs/other/place')
    expect(dir.kind).toBe('directory')
    expect(dir.name).toBe('place')
    // The validating stat carried the anchor root and the '' path.
    expect(calls[0]).toEqual({
      op: 'stat',
      payload: { path: '', root: '/abs/other/place' },
    })
    const f = await dir.getFileHandle('a.txt')
    await f.getFile()
    // Child ops all carry the same anchor root; paths stay relative to it.
    for (const c of calls.slice(1)) {
      expect(c.payload.root).toBe('/abs/other/place')
    }
  })

  it('rejects a non-directory target with TypeMismatchError', async () => {
    const getDirectory = createGetDirectory(stubFs(() => ({ kind: 'file', size: 1 })).callFs)
    await expect(getDirectory('/abs/a.txt')).rejects.toMatchObject({
      name: 'TypeMismatchError',
    })
  })

  it('rejects a non-string path with TypeError', async () => {
    const getDirectory = createGetDirectory(stubFs(() => null).callFs)
    await expect(
      getDirectory('' as unknown as string),
    ).rejects.toThrow(TypeError)
  })
})

describe('workspaceFacade — file IO', () => {
  it('getFile returns a real File (name, content, lastModified)', async () => {
    const { callFs } = stubFs(op =>
      op === 'stat'
        ? { kind: 'file', size: 2 }
        : { bytes: utf8('hi'), mtimeMs: 1234 },
    )
    const root = createWorkspaceFacade('proj', callFs)
    const handle = await root.getFileHandle('a.txt')
    const file = await handle.getFile()
    expect(file.name).toBe('a.txt')
    expect(await file.text()).toBe('hi')
    expect(file.lastModified).toBe(1234)
  })

  it('createWritable buffers and commits ONE writeFile on close()', async () => {
    const { calls, callFs } = stubFs(op =>
      op === 'stat' ? { kind: 'file', size: 0 } : null,
    )
    const root = createWorkspaceFacade('proj', callFs)
    const handle = await root.getFileHandle('a.txt')
    const writable = await handle.createWritable()
    await writable.write('hello ')
    await writable.write('world')
    const writesBeforeClose = calls.filter(c => c.op === 'writeFile')
    expect(writesBeforeClose).toHaveLength(0)
    await writable.close()
    const writes = calls.filter(c => c.op === 'writeFile')
    expect(writes).toHaveLength(1)
    expect(text(writes[0]!.payload.bytes)).toBe('hello world')
    await expect(writable.write('x')).rejects.toMatchObject({
      name: 'InvalidStateError',
    })
  })

  it('supports the spec command forms: keepExistingData, positioned write, truncate', async () => {
    const { calls, callFs } = stubFs(op => {
      if (op === 'stat') return { kind: 'file', size: 11 }
      if (op === 'readFile') return { bytes: utf8('hello world') }
      return null
    })
    const root = createWorkspaceFacade('proj', callFs)
    const handle = await root.getFileHandle('a.txt')
    const writable = await handle.createWritable({ keepExistingData: true })
    await writable.write({ type: 'write', position: 6, data: 'there' })
    await writable.write({ type: 'truncate', size: 11 })
    await writable.close()
    const writes = calls.filter(c => c.op === 'writeFile')
    expect(text(writes[0]!.payload.bytes)).toBe('hello there')
  })

  it('createSyncAccessHandle / move fail the way the real API fails off-OPFS', async () => {
    const { callFs } = stubFs(() => ({ kind: 'file', size: 0 }))
    const root = createWorkspaceFacade('proj', callFs)
    const handle = await root.getFileHandle('a.txt')
    await expect(handle.createSyncAccessHandle()).rejects.toMatchObject({
      name: 'InvalidStateError',
    })
    await expect(handle.move()).rejects.toMatchObject({
      name: 'NotSupportedError',
    })
  })

  it('propagates broker DOMException names (NotAllowedError) untouched', async () => {
    const { callFs } = stubFs(op => {
      if (op === 'stat') return { kind: 'file', size: 0 }
      const err = new Error('denied by rule')
      err.name = 'NotAllowedError'
      throw err
    })
    const root = createWorkspaceFacade('proj', callFs)
    const handle = await root.getFileHandle('a.txt')
    await expect(handle.getFile()).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
  })
})

describe('workspaceFacade — directories', () => {
  it('removeEntry: file removes; non-empty dir needs recursive (InvalidModificationError)', async () => {
    const { calls, callFs } = stubFs((op, payload) => {
      if (op === 'stat') {
        return payload.path === 'a.txt'
          ? { kind: 'file', size: 1 }
          : { kind: 'directory', size: 0 }
      }
      if (op === 'readdir') return [{ name: 'x', kind: 'file' }]
      return null
    })
    const root = createWorkspaceFacade('proj', callFs)
    await root.removeEntry('a.txt')
    expect(calls).toContainEqual({ op: 'remove', payload: { path: 'a.txt' } })
    await expect(root.removeEntry('dir')).rejects.toMatchObject({
      name: 'InvalidModificationError',
    })
    await root.removeEntry('dir', { recursive: true })
    expect(calls).toContainEqual({ op: 'remove', payload: { path: 'dir' } })
  })

  it('async-iterates entries with kinds (for await over the handle)', async () => {
    const { callFs } = stubFs(op =>
      op === 'readdir'
        ? [
            { name: 'src', kind: 'directory' },
            { name: 'a.txt', kind: 'file' },
          ]
        : null,
    )
    const root = createWorkspaceFacade('proj', callFs)
    const seen: Array<[string, string]> = []
    for await (const [name, handle] of root) {
      seen.push([name, handle.kind])
    }
    expect(seen).toEqual([
      ['src', 'directory'],
      ['a.txt', 'file'],
    ])
    const names: string[] = []
    for await (const name of root.keys()) names.push(name)
    expect(names).toEqual(['src', 'a.txt'])
  })

  it('isSameEntry and resolve work on facade identity', async () => {
    const { callFs } = stubFs(() => ({ kind: 'directory', size: 0 }))
    const root = createWorkspaceFacade('proj', callFs)
    const a = await root.getDirectoryHandle('src')
    const b = await root.getDirectoryHandle('src')
    expect(await a.isSameEntry(b)).toBe(true)
    const nested = await a.getDirectoryHandle('browser')
    expect(await root.resolve(nested)).toEqual(['src', 'browser'])
    expect(await a.resolve(nested)).toEqual(['browser'])
  })
})

describe('workspaceFacade — no invented surface', () => {
  it('exposes no non-standard convenience methods', () => {
    const { callFs } = stubFs(() => null)
    const root = createWorkspaceFacade('proj', callFs) as unknown as Record<string, unknown>
    // The one-line tool doc only holds if the surface IS the standard one.
    // readTextFile/writeTextFile exist as separate INJECTED functions
    // (fileHelpers.ts) — never as handle methods.
    for (const invented of [
      'readText',
      'writeText',
      'readTextFile',
      'writeTextFile',
      'glob',
      'grep',
      'readFile',
    ]) {
      expect(root[invented], invented).toBeUndefined()
    }
  })
})
