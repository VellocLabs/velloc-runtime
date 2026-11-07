import { describe, expect, it } from 'vitest'
import { Catalog } from '@a2ui/web_core/catalog'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import catalogDocument from '../toolkit/builtin/a2ui/express/velloc-catalog.json'
import { createA2uiExpressCompiler } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'
import { continueReusedSurfaces, createSurfaceLineFilter } from '../toolkit/builtin/a2ui/express/a2uiSurfaceLines'

const catalog = (Catalog as unknown as { fromJson(json: unknown): never }).fromJson(catalogDocument)
const exists = (...ids: string[]) => (id: string) => ids.includes(id)

const FORM = [
  'surface("contact")',
  '$/form/name = ""',
  '$/form/subscribe = true',
  'root = Card(col)',
  'col = Column([nameField, subscribeBox, submitBtn])',
  'nameField = TextField("Name", $/form/name)',
  'subscribeBox = CheckBox("Subscribe", $/form/subscribe)',
  'submitBtn = Button(Text("Send"), "primary", Event("send", {name: $/form/name}))',
].join('\n')

// The same surface again, its root redefined with one more child.
const FORM_WITH_ERROR = [
  'surface("contact")',
  'root = Card(col)',
  'col = Column([nameField, subscribeBox, submitBtn, errMsg])',
  'nameField = TextField("Name", $/form/name)',
  'subscribeBox = CheckBox("Subscribe", $/form/subscribe)',
  'submitBtn = Button(Text("Send"), "primary", Event("send", {name: $/form/name}))',
  'errMsg = Text("Check the address", "caption")',
].join('\n')

describe('continueReusedSurfaces', () => {
  it('continues a bare surface line whose surface exists, and leaves a new id alone', () => {
    expect(continueReusedSurfaces('surface("a")\nroot = Text("x")', exists('a'))).toBe('surface("a", update=true)\nroot = Text("x")')
    expect(continueReusedSurfaces('surface("b")\nroot = Text("x")', exists('a'))).toBe('surface("b")\nroot = Text("x")')
  })

  it('leaves a surface call with other arguments as written', () => {
    const body = 'surface("a", sendDataModel=true)\nroot = Text("x")'
    expect(continueReusedSurfaces(body, exists('a'))).toBe(body)
  })

  it('creates again a surface the block deleted, and continues one the block made', () => {
    const body = 'deleteSurface("a")\nsurface("a")\nroot = Text("x")\nsurface("a")\n$/n = 1'
    expect(continueReusedSurfaces(body, exists('a'))).toBe(
      'deleteSurface("a")\nsurface("a")\nroot = Text("x")\nsurface("a", update=true)\n$/n = 1',
    )
  })
})

describe('createSurfaceLineFilter', () => {
  it('holds a line that may be a surface directive until it ends', () => {
    const filter = createSurfaceLineFilter(exists('a'))
    expect(filter.push('sur')).toBe('')
    expect(filter.push('face("a")')).toBe('')
    expect(filter.push('\nroot = Te')).toBe('surface("a", update=true)\nroot = Te')
    expect(filter.push('xt("x")')).toBe('xt("x")')
    expect(filter.push('\ndeleteSurface("a")')).toBe('\n')
    expect(filter.flush()).toBe('deleteSurface("a")')
  })

  it('passes any other line on as it is written', () => {
    const filter = createSurfaceLineFilter(exists())
    expect(filter.push('surface("b")\n$/n')).toBe('surface("b")\n$/n')
    expect(filter.push(' = 1')).toBe(' = 1')
    expect(filter.flush()).toBe('')
  })
})

describe('a block that reuses a surface id', () => {
  const compiler = createA2uiExpressCompiler(catalog)

  it('redefines the existing surface in place and keeps its data', () => {
    const renderer = new MessageProcessor([catalog])
    const state = compiler.stateFor(renderer as never)
    expect(compiler.compile(FORM, state).ok).toBe(true)
    const update = compiler.compile(FORM_WITH_ERROR, state)
    expect(update).toMatchObject({ ok: true, messages: [{ updateComponents: { surfaceId: 'contact' } }] })
    const surface = renderer.getSurface('contact')
    expect(surface?.componentsModel.get('errMsg')?.type).toBe('Text')
    expect(surface?.dataModel.get('/form')).toEqual({ name: '', subscribe: true })
  })

  it('does the same while the block streams, whatever the chunks', () => {
    const renderer = new MessageProcessor([catalog])
    expect(compiler.compile(FORM, compiler.stateFor(renderer as never)).ok).toBe(true)
    const stream = compiler.stream(compiler.stateFor(renderer as never))
    for (let at = 0; at < FORM_WITH_ERROR.length; at += 3) {
      expect(stream.feed(FORM_WITH_ERROR.slice(at, at + 3)).ok).toBe(true)
    }
    expect(stream.close().ok).toBe(true)
    expect(renderer.getSurface('contact')?.componentsModel.get('errMsg')?.type).toBe('Text')
  })

  it('still draws a new surface after deleting the old one in the same block', () => {
    const state = compiler.createState()
    expect(compiler.compile(FORM, state).ok).toBe(true)
    const redraw = compiler.compile(`deleteSurface("contact")\n${FORM}`, state)
    expect(redraw.ok && redraw.messages.map(message => Object.keys(message).find(key => key !== 'version'))).toEqual([
      'deleteSurface',
      'createSurface',
    ])
  })
})
