import { describe, expect, it } from 'vitest'
import {
  NotebookPatchTool,
  cellIndexFromId,
} from '../toolkit/builtin/notebookEdit'

describe('cellIndexFromId', () => {
  it.each([
    ['cell-0', 0],
    ['cell-3', 3],
    ['cell-007', 7],
    ['cell-12', 12],
  ])('%s -> %d', (input, expected) => {
    expect(cellIndexFromId(input)).toBe(expected)
  })

  it.each([
    'cell-',
    'cell-x',
    'cell--1',
    'cell-1a',
    ' cell-1',
    'cell-1 ',
    'Cell-1',
    'abc',
    '',
  ])('%j -> undefined', input => {
    expect(cellIndexFromId(input)).toBeUndefined()
  })
})

const PATH = '/work/nb.ipynb'

function notebookText(ids: string[]): string {
  return JSON.stringify({
    cells: ids.map(id => ({ cell_type: 'code', id, source: '', metadata: {} })),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })
}

function makeContext(opts: { text?: string; statError?: unknown }) {
  const fs = {
    async stat() {
      if (opts.statError !== undefined) throw opts.statError
      return { isFile: () => true, mtimeMs: 1000 }
    },
    async readFile() {
      return opts.text ?? ''
    },
  }
  return {
    options: { cwd: '/work', fsOperations: fs },
    fileReadLedger: new Map([[PATH, { timestamp: 5000 }]]),
  } as never
}

async function check(cellId: string, opts: { text?: string; statError?: unknown }) {
  return NotebookPatchTool.checkInput!(
    { notebook_path: PATH, cell_id: cellId, new_source: 'x' },
    makeContext(opts),
  )
}

describe('NotebookEdit validateInput cell lookup', () => {
  const text = notebookText(['a', 'b'])

  it('accepts a positional id in range', async () => {
    expect((await check('cell-1', { text })).result).toBe(true)
  })

  it('rejects a positional id out of range', async () => {
    const r = (await check('cell-5', { text })) as { message?: string }
    expect(r.message).toBe('Cell with index 5 does not exist in notebook.')
  })

  it('rejects an unknown id', async () => {
    const r = (await check('zzz', { text })) as { message?: string }
    expect(r.message).toBe('No cell has the id "zzz".')
  })

  it('prefers a real id over the positional form', async () => {
    const r = await check('cell-0', { text: notebookText(['x', 'cell-0']) })
    expect(r.result).toBe(true)
  })
})

describe('NotebookEdit validateInput missing file', () => {
  it('reports a code ENOENT as missing', async () => {
    const r = (await check('a', { statError: { code: 'ENOENT' } })) as {
      message?: string
    }
    expect(r.message).toBe('No notebook exists at that path.')
  })

  it('reports an ENOENT message as missing', async () => {
    const r = (await check('a', {
      statError: new Error('ENOENT: no such file'),
    })) as { message?: string }
    expect(r.message).toBe('No notebook exists at that path.')
  })

  it('rethrows other errors', async () => {
    await expect(check('a', { statError: new Error('EACCES') })).rejects.toThrow(
      'EACCES',
    )
  })

  it('does not treat ENOENT inside a longer word as missing', async () => {
    await expect(
      check('a', { statError: new Error('XENOENTX') }),
    ).rejects.toThrow('XENOENTX')
  })
})
