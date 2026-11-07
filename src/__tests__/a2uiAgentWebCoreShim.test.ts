import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../..')

function exportedNames(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const names = new Set<string>()
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of block[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  for (const match of source.matchAll(/export const (\w+)/g)) names.add(match[1])
  return [...names].sort()
}

describe('a2ui agent web_core alias', () => {
  it('exports every name the agent reads from web_core', () => {
    const agent = exportedNames(resolve(root, 'node_modules/@a2ui/agent/src/internal/web-core.js'))
    const shim = exportedNames(resolve(root, 'vite/a2uiAgentWebCore.js'))
    expect(shim).toEqual(agent)
  })

  it('takes no version entry point that loads the renderer', () => {
    const shim = readFileSync(resolve(root, 'vite/a2uiAgentWebCore.js'), 'utf8')
    expect(shim).not.toMatch(/from '@a2ui\/web_core\/v(0_9|1_0)'/)
  })

  it('is the alias for the agent module', () => {
    const config = readFileSync(resolve(root, 'vite.config.ts'), 'utf8')
    expect(config).toContain("'./vite/a2uiAgentWebCore.js'")
    expect(config).toContain("exclude: ['@a2ui/agent']")
  })
})
