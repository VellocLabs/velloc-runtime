import { describe, expect, it } from 'vitest'
import {
  isCuratedCatalog,
  joinPluginRef,
  readStrictPluginRef,
  splitPluginRef,
} from '../pluginHost/pluginRef'

describe('splitPluginRef', () => {
  it('splits name@marketplace', () => {
    expect(splitPluginRef('tools@acme')).toEqual({ name: 'tools', marketplace: 'acme' })
  })

  it('treats a string without @ as a bare name', () => {
    const r = splitPluginRef('tools')
    expect(r).toEqual({ name: 'tools' })
    expect('marketplace' in r).toBe(false)
  })

  it('ignores everything from a second @ on', () => {
    expect(splitPluginRef('a@b@c')).toEqual({ name: 'a', marketplace: 'b' })
  })

  it('keeps empty sides as empty strings', () => {
    expect(splitPluginRef('@acme')).toEqual({ name: '', marketplace: 'acme' })
    const r = splitPluginRef('tools@')
    expect(r).toEqual({ name: 'tools', marketplace: '' })
    expect('marketplace' in r).toBe(true)
  })

  it('does not trim', () => {
    expect(splitPluginRef(' a @ b ')).toEqual({ name: ' a ', marketplace: ' b ' })
  })
})

describe('joinPluginRef', () => {
  it('joins with @', () => {
    expect(joinPluginRef('tools', 'acme')).toBe('tools@acme')
  })

  it('returns the bare name for a missing or empty marketplace', () => {
    expect(joinPluginRef('tools')).toBe('tools')
    expect(joinPluginRef('tools', undefined)).toBe('tools')
    expect(joinPluginRef('tools', '')).toBe('tools')
  })

  it('round-trips with splitPluginRef', () => {
    const p = splitPluginRef('tools@acme')
    expect(joinPluginRef(p.name, p.marketplace)).toBe('tools@acme')
  })
})

describe('isCuratedCatalog', () => {
  it('matches the allow-list case-insensitively', () => {
    expect(isCuratedCatalog('claude-plugins-official')).toBe(true)
    expect(isCuratedCatalog('CLAUDE-Plugins-Official')).toBe(true)
  })

  it('rejects other names and undefined', () => {
    expect(isCuratedCatalog('acme')).toBe(false)
    expect(isCuratedCatalog('')).toBe(false)
    expect(isCuratedCatalog(undefined)).toBe(false)
  })
})

describe('readStrictPluginRef', () => {
  const code = (input: unknown) => {
    const r = readStrictPluginRef(input)
    return r.ok ? 'ok' : r.error.code
  }

  it('accepts name@marketplace and trims the input', () => {
    expect(readStrictPluginRef('  tools@acme  ')).toEqual({
      ok: true,
      value: { name: 'tools', marketplace: 'acme' },
    })
  })

  it('keeps inner spaces', () => {
    const r = readStrictPluginRef('my tool@my mkt')
    expect(r.ok && r.value).toEqual({ name: 'my tool', marketplace: 'my mkt' })
  })

  it('reports each error code', () => {
    expect(code('')).toBe('empty')
    expect(code('   ')).toBe('empty')
    expect(code(42)).toBe('empty')
    expect(code('tools')).toBe('missing_at')
    expect(code('a@b@c')).toBe('multiple_at')
    expect(code('@acme')).toBe('empty_name')
    expect(code('tools@')).toBe('empty_marketplace')
    expect(code('tools@team/acme')).toBe('invalid_marketplace_char')
  })

  it('applies the checks in order', () => {
    // multiple @ wins over empty sides and a slash
    expect(code('@@')).toBe('multiple_at')
    expect(code('a@b/c@d')).toBe('multiple_at')
    // empty name wins over empty marketplace
    expect(code('@')).toBe('empty_name')
    // empty name wins over a slash in the marketplace
    expect(code('@a/b')).toBe('empty_name')
  })

  it('quotes the input in missing_at, multiple_at and invalid_marketplace_char messages', () => {
    for (const input of ['tools', 'a@b@c', 'tools@x/y']) {
      const r = readStrictPluginRef(input)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.message).toContain(input)
    }
  })
})
