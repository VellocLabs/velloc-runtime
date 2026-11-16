// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compile } from '@tailwindcss/node'
import { describe, expect, it } from 'vitest'

const stylesDir = join(__dirname, '..', 'styles')

/** The app stylesheet built for exactly these class names. */
async function buildFor(candidates: string[]): Promise<string> {
  const css = readFileSync(join(stylesDir, 'globals.css'), 'utf8')
  const compiler = await compile(css, { base: stylesDir, onDependency: () => {} })
  return compiler.build(candidates)
}

describe('shimmer utility', () => {
  it('emits the shimmer rule and its keyframes for the class the running rows use', async () => {
    const out = await buildFor(['shimmer', 'motion-safe:shimmer'])
    expect(out).toMatch(/\.shimmer\s*\{[^}]*background-clip:\s*text/)
    expect(out).toMatch(/\.motion-safe\\:shimmer\s*\{/)
    expect(out).toMatch(/@keyframes tw-shimmer/)
  })
})
