/**
 * The static-import walker behind the boot hot-path and chunk-budget guards
 * must not lose real edges: ESM `.js` specifiers resolve to their TS source,
 * and comment-like text inside a string is not a comment.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSpecifier, staticClosure, stripComments } from './_helpers/staticImportGraph'

let dir: string | null = null

function tree(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'static-import-graph-'))
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('staticImportGraph', () => {
  it('resolves a .js specifier to the .ts or .tsx source', () => {
    const root = tree({ 'a.ts': '', 'b.ts': '', 'c.tsx': '' })
    expect(resolveSpecifier('./b.js', join(root, 'a.ts'))).toBe(join(root, 'b.ts'))
    expect(resolveSpecifier('./c.js', join(root, 'a.ts'))).toBe(join(root, 'c.tsx'))
  })

  it('keeps an import that follows a string holding comment openers', () => {
    const root = tree({
      'a.ts': "const glob = '**/*.ts'\nconst url = 'https://example.com'\nimport { b } from './b.js'\nexport const end = '*/'\n",
      'b.ts': 'export const b = 1\n',
    })
    expect([...staticClosure([join(root, 'a.ts')])]).toContain(join(root, 'b.ts'))
  })

  it('still drops commented-out imports', () => {
    const source = "/* import { x } from './x'\n*/\n// import { y } from './y'\nconst s = \"//not a comment\"\n"
    const stripped = stripComments(source)
    expect(stripped).not.toContain("'./x'")
    expect(stripped).not.toContain("'./y'")
    expect(stripped).toContain('"//not a comment"')
  })
})
