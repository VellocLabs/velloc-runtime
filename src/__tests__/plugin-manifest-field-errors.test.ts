import { describe, expect, it } from 'vitest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'

const check = (extra: Record<string, unknown>) => checkPluginDescriptor({ name: 'p', ...extra })

describe('plugin manifest field errors', () => {
  it('rejects non-object manifests outright', () => {
    for (const v of [null, [], 3, 'x']) {
      expect(checkPluginDescriptor(v)).toEqual({ manifest: null, errors: ['Manifest must be a JSON object'] })
    }
    expect(checkPluginDescriptor({ name: 5 }).errors).toEqual(['name: required and must be a non-empty string'])
  })

  it('drops bad metadata and keeps the rest', () => {
    const { manifest, errors } = check({ version: 2, license: 'MIT', author: 'me', keywords: ['a', 1, 'b'] })
    expect(errors).toEqual(['version: expected a string', 'author: expected an object with a "name"'])
    expect(manifest).toEqual({ name: 'p', license: 'MIT', keywords: ['a', 'b'] })
    expect(check({ author: { name: '' } }).errors).toEqual(['author.name: required and must be a non-empty string'])
    expect(check({ author: { name: 'a', email: 3 } }).manifest?.author).toEqual({ name: 'a' })
    expect(check({ keywords: 'x' }).errors).toEqual(['keywords: expected an array of strings'])
    expect(check({ keywords: [1] }).manifest).toEqual({ name: 'p' })
    expect(check({ unknown: 1 }).errors).toEqual([])
  })

  it('explains bad component paths', () => {
    expect(check({ skills: [3, '../x'] })).toEqual({
      manifest: { name: 'p' },
      errors: [
        'skills: 3 must be a relative path starting with "./" and without ".."',
        'skills: "../x" must be a relative path starting with "./" and without ".."',
      ],
    })
    expect(check({ skills: 7 }).errors).toEqual(['skills: expected a path string or an array of path strings'])
    expect(check({ hooks: './h.yaml' }).errors).toEqual(['hooks: "./h.yaml" must end with .json'])
    expect(check({ mcpServers: ['./m.JSON'] }).manifest?.mcpServers).toEqual(['./m.JSON'])
    expect(check({ hooks: {} }).errors).toEqual(['hooks: inline hooks object contained no valid entries'])
    expect(check({ agents: ['./a.md', './b.txt'] }).manifest?.agents).toEqual(['./a.md'])
  })

  it('flattens a command mapping to its sources', () => {
    const { manifest, errors } = check({
      commands: {
        ok: { source: './c/ok.md', description: 'x' },
        bad: 'nope',
        inline: { content: 'hi' },
        far: { source: '../c.md' },
      },
    })
    expect(manifest?.commands).toEqual(['./c/ok.md'])
    expect(errors).toEqual([
      'commands.bad: expected an object with a "source"',
      'commands.inline: inline "content" commands are not supported yet — use "source"',
      'commands.far: "source" must be a relative path',
    ])
  })

  it('reports an unusable inline MCP server', () => {
    const { manifest, errors } = check({ mcpServers: { x: { type: 'stdio' } } })
    expect(errors).toEqual(['mcpServers.x: invalid or unsupported server config'])
    expect(manifest?.mcpServers).toBeUndefined()
  })
})

describe('plugin userConfig validation', () => {
  const base = { type: 'string', title: 'T', description: 'D' }
  const errs = (fields: unknown) => check({ userConfig: fields }).errors
  const kept = (fields: unknown) => check({ userConfig: fields }).manifest?.userConfig
  // One error, prefixed with the field key, matching `fact`.
  const one = (fields: unknown, key: string, fact: RegExp) => {
    const e = errs(fields)
    expect(e).toHaveLength(1)
    expect(e[0]).toMatch(new RegExp(`^userConfig\.${key}: `))
    expect(e[0]).toMatch(fact)
  }

  it('checks structure in order and stops at the first failure', () => {
    expect(errs('x')).toHaveLength(1)
    expect(check({ userConfig: 'x' }).manifest?.userConfig).toBeUndefined()
    one({ '1bad': base }, '1bad', /CLAUDE_PLUGIN_OPTION_<KEY>/)
    one({ k: 3 }, 'k', /object/)
    one({ k: { ...base, a: 1, b: 2 } }, 'k', /"a", "b"/)
    one({ k: { ...base, a: 1, type: 'date' } }, 'k', /"a"/)
    one({ k: { ...base, type: 'date', title: 1 } }, 'k', /type/)
    one({ k: { ...base, title: 1, description: 1 } }, 'k', /title/)
    one({ k: { ...base, description: 1 } }, 'k', /description/)
  })

  it('collects every value-level problem and keeps the good fields', () => {
    const e = errs({ k: { ...base, required: 'y', min: Infinity, default: {} } })
    expect(e).toHaveLength(3)
    expect(e[0]).toMatch(/required/)
    expect(e[1]).toMatch(/min/)
    expect(e[2]).toMatch(/default/)
    expect(kept({ good: { ...base, default: 5 }, bad: 1 })).toEqual({ good: { ...base, default: 5 } })
    expect(kept({})).toEqual({})
  })

  it('validates option lists', () => {
    const opt = (options: unknown, fact: RegExp, more: object = {}) =>
      one({ k: { ...base, default: 'a', options, ...more } }, 'k', fact)
    opt(['a', 1], /list/)
    opt([], /empty/)
    opt(['a', ''], /empty string/)
    opt(['a', 'x'.repeat(65)], /64/)
    opt(['a', 'b\u200e'], /invisible/)
    opt(['a', 'b\u2028'], /invisible/)
    opt(['a', ' b'], /spaces/)
    opt(['a', 'A'], /letter case/)
    opt(['a'], /single, non-secret string/, { sensitive: true })
    opt(['a'], /single, non-secret string/, { multiple: true })
    one({ k: { ...base, options: ['a'] } }, 'k', /required: true/)
    expect(errs({ k: { ...base, options: ['a'], required: true } })).toEqual([])
    opt(['b', 'c'], /b \| c/)
    expect(errs({ k: { ...base, default: 'a', options: ['a', 'b'] } })).toEqual([])
    expect(errs({ k: { ...base, type: 'number', default: 'x' } })).toEqual([])
  })
})
