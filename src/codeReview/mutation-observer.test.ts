import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureWorkspaceMutation, observeWorkspaceMutation, registerWorkspaceMutationObserver, withSuppressedWorkspaceMutations } from './mutation-observer'
import { buildHostTools } from '../toolkit/builtin/host/hostTools'
import { commitOverlay } from '../toolkit/builtin/superEdit'
import { OverlayFs } from '../browser/runJs/overlayFs'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.useRealTimers() })
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
function fixture(runtimeConfig = {}) {
  const files = new Map([['/proj/a', 'old'], ['/proj/b', 'b'], ['/proj/c', 'c']])
  const fs = {
    stat: vi.fn(async (path: string) => { if (!files.has(path)) throw new Error('ENOENT'); return { size: new TextEncoder().encode(files.get(path)).length, mtimeMs: 1, isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false } }),
    readFileBytes: async (path: string) => { if (!files.has(path)) throw new Error('ENOENT'); return new TextEncoder().encode(files.get(path)) }, readdir: async () => [],
    writeFile: vi.fn(async (path: string, bytes: Uint8Array) => { if (path.endsWith('fail')) throw new Error('disk-full'); files.set(path, new TextDecoder().decode(bytes)) }),
    mkdir: async () => {}, unlink: async (path: string) => { files.delete(path) },
    rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from) },
  } as unknown as RuntimeFs
  const ctx = { options: { cwd: '/proj', tools: [], runtimeConfig, fsOperations: fs }, platformCapabilities: {}, cancelSource: new AbortController(),
    toolRunSeams: { nested: { preHooks: async () => ({ blocked: false }) } } } as unknown as ToolCallContext
  const emit = async (value: string) => { const before = await captureWorkspaceMutation(ctx, ['/proj/a']); files.set('/proj/a', value); await observeWorkspaceMutation(ctx, 'write', before); await flush() }
  return { ctx, fs, files, emit }
}

