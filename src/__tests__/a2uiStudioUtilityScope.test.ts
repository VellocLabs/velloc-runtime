import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STUDIO_OVERLAY_MARK } from '../browser/webview/a2ui/studio/StudioSurfaceHost'

const css = readFileSync(join(__dirname, '../browser/webview/a2ui/studio/studio.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

describe('studio utility scope', () => {
  it('emits its utilities only inside a studio surface or overlay, so app grids keep their columns', () => {
    expect(css).not.toMatch(/@import\s+["']tailwindcss(\/utilities\.css)?["']/)
    const scope = css.match(/@scope\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\{\s*@tailwind utilities source\(none\);\s*\}/)
    expect(scope).not.toBeNull()
    const roots = scope![1].split(',').map(root => root.trim())
    expect(roots).toEqual(['.a2-surface-host', `.a2ui-surface[style*="${STUDIO_OVERLAY_MARK}"]`])
    expect(css.match(/@tailwind utilities/g)).toHaveLength(1)
    expect(css.slice(0, css.indexOf('@scope'))).toMatch(/@layer utilities\s*\{\s*$/)
  })
})
