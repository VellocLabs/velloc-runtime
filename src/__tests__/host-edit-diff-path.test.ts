/**
 * The Edit / Write diff names the file by the host's resolved path, so one file
 * spelled with either separator by the model lists under one platform spelling.
 */
import { describe, expect, it } from 'vitest'
import { buildHostEditDiff } from '../toolkit/builtin/host/editDiff'
import { renderHostResult } from '../toolkit/builtin/host/resultText'

describe('buildHostEditDiff path', () => {
  it('uses the host-reported path over the model-typed file_path', () => {
    const data = renderHostResult('Edit', { outcome: 'updated', path: 'D:\repo\a.ts', original_file: 'x\n' })
    const built = buildHostEditDiff('Edit', { file_path: 'D:/repo/a.ts', old_string: 'x', new_string: 'y' }, data)
    expect(built?.editDiff.filePath).toBe('D:\repo\a.ts')
    expect(built?.modelData).toBe('The file D:\repo\a.ts has been updated successfully.')
  })

  it('keeps a POSIX host path unchanged', () => {
    const data = renderHostResult('Write', { outcome: 'created', path: '/repo/a\b.ts', bytes: 1 })
    const built = buildHostEditDiff('Write', { file_path: '/repo/a\b.ts', content: 'y' }, data)
    expect(built?.editDiff.filePath).toBe('/repo/a\b.ts')
  })

  it('falls back to file_path when the host reports no path', () => {
    const built = buildHostEditDiff('Edit', { file_path: 'D:/repo/a.ts', old_string: 'x', new_string: 'y' }, { message: 'ok' })
    expect(built?.editDiff.filePath).toBe('D:/repo/a.ts')
  })
})
