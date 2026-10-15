import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditToolDiff, isEditArgs } from '../components/assistant-ui/edit-tool-diff'

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
