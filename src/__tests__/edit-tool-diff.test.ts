import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildEditDiffTarget, EditToolDiff, isEditArgs } from '../components/assistant-ui/edit-tool-diff'
import { buildHostEditDiff } from '../toolkit/builtin/host/editDiff'

// The Edit card's diff view. Hunk and row logic is pinned in
// file-change-diff.test.ts; these cover the component's own guard and output.

describe('isEditArgs', () => {
  it('requires both old_string and new_string to be strings', () => {
    expect(isEditArgs({ old_string: 'a', new_string: 'b' })).toBe(true)
    expect(isEditArgs({ old_string: 'a' })).toBe(false)
    expect(isEditArgs({ file_path: 'x' })).toBe(false)
    expect(isEditArgs(null)).toBe(false)
    expect(isEditArgs('x')).toBe(false)
  })
})

describe('Write diff target', () => {
  it('shows the lines a new file holds, a final newline not counted as a line', () => {
    const args = { file_path: 'src/n.ts', content: 'one\ntwo\n' }
    const built = buildHostEditDiff('Write', args, { message: 'File created.', path: 'src/n.ts' })!
    expect(buildEditDiffTarget(args, built.editDiff)).toMatchObject({
      kind: 'file',
      filePath: 'src/n.ts',
      plusLines: 2,
      minusLines: 0,
    })
  })
})

describe('EditToolDiff (render smoke)', () => {
  it('renders the file path, sigils, and changed code', () => {
    const html = renderToStaticMarkup(
      createElement(EditToolDiff, {
        args: { file_path: 'src/x.ts', old_string: 'foo\n', new_string: 'bar\n' },
      }),
    )
    expect(html).toContain('src/x.ts')
    expect(html).toContain('foo')
    expect(html).toContain('bar')
    expect(html).toContain('+')
    expect(html).toContain('-')
  })

  it('shows "No changes." when old === new', () => {
    const html = renderToStaticMarkup(
      createElement(EditToolDiff, {
        args: { file_path: 'src/x.ts', old_string: 'same\n', new_string: 'same\n' },
      }),
    )
    expect(html).toContain('No changes.')
  })
})
