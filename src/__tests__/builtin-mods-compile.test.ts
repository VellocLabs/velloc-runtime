/**
 * The build-time path for built-in mods (F-25): every plugin directory
 * under a built-ins root compiles to one linked module, the way
 * `virtual:builtin-mods` serves it. No built-in ships today, so the case is a
 * plugin written to a temp dir in its installed layout.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileBuiltinMods } from '../../vite/builtinModsPlugin'

let root: string

function writePlugin(name: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, name, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text, 'utf8')
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'builtin-mods-'))
  writePlugin('sample', {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'sample', version: '1.2.3', description: 'A sample built-in.' }),
    'hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
    'hooks/register.ts': "import { greeting } from './greeting'\nexport function register(): string { return greeting }\n",
    'hooks/greeting.ts': "export const greeting: string = 'hello from sample'\n",
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('compileBuiltinMods', () => {
  it('compiles each plugin into one module that needs no compiler or disk path at load', async () => {
    const [sample, ...rest] = await compileBuiltinMods(root)
    expect(rest).toEqual([])
    expect(sample).toMatchObject({ name: 'sample', version: '1.2.3', description: 'A sample built-in.' })
    expect(sample.source).toMatch(/\bregister\b/)
    expect(sample.source).toContain('hello from sample')
    // Linked: no import left for the loader to resolve, and no disk path baked in.
    expect(sample.source).not.toMatch(/^[ \t]*import(?:[ \t]*['"{*]|[ \t]+[\w$])/m)
    expect(sample.source).not.toContain(root.replace(/\\/g, '/'))
    expect(sample.files.map(f => f.replace(/\\/g, '/')).sort()).toEqual([
      join(root, 'sample', 'hooks', 'greeting.ts').replace(/\\/g, '/'),
      join(root, 'sample', 'hooks', 'register.ts').replace(/\\/g, '/'),
    ])
  })

  it('answers no built-ins for a missing root', async () => {
    expect(await compileBuiltinMods(join(root, 'absent'))).toEqual([])
  })
})
