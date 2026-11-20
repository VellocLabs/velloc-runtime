import { describe, expect, it } from 'vitest'
import description from '../toolkit/builtin/a2ui/express/studio-catalog.json'
import { createStudioExpressCompiler, narrowChildLists } from '../toolkit/builtin/a2ui/express/studioExpress'

type Created = { createSurface?: { components: { id: string; component: string; tabs?: unknown; items?: unknown }[] } }

const compiler = createStudioExpressCompiler(description as unknown as Record<string, unknown>)

function components(body: string) {
  const result = compiler.compile(body)
  if (!result.ok) throw new Error(result.message)
  return (result.messages as Created[]).flatMap(message => message.createSurface?.components ?? [])
}

describe('studio child lists (F-1)', () => {
  it('compiles Tabs whose panels are reached only through the tab list', () => {
    const list = components([
      'surface("tabs")',
      'root = Tabs([{title: "One", child: first}, {title: $/text/two, child: second}])',
      'first = Text("a")',
      'second = Column([inner])',
      'inner = Text("b")',
    ].join('\n'))
    expect(list.map(entry => entry.id).sort()).toEqual(['first', 'inner', 'root', 'second'])
    expect((list.find(entry => entry.id === 'root')?.tabs as { child: string }[]).map(tab => tab.child)).toEqual(['first', 'second'])
  })

  it('compiles Accordion whose bodies are reached only through the item list', () => {
    const list = components([
      'surface("acc")',
      'root = Accordion([{title: "One", child: body}])',
      'body = Text("a")',
    ].join('\n'))
    expect(list.map(entry => entry.id).sort()).toEqual(['body', 'root'])
  })

  it('still refuses a component nothing reaches', () => {
    const result = compiler.compile(['surface("tabs")', 'root = Tabs([{title: "One", child: first}])', 'first = Text("a")', 'stray = Text("b")'].join('\n'))
    expect(result.ok).toBe(false)
  })

  it('narrows only the two child lists and leaves the input untouched', () => {
    const input = description as unknown as { components: Record<string, { properties: Record<string, { type?: string; anyOf?: unknown[] }> }> }
    const before = JSON.stringify(input)
    const narrowed = narrowChildLists(input) as typeof input
    expect(JSON.stringify(input)).toBe(before)
    expect(narrowed.components.Tabs!.properties.tabs).toMatchObject({ type: 'array', items: { type: 'object' } })
    expect(narrowed.components.Accordion!.properties.items).toMatchObject({ type: 'array', items: { type: 'object' } })
    expect(narrowed.components.Row).toEqual(input.components.Row)
  })
})
