import { afterEach, describe, expect, it } from 'vitest'
import {
  fsForContext,
  installProcessFs,
  processFs,
  resetProcessFs,
  unconfiguredFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'

const fake = (tag: string): RuntimeFs =>
  ({ ...unconfiguredFs, cwd: () => tag }) as RuntimeFs

afterEach(() => resetProcessFs())

describe('process fs slot', () => {
  it('returns the unconfigured fs before anything is installed, with stable identity', () => {
    expect(processFs()).toBe(unconfiguredFs)
    expect(processFs()).toBe(processFs())
  })

  it('last writer wins and reset restores the default (idempotent)', () => {
    const a = fake('a')
    const b = fake('b')
    installProcessFs(a)
    expect(processFs()).toBe(a)
    installProcessFs(b)
    expect(processFs()).toBe(b)
    resetProcessFs()
    expect(processFs()).toBe(unconfiguredFs)
    resetProcessFs()
    expect(processFs()).toBe(unconfiguredFs)
  })
})

describe('fsForContext', () => {
  it('prefers the context fs, even over an installed one', () => {
    const own = fake('own')
    installProcessFs(fake('slot'))
    expect(fsForContext({ options: { fsOperations: own } })).toBe(own)
  })

  it('falls back to the slot at call time when the context has none', () => {
    const ctx = { options: {} as { fsOperations?: RuntimeFs | null } }
    expect(fsForContext(ctx)).toBe(unconfiguredFs)
    const slot = fake('slot')
    installProcessFs(slot)
    expect(fsForContext(ctx)).toBe(slot)
    expect(fsForContext({ options: { fsOperations: undefined } })).toBe(slot)
    expect(fsForContext({ options: { fsOperations: null } })).toBe(slot)
  })
})

describe('unconfiguredFs', () => {
  it('reports cwd "." and nothing existing', () => {
    expect(unconfiguredFs.cwd()).toBe('.')
    expect(unconfiguredFs.existsSync('/anything')).toBe(false)
  })

  it('stat variants give size 0, no times, and throwing predicates', async () => {
    for (const st of [
      await unconfiguredFs.stat('/x'),
      unconfiguredFs.statSync('/x'),
      unconfiguredFs.lstatSync('/x'),
    ]) {
      expect(st.size).toBe(0)
      expect(st.mtimeMs).toBeUndefined()
      expect(st.ctimeMs).toBeUndefined()
      expect(st.birthtimeMs).toBeUndefined()
      expect(() => st.isFile()).toThrow(/"stat\.isFile"/)
      expect(() => st.isDirectory()).toThrow(/"stat\.isDirectory"/)
      expect(() => st.isBlockDevice()).toThrow(/"stat\.isBlockDevice"/)
    }
  })

  it('sync methods throw naming the method and the bootstrap remedy', () => {
    expect(() => unconfiguredFs.readFileSync('/x', { encoding: 'utf8' })).toThrow(
      /"readFileSync".*not configured.*browser-backed adapter.*bootstrap/,
    )
    expect(() => unconfiguredFs.readdirSync('/x')).toThrow(/"readdirSync"/)
    expect(() => unconfiguredFs.mkdirSync('/x')).toThrow(/"mkdirSync"/)
  })

  it('async methods return rejected promises instead of throwing', async () => {
    let p: Promise<unknown> | undefined
    expect(() => {
      p = unconfiguredFs.readFile('/x', { encoding: 'utf8' })
    }).not.toThrow()
    await expect(p).rejects.toThrow(/"readFile".*not configured/)
    await expect(unconfiguredFs.readdir('/x')).rejects.toThrow(/"readdir"/)
    await expect(unconfiguredFs.writeFile('/x', 'y')).rejects.toThrow(/"writeFile"/)
    await expect(
      unconfiguredFs.readRange!('/x', { offset: 0, length: 1 }),
    ).rejects.toThrow(/"readRange"/)
  })

  it('implements readRange but not rename or realpath', () => {
    expect(typeof unconfiguredFs.readRange).toBe('function')
    expect('rename' in unconfiguredFs).toBe(false)
    expect('realpath' in unconfiguredFs).toBe(false)
  })
})
