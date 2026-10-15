import { describe, expect, it } from 'vitest'
import {
  checkOptions,
  isOffChoice,
  optionsLoadError,
  publicOptions,
  settleOptions,
} from '../mods/optionValues'
import type { PluginUserConfigField } from '../pluginHost/pluginModel'

const f = (over: Partial<PluginUserConfigField>): PluginUserConfigField => ({
  type: 'string',
  title: '',
  description: '',
  ...over,
})

describe('settleOptions: start values (rule 1)', () => {
  it('uses the default, "" without one, and leaves a required no-default field absent', () => {
    const { values } = settleOptions({
      a: f({ default: 'x' }),
      b: f({}),
      c: f({ required: true }),
      d: f({ type: 'number', required: true, default: 4 }),
    })
    expect(values).toEqual({ a: 'x', b: '', d: 4 })
    expect('c' in values).toBe(false)
  })

  it('no fields → nothing', () => {
    expect(settleOptions(undefined, { a: 1 })).toEqual({ values: {}, problems: [], notices: [] })
  })
})

describe('settleOptions: stored values (rule 2)', () => {
  it('replaces start values, skips undefined/null and undeclared keys', () => {
    const { values } = settleOptions(
      { a: f({ default: 'x' }), b: f({ default: 'y' }), c: f({ default: 'z' }) },
      { a: 'new', b: null, c: undefined, extra: 'ignored' },
    )
    expect(values).toEqual({ a: 'new', b: 'y', c: 'z' })
  })
})

describe('settleOptions: choices (rule 3)', () => {
  const fields = {
    mode: f({ title: 'Mode', options: ['fast', 'slow'], default: 'fast' }),
    pick: f({ options: ['a', 'b'] }),
  }

  it('accepts a listed choice without notice', () => {
    const r = settleOptions(fields, { mode: 'slow', pick: 'b' })
    expect(r.values).toEqual({ mode: 'slow', pick: 'b' })
    expect(r.notices).toEqual([])
  })

  it('an unlisted or non-string value keeps the start value and adds one notice each', () => {
    const r = settleOptions(fields, { mode: 'warp', pick: 3 })
    expect(r.values).toEqual({ mode: 'fast', pick: '' })
    expect(r.notices).toHaveLength(2)
    expect(r.notices[0]).toContain('Mode')
    expect(r.notices[0]).toContain('"fast", "slow"')
    expect(r.notices[0]).toContain('default "fast"')
    expect(r.notices[1]).toContain('pick')
    expect(r.notices[1]).toContain('unset')
    expect(r.problems).toEqual([])
  })

  it('a field without options never notices', () => {
    expect(settleOptions({ a: f({}) }, { a: 'anything' }).notices).toEqual([])
  })

  it('isOffChoice', () => {
    expect(isOffChoice(undefined, 'x')).toBe(false)
    expect(isOffChoice(f({}), 5)).toBe(false)
    expect(isOffChoice(fields.mode, 'fast')).toBe(false)
    expect(isOffChoice(fields.mode, 'warp')).toBe(true)
    expect(isOffChoice(fields.mode, 1)).toBe(true)
  })
})

describe('checkOptions (rule 4)', () => {
  it('required: absent or "" is one problem, labelled by title then key', () => {
    const p = checkOptions({ b: '' }, {
      a: f({ title: 'Token', required: true, type: 'number' }),
      b: f({ required: true }),
    })
    expect(p).toHaveLength(2)
    expect(p[0]).toMatch(/^Token .*required/)
    expect(p[1]).toMatch(/^b .*required/)
  })

  it('optional blank is fine', () => {
    expect(checkOptions({ a: '' }, { a: f({ type: 'number' }), b: f({ type: 'boolean' }) })).toEqual([])
  })

  it('string rules', () => {
    expect(checkOptions({ a: ['x'] }, { a: f({}) })).toHaveLength(1)
    expect(checkOptions({ a: ['x', 'y'] }, { a: f({ multiple: true }) })).toEqual([])
    expect(checkOptions({ a: ['x', 1] }, { a: f({ multiple: true }) })).toHaveLength(1)
    expect(checkOptions({ a: 3 }, { a: f({}) })).toHaveLength(1)
    const off = checkOptions({ a: 'z' }, { a: f({ options: ['x', 'y'] }) })
    expect(off).toHaveLength(1)
    expect(off[0]).toContain('x, y')
  })

  it('number rules', () => {
    const fields = { n: f({ type: 'number', title: 'N', min: 1, max: 5 }) }
    expect(checkOptions({ n: '3' }, fields)).toHaveLength(1)
    expect(checkOptions({ n: 3 }, fields)).toEqual([])
    expect(checkOptions({ n: 0 }, fields)[0]).toContain('1')
    expect(checkOptions({ n: 9 }, fields)[0]).toContain('5')
  })

  it('boolean, file and directory rules', () => {
    expect(checkOptions({ b: 'yes' }, { b: f({ type: 'boolean' }) })).toHaveLength(1)
    expect(checkOptions({ b: false }, { b: f({ type: 'boolean' }) })).toEqual([])
    expect(checkOptions({ p: 1, d: true }, { p: f({ type: 'file' }), d: f({ type: 'directory' }) })).toHaveLength(2)
    expect(checkOptions({ p: '/a' }, { p: f({ type: 'file' }) })).toEqual([])
  })
})

describe('settleOptions result (rule 5)', () => {
  it('problems equal checkOptions over the settled values', () => {
    const fields = { n: f({ type: 'number', max: 2 }), r: f({ required: true }) }
    const r = settleOptions(fields, { n: 7 })
    expect(r.problems).toEqual(checkOptions(r.values, fields))
    expect(r.problems).toHaveLength(2)
  })
})

describe('optionsLoadError (rule 6)', () => {
  it('one line naming plugin, problems and where to fix', () => {
    const msg = optionsLoadError('My Mod', 'my-mod@inline', ['a is wrong', 'b is wrong'])
    expect(msg).not.toContain('\n')
    expect(msg).toContain('My Mod')
    expect(msg).toContain('userConfig')
    expect(msg).toContain('a is wrong; b is wrong')
    expect(msg).toContain('pluginConfigs["my-mod@inline"].options')
    expect(msg).toContain('Settings → Plugins')
  })
})

describe('publicOptions (rule 7)', () => {
  it('hides non-empty non-boolean sensitive values; passes everything else', () => {
    const fields = {
      key: f({ sensitive: true }),
      empty: f({ sensitive: true }),
      list: f({ sensitive: true, multiple: true }),
      none: f({ sensitive: true, multiple: true }),
      flag: f({ type: 'boolean', sensitive: true }),
      num: f({ type: 'number', sensitive: true }),
      plain: f({}),
    }
    expect(publicOptions(fields, {
      key: 'secret', empty: '', list: ['a'], none: [], flag: true, num: 3, plain: 'p', extra: 'e',
    })).toEqual({
      key: '••••', empty: '', list: '••••', none: [], flag: true, num: '••••', plain: 'p', extra: 'e',
    })
    expect(publicOptions(undefined, { a: 'x' })).toEqual({ a: 'x' })
  })
})