describe('workspace mutation receipts', () => {
  it('binds before/after bytes, suppresses no-op writes, and isolates runtime keys', async () => {
    const { ctx, files, emit } = fixture()
    const observer = vi.fn()
    cleanup.push(registerWorkspaceMutationObserver(ctx.options, observer))
    await emit('old')
    expect(observer).not.toHaveBeenCalled()
    await emit('new')
    const event = observer.mock.calls[0][0]
    expect(event.changes[0]).toMatchObject({ path: '/proj/a', before: { kind: 'file', content: 'old' }, after: { kind: 'file', content: 'new' } })
    expect(event.changes[0].before.digest).not.toBe(event.changes[0].after.digest)
    files.set('/proj/a', 'later')
    expect(event.changes[0].after.content).toBe('new')
    const unrelated = fixture()
    await unrelated.emit('other')
    expect(observer).toHaveBeenCalledTimes(1)
  })

  it('suppresses exact repair contexts, supports nesting, and releases suppression on throw', async () => {
    const { ctx, emit } = fixture()
    const observer = vi.fn()
    cleanup.push(registerWorkspaceMutationObserver(ctx.options, observer))
    await expect(withSuppressedWorkspaceMutations(ctx, async () => {
      await withSuppressedWorkspaceMutations(ctx, async () => emit('repair'))
      await emit('repair-two')
      throw new Error('repair-failed')
    })).rejects.toThrow('repair-failed')
    expect(observer).not.toHaveBeenCalled()
    await emit('ordinary')
    expect(observer).toHaveBeenCalledTimes(1)
  })

  it('does not await model work and resumes serial observation after a timed-out handler settles', async () => {
    vi.useFakeTimers()
    const { ctx, emit } = fixture()
    let release!: () => void
    let firstSignal!: AbortSignal
    const observer = vi.fn((_event, _context, signal: AbortSignal) => {
      if (observer.mock.calls.length === 1) { firstSignal = signal; return new Promise<void>(resolve => { release = resolve }) }
    })
    cleanup.push(registerWorkspaceMutationObserver(ctx.options, observer))
    await emit('two')
    await emit('three')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(firstSignal.aborted).toBe(true)
    expect(observer).toHaveBeenCalledTimes(1)
    release()
    await flush()
    expect(observer).toHaveBeenCalledTimes(2)
    await emit('four')
    expect(observer).toHaveBeenCalledTimes(3)
  })

  it.each(['Edit', 'Write'])('emits %s only for changed native structured success', async name => {
    const { ctx, files } = fixture()
    const callTool = vi.fn()
    ctx.platformCapabilities = { browser: { callTool } } as never
    const observer = vi.fn()
    cleanup.push(registerWorkspaceMutationObserver(ctx.options, observer))
    const [tool] = buildHostTools([{ name, description: 'test', parameters: { type: 'object' } } as never])
    const args = { file_path: '/proj/a', content: 'new', old_string: 'old', new_string: 'new' }
    for (const response of ['updated successfully', { message: 'success' }, { outcome: 'denied', path: '/proj/a' }, { outcome: 'updated', path: '/proj/a', error: 'failed' }, { outcome: 'updated', path: '/proj/a' }]) {
      callTool.mockResolvedValueOnce(response)
      await tool.call(args, ctx, vi.fn(), {} as never)
    }
    callTool.mockRejectedValueOnce(new Error('denied'))
    await expect(tool.call(args, ctx, vi.fn(), {} as never)).rejects.toThrow('denied')
    expect(observer).not.toHaveBeenCalled()
    callTool.mockImplementationOnce(async () => { files.set('/proj/a', 'new'); return { outcome: 'updated', path: '/proj/a', original_file: 'not-trusted' } })
    await tool.call(args, ctx, vi.fn(), {} as never)
    await flush()
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer.mock.calls[0][0].changes[0]).toMatchObject({ before: { content: 'old' }, after: { content: 'new' } })
  })

  it('emits completed SuperEdit file operations before a partial failure', async () => {
    const { ctx, fs } = fixture()
    const observer = vi.fn()
    cleanup.push(registerWorkspaceMutationObserver(ctx.options, observer))
    const overlay = new OverlayFs(fs)
    await overlay.recordWrite('/proj/a', new TextEncoder().encode('new'))
    await overlay.recordMove('/proj/b', '/proj/moved')
    await overlay.recordRemove('/proj/c')
    await overlay.recordWrite('/proj/fail', new Uint8Array([1]))
    expect((await commitOverlay(overlay, ctx, {} as never)).status).toBe('partial')
    await flush()
    expect(observer.mock.calls.map(call => [call[0].operation, call[0].paths])).toEqual([
      ['write', ['/proj/a']], ['move', ['/proj/b', '/proj/moved']], ['unlink', ['/proj/c']],
    ])
    expect(observer.mock.calls[1][0].changes).toMatchObject([{ before: { kind: 'file' }, after: { kind: 'missing' } }, { before: { kind: 'missing' }, after: { content: 'b' } }])
  })

  it('fails closed for uncertain evidence and preserves successful tool output', async () => {
    const { ctx, fs, files } = fixture()
    const observer = vi.fn(async () => { throw new Error('observer-failed') })
    cleanup.push(registerWorkspaceMutationObserver(ctx.options, observer))
    files.set('/proj/large', 'a'.repeat(128 * 1024 + 1))
    expect(await captureWorkspaceMutation(ctx, ['/proj/large'])).toBeUndefined()
    const before = await captureWorkspaceMutation(ctx, ['/proj/a'])
    vi.mocked(fs.stat).mockRejectedValue(new Error('EACCES'))
    await expect(observeWorkspaceMutation(ctx, 'write', before)).resolves.toBeUndefined()
    expect(observer).not.toHaveBeenCalled()
  })

  it('suppresses unchanged SuperEdit writes and contains observer errors after successful commits', async () => {
    const { ctx, fs } = fixture()
    const observer = vi.fn(async () => { throw new Error('observer-failed') })
    cleanup.push(registerWorkspaceMutationObserver(ctx.options, observer))
    const unchanged = new OverlayFs(fs)
    await unchanged.recordWrite('/proj/a', new TextEncoder().encode('old'))
    expect((await commitOverlay(unchanged, ctx, {} as never)).status).toBe('ok')
    expect(observer).not.toHaveBeenCalled()
    const changed = new OverlayFs(fs)
    await changed.recordWrite('/proj/a', new TextEncoder().encode('new'))
    expect((await commitOverlay(changed, ctx, {} as never)).status).toBe('ok')
    await flush()
    expect(observer).toHaveBeenCalledTimes(1)
  })

  it('caps queued observations while a handler ignores cancellation', async () => {
    const { ctx, emit } = fixture()
    let release!: () => void
    const observer = vi.fn(() => observer.mock.calls.length === 1 ? new Promise<void>(resolve => { release = resolve }) : undefined)
    cleanup.push(registerWorkspaceMutationObserver(ctx.options, observer))
    await emit('first')
    for (let i = 0; i < 50; i++) await emit(String(i))
    expect(observer).toHaveBeenCalledTimes(1)
    release()
    await flush()
    await flush()
    await flush()
    expect(observer).toHaveBeenCalledTimes(33)
  })

  it('does not emit SuperEdit receipts when hooks deny commit', async () => {
    const { ctx, fs } = fixture()
    ctx.toolRunSeams = { nested: { preHooks: async () => ({ blocked: true, message: 'denied' }) } } as never
    const observer = vi.fn()
    cleanup.push(registerWorkspaceMutationObserver(ctx.options, observer))
    const overlay = new OverlayFs(fs)
    await overlay.recordWrite('/proj/a', new Uint8Array([2]))
    expect((await commitOverlay(overlay, ctx, {} as never)).status).toBe('denied')
    await flush()
    expect(observer).not.toHaveBeenCalled()
    expect(fs.writeFile).not.toHaveBeenCalled()
  })
})
