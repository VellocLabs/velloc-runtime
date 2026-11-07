import { describe, expect, it } from 'vitest'
import { Catalog } from '@a2ui/web_core/catalog'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import {
  a2uiBlockKey,
  blockSurfaceIds,
  hasA2uiBlock,
  splitA2uiText,
} from '../toolkit/builtin/a2ui/express/a2uiBlocks'
import { createA2uiExpressCompiler } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'
import catalogDocument from '../toolkit/builtin/a2ui/express/velloc-catalog.json'

const catalog = (Catalog as unknown as { fromJson(json: unknown): never }).fromJson(catalogDocument)
const FORM = [
  'surface("contact")',
  'root = Card(col)',
  'col = Column([name, sub, send])',
  'name = TextField("Name", $/form/name)',
  'sub = CheckBox("Subscribe", $/form/subscribe)',
  'send = Button(Text("Send"), action=Event("submit"))',
  '$/form = {name: "", subscribe: false}',
].join('\n')

describe('splitA2uiText', () => {
  it('splits prose and blocks in order', () => {
    const segments = splitA2uiText(`Here:\n<a2ui>\n${FORM}\n</a2ui>\nDone.`)
    expect(segments.map(s => s.kind)).toEqual(['text', 'block', 'text'])
    expect(segments[1]).toMatchObject({ kind: 'block', body: FORM, closed: true, index: 0 })
  })

  it('marks a block still being written as open', () => {
    const segments = splitA2uiText('Hi <a2ui>\nsurface("x")\nroot = Card(')
    expect(segments.at(-1)).toMatchObject({ kind: 'block', closed: false })
  })

  it('drops code fences around or inside the block', () => {
    const fenced = splitA2uiText('A\n```\n<a2ui>\n```a2ui\nroot = Text("x")\n```\n</a2ui>\n```\nB')
    expect(fenced).toEqual([
      { kind: 'text', text: 'A' },
      { kind: 'block', body: 'root = Text("x")', closed: true, index: 0 },
      { kind: 'text', text: 'B' },
    ])
  })

  it('leaves text without blocks alone', () => {
    expect(splitA2uiText('plain')).toEqual([{ kind: 'text', text: 'plain' }])
    expect(hasA2uiBlock('plain')).toBe(false)
  })
})

describe('blockSurfaceIds / a2uiBlockKey', () => {
  it('reads the surface and delete lines', () => {
    expect(blockSurfaceIds(`${FORM}\ndeleteSurface("old")`)).toEqual({ targets: ['contact'], deletes: ['old'] })
  })

  it('keys a block by surface and source', () => {
    expect(a2uiBlockKey('a', 'x')).toBe(a2uiBlockKey('a', 'x'))
    expect(a2uiBlockKey('a', 'x')).not.toBe(a2uiBlockKey('a', 'y'))
  })
})

describe('createA2uiExpressCompiler', () => {
  const compiler = createA2uiExpressCompiler(catalog)

  it('compiles a block into v1.0 messages', () => {
    const result = compiler.compile(FORM, compiler.createState())
    expect(result.ok).toBe(true)
    const [create] = result.ok ? result.messages : []
    expect(create).toMatchObject({ version: '1.0', createSurface: { surfaceId: 'contact' } })
  })

  it('reports the missing required prop of a broken component', () => {
    const result = compiler.compile(FORM.replace('CheckBox("Subscribe", $/form/subscribe)', 'CheckBox("Subscribe")'), compiler.createState())
    expect(result).toEqual({ ok: false, message: expect.stringContaining("'CheckBox' is missing required property 'value'") })
  })

  it('lets a later block update a surface an earlier block made', () => {
    const state = compiler.createState()
    expect(compiler.compile(FORM, state).ok).toBe(true)
    const update = compiler.compile('surface("contact")\n$/form/name = "Ada"', state)
    expect(update.ok).toBe(true)
    expect(update.ok && update.messages[0]).toMatchObject({ updateDataModel: { surfaceId: 'contact' } })
  })

  it('applies a compiled block to a bound renderer, and leaves it untouched on failure', () => {
    const renderer = new MessageProcessor([catalog])
    const state = compiler.stateFor(renderer as never)
    expect(compiler.compile(FORM, state).ok).toBe(true)
    expect(renderer.getSurface('contact')?.dataModel.get('/form')).toEqual({ name: '', subscribe: false })
    expect(compiler.compile('surface("contact")\nroot = Card()', state).ok).toBe(false)
    expect(renderer.getSurface('contact')?.componentsModel.get('root')?.type).toBe('Card')
  })
})
