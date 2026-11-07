// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import { commandsToA2uiMessages } from '../browser/webview/a2ui/toA2uiMessages'
import { vellocCatalog, vellocCatalogPropNames } from '../browser/webview/a2ui/catalog/vellocCatalog'
import { buildActionTurn } from '../browser/webview/a2ui/A2uiProviderHost'

const create = (args: Record<string, unknown>) => ({ name: 'a2ui_create_surface', args })
const data = (args: Record<string, unknown>) => ({ name: 'a2ui_update_data_model', args })

describe('A2UI v1.0 adapter', () => {
  it('stamps protocol version 1.0 on every message', () => {
    const messages = commandsToA2uiMessages(
      [create({ surfaceId: 's', components: [{ id: 'root', component: 'Text', text: 'Hi' }], dataModel: { a: 1 } })],
      vellocCatalog.id,
    )
    expect(messages).toHaveLength(3)
    for (const message of messages) expect(message.version).toBe('1.0')
  })

  it('always gives a data write a value, null for a removal, and skips an empty write', () => {
    const [removal] = commandsToA2uiMessages([data({ surfaceId: 's', path: '/a', value: null })], 'c')
    expect(removal.updateDataModel).toEqual({ surfaceId: 's', path: '/a', value: null })
    const [pathOnly] = commandsToA2uiMessages([data({ surfaceId: 's', path: '/a' })], 'c')
    expect(pathOnly.updateDataModel, 'a path with no value removes the key').toEqual({ surfaceId: 's', path: '/a', value: null })
    expect(commandsToA2uiMessages([data({ surfaceId: 's' })], 'c')).toEqual([])
    expect(commandsToA2uiMessages([data({ surfaceId: 's', path: '/' })], 'c'), 'never clears the root').toEqual([])
    expect(commandsToA2uiMessages([data({ surfaceId: 's', path: '' })], 'c')).toEqual([])
    const merged = commandsToA2uiMessages([data({ surfaceId: 's', path: '/form', merge: { name: 'Ada' } })], 'c')
    expect(merged.map(message => message.updateDataModel), 'a path beside a merge removes nothing').toEqual([
      { surfaceId: 's', path: '/name', value: 'Ada' },
    ])
  })

  it('turns a legacy List with an @path items binding and a string template into a child template', () => {
    const [, update] = commandsToA2uiMessages(
      [
        create({
          surfaceId: 's',
          components: [
            { id: 'root', component: 'List', items: { '@path': '/rows' }, template: 'row' },
            { id: 'row', component: 'Text', text: 'x' },
          ],
        }),
      ],
      vellocCatalog.id,
      vellocCatalogPropNames,
    )
    const components = (update.updateComponents as { components: Record<string, unknown>[] }).components
    expect(components[0]).toEqual({ id: 'root', component: 'List', children: { componentId: 'row', path: '/rows' } })
  })

  it('maps props the earlier basic catalog had onto their v1.0 form', () => {
    const [, update] = commandsToA2uiMessages(
      [
        create({
          surfaceId: 's',
          components: [
            { id: 'root', component: 'Text', text: 'Title', variant: 'h2' },
            { id: 'slider', component: 'Slider', value: { path: '/v' }, max: 10, step: 1 },
          ],
        }),
      ],
      'c',
    )
    const components = (update.updateComponents as { components: Record<string, unknown>[] }).components
    expect(components[0]).toEqual({ id: 'root', component: 'Text', text: '## Title' })
    expect(components[1]).not.toHaveProperty('step')
  })

  it('maps an inline Button label to a Text child and CheckBox checked to value', () => {
    const [, update] = commandsToA2uiMessages(
      [
        create({
          surfaceId: 's',
          components: [
            { id: 'root', component: 'Button', label: 'Send', action: { event: { name: 'send' } } },
            { id: 'box', component: 'CheckBox', label: 'Agree', checked: '/agree' },
          ],
        }),
      ],
      'c',
    )
    const components = (update.updateComponents as { components: Record<string, unknown>[] }).components
    expect(components[0]).toMatchObject({ id: 'root', component: 'Button', child: 'root__label' })
    expect(components[0]).not.toHaveProperty('label')
    const [, inert] = commandsToA2uiMessages(
      [create({ surfaceId: 's', components: [{ id: 'go', component: 'Button', child: 't' }] })],
      'c',
    )
    expect((inert.updateComponents as { components: Record<string, unknown>[] }).components[0].action)
      .toEqual({ event: { name: 'go' } })
    expect(components[1]).toEqual({ id: 'root__label', component: 'Text', text: 'Send' })
    expect(components[2]).toMatchObject({ id: 'box', value: { '@path': '/agree' } })
    expect(components[2]).not.toHaveProperty('checked')
  })

  it('is accepted by the v1.0 processor with the Velloc catalog, bindings included', () => {
    const processor = new MessageProcessor([vellocCatalog])
    const messages = commandsToA2uiMessages(
      [
        create({
          surfaceId: 'sales',
          components: [
            { id: 'root', component: 'Column', children: ['total', 'share'] },
            { id: 'total', component: 'Metric', label: 'Revenue', value: { path: '/total' } },
            { id: 'share', component: 'PieChart', data: { path: '/regions' }, donut: true },
          ],
          dataModel: { total: '$980K', regions: [{ label: 'North', value: 45 }] },
        }),
        data({ surfaceId: 'sales', path: '/total', value: '$1M' }),
      ],
      vellocCatalog.id,
    )
    for (const message of messages) processor.processMessages(message as never)
    const surface = processor.getSurface('sales')
    expect(surface).toBeDefined()
    expect(surface?.dataModel.get('/total')).toBe('$1M')
    expect(surface?.dataModel.get('/regions')).toEqual([{ label: 'North', value: 45 }])
  })
})

