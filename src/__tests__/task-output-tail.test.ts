import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { TaskControlSurface } from '../browser/worker/TaskControlSurface'
import {
  TASK_OUTPUT_VIEW_BYTES,
  readTaskOutputTail,
} from '../browser/worker/taskOutputTail'

/** An fs holding one file, with a ranged read unless `ranged` is false. */
function fileFs(path: string, bytes: Uint8Array, ranged = true) {
  const readFile = vi.fn(async (p: string) => {
    if (p !== path) throw new Error('ENOENT')
    return new TextDecoder().decode(bytes)
  })
  const readRange = vi.fn(async (p: string, o: { offset: number; length: number }) => {
    if (p !== path) throw new Error('ENOENT')
    const buffer = bytes.slice(o.offset, o.offset + o.length)
    return { buffer, bytesRead: buffer.length }
  })
  const stat = vi.fn(async (p: string) => {
    if (p !== path) throw new Error('ENOENT')
    return { size: bytes.length }
  })
  const fs = { readFile, stat, ...(ranged ? { readRange } : {}) } as unknown as RuntimeFs
  return { fs, readFile, readRange }
}

const enc = (s: string) => new TextEncoder().encode(s)
const LOG = 'C:/proj/.velloc/tasks/b-1.output'

describe('readTaskOutputTail', () => {
  it('returns a small file whole, not cut', async () => {
    const { fs } = fileFs(LOG, enc('line 1\nBUILD OK\n'))
    expect(await readTaskOutputTail(fs, LOG)).toEqual({
      text: 'line 1\nBUILD OK\n',
      size: 16,
      truncated: false,
    })
  })

  it('reads only the last maxBytes of a large file and reports its full size', async () => {
    const big = 'x'.repeat(TASK_OUTPUT_VIEW_BYTES * 4) + 'BUILD OK'
    const { fs, readRange, readFile } = fileFs(LOG, enc(big))
    const tail = await readTaskOutputTail(fs, LOG)
    expect(tail.truncated).toBe(true)
    expect(tail.size).toBe(big.length)
    expect(tail.text.length).toBe(TASK_OUTPUT_VIEW_BYTES)
    expect(tail.text.endsWith('BUILD OK')).toBe(true)
    expect(readFile).not.toHaveBeenCalled()
    expect(readRange).toHaveBeenCalledWith(LOG, {
      offset: big.length - TASK_OUTPUT_VIEW_BYTES,
      length: TASK_OUTPUT_VIEW_BYTES,
    })
  })

  it('drops a multi-byte character split by the cut', async () => {
    // 'é' is two bytes; a 5-byte tail of 'aéééé' starts inside one.
    const { fs } = fileFs(LOG, enc('aéééé'))
    const tail = await readTaskOutputTail(fs, LOG, 5)
    expect(tail).toEqual({ text: 'éé', size: 9, truncated: true })
  })

  it('keeps the tail when the fs has no ranged read', async () => {
    const { fs } = fileFs(LOG, enc('0123456789'), false)
    expect(await readTaskOutputTail(fs, LOG, 4)).toEqual({
      text: '6789',
      size: 10,
      truncated: true,
    })
  })
})

describe('TaskControlSurface.loadInfoWithOutput', () => {
  function surfaceWith(fs: RuntimeFs) {
    const liveShell = {
      command: 'npm run build',
      output: 'live tail',
      outputFilePath: LOG,
      params: undefined,
    }
    const registry = {
      resolveNative: (id: string) => id,
      getLiveByType: (id: string, type: string) =>
        id === 'b-1' && type === 'local_bash' ? liveShell : undefined,
      getFinishedByType: () => undefined,
    }
    const none = {} as never
    return new TaskControlSurface(
      registry as never,
      none,
      none,
      none,
      { get: () => undefined } as never,
      none,
      {
        getFs: () => fs,
        getStorage: () => null,
        dropSessionRouting: () => {},
        scheduleSummary: () => {},
      },
    )
  }

  it('sends the window only the output tail, marked cut with the full size', async () => {
    const big = 'y'.repeat(5 * 1024 * 1024) + 'DONE'
    const { fs } = fileFs(LOG, enc(big))
    const info = await surfaceWith(fs).loadInfoWithOutput('b-1')
    expect(info?.outputText?.length).toBe(TASK_OUTPUT_VIEW_BYTES)
    expect(info?.outputText?.endsWith('DONE')).toBe(true)
    expect(info?.outputTruncated).toBe(true)
    expect(info?.outputBytes).toBe(big.length)
  })

  it('sends a small output whole, with no cut marker', async () => {
    const { fs } = fileFs(LOG, enc('ok\n'))
    const info = await surfaceWith(fs).loadInfoWithOutput('b-1')
    expect(info?.outputText).toBe('ok\n')
    expect(info?.outputTruncated).toBeUndefined()
    expect(info?.outputBytes).toBeUndefined()
  })

  it('keeps the info without output when the file cannot be read', async () => {
    const { fs } = fileFs('C:/elsewhere', enc('x'))
    const info = await surfaceWith(fs).loadInfoWithOutput('b-1')
    expect(info?.task).toBe('npm run build')
    expect(info?.outputText).toBeUndefined()
  })
})