describe('A2UI action turn', () => {
  it('carries the action, its context, the data model and a userMessage when given', () => {
    const turn = buildActionTurn(
      {
        name: 'save',
        surfaceId: 's',
        sourceComponentId: 'btn',
        timestamp: '2026-11-07T00:00:00Z',
        context: { id: 1 },
        userMessage: 'Saved the form',
      },
      { form: { name: 'A' } },
    )
    const json = JSON.parse(turn.slice(turn.indexOf('{'), turn.lastIndexOf('}') + 1))
    expect(json).toEqual({
      surfaceId: 's',
      action: 'save',
      sourceComponentId: 'btn',
      context: { id: 1 },
      dataModel: { form: { name: 'A' } },
      userMessage: 'Saved the form',
    })
  })
})

describe('A2UI v1.0 adapter against the strict catalog', () => {
  it('drops props a component does not define so the component is kept', async () => {
    const { vellocCatalogPropNames } = await import('../browser/webview/a2ui/catalog/vellocCatalog')
    expect(vellocCatalogPropNames.get('TextField')?.has('label')).toBe(true)
    const messages = commandsToA2uiMessages(
      [
        create({
          surfaceId: 'contact',
          components: [
            { id: 'root', component: 'Card', child: 'col', title: 'Get in touch' },
            { id: 'col', component: 'Column', children: ['name'] },
            { id: 'name', component: 'TextField', label: 'Full name', required: true, value: '/form/name' },
          ],
          dataModel: { form: { name: '' } },
        }),
      ],
      vellocCatalog.id,
      vellocCatalogPropNames,
    )
    const components = (messages[1].updateComponents as { components: Record<string, unknown>[] }).components
    expect(components[0]).toEqual({ id: 'root', component: 'Card', child: 'col' })
    expect(components[2]).toEqual({ id: 'name', component: 'TextField', label: 'Full name', value: { '@path': '/form/name' } })
    const processor = new MessageProcessor([vellocCatalog])
    for (const message of messages) processor.processMessages(message as never)
    expect(processor.getSurface('contact')?.componentsModel.get('root')).toBeDefined()
  })
})
