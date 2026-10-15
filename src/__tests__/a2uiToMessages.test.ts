import { describe, expect, it } from 'vitest'
import { commandsToA2uiMessages } from '../browser/webview/a2ui/toA2uiMessages'
import { A2UI_CREATE_SURFACE, A2UI_UPDATE_DATA_MODEL } from '../toolkit/builtin/a2ui/a2uiToolNames'

function updateComponents(
  msgs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  for (const msg of msgs) {
    const uc = msg.updateComponents as { components?: unknown } | undefined
    if (uc && Array.isArray(uc.components)) {
      return uc.components as Array<Record<string, unknown>>
    }
  }
  return []
}

function byId(
  comps: Array<Record<string, unknown>>,
  id: string,
): Record<string, unknown> {
  return comps.find(c => c.id === id) ?? {}
}

describe('toA2uiMessages component normalization', () => {
  it('wraps bare-string pointer bindings into {path} (the render-loop fix)', () => {
    const msgs = commandsToA2uiMessages(
      [
        {
          name: A2UI_CREATE_SURFACE,
          args: {
            surfaceId: 'contact',
            components: [
              { id: 'name', component: 'TextField', value: '/form/name', label: 'Full name', required: true },
              { id: 'sub', component: 'CheckBox', checked: '/form/subscribe', label: 'Sub' },
              { id: 'root', component: 'Card', child: 'name', title: 'Get in touch' },
            ],
            dataModel: { form: { name: '', subscribe: false } },
          },
        },
      ],
      'cat-id',
    )
    const comps = updateComponents(msgs)

    // Two-way binding strings → {path}
    expect(byId(comps, 'name').value).toEqual({ path: '/form/name' })
    expect(byId(comps, 'sub').checked).toEqual({ path: '/form/subscribe' })

    // Literals + non-pointer values untouched
    expect(byId(comps, 'name').label).toBe('Full name')
    expect(byId(comps, 'name').required).toBe(true)
    expect(byId(comps, 'root').title).toBe('Get in touch')

    // Structural keys (component ids) untouched even though they're strings
    expect(byId(comps, 'root').child).toBe('name')
  })

  it('keeps a bare-string display/URL prop literal even when it starts with "/"', () => {
    // Regression: normalization wraps bare-string BINDINGS into {path}, but a
    // display/URL prop that happens to start with "/" (a path in a label, a
    // relative image url) is a LITERAL — wrapping it would resolve to undefined
    // and render blank. Only true binding props (value/checked) coerce.
    const msgs = commandsToA2uiMessages(
      [
        {
          name: A2UI_CREATE_SURFACE,
          args: {
            surfaceId: 's',
            components: [
              { id: 'root', component: 'Card', child: 'col' },
              { id: 'col', component: 'Column', children: ['note', 'logo', 'field'] },
              { id: 'note', component: 'Text', text: '/tmp/report.txt was saved' },
              { id: 'logo', component: 'Image', url: '/assets/logo.png', alt: '/brand' },
              { id: 'field', component: 'TextField', value: '/form/name', label: '/path label' },
            ],
          },
        },
      ],
      'cat',
    )
    const comps = updateComponents(msgs)

    // Display + URL strings stay literal (NOT wrapped into {path}).
    expect(byId(comps, 'note').text).toBe('/tmp/report.txt was saved')
    expect(byId(comps, 'logo').url).toBe('/assets/logo.png')
    expect(byId(comps, 'logo').alt).toBe('/brand')
    expect(byId(comps, 'field').label).toBe('/path label')

    // A real two-way binding emitted as a bare string still coerces to {path}.
    expect(byId(comps, 'field').value).toEqual({ path: '/form/name' })
  })

  it('flattens a legacy props bag and maps $fn / List template to canonical', () => {
    const msgs = commandsToA2uiMessages(
      [
        {
          name: A2UI_CREATE_SURFACE,
          args: {
            surfaceId: 's',
            components: [
              { id: 'name', component: 'TextField', props: { value: { path: '/form/name' }, label: 'Name' } },
              { id: 'greet', component: 'Text', props: { text: { $fn: 'formatString', args: ['Hi {0}', { path: '/form/name' }] } } },
              { id: 'list', component: 'List', props: { items: { path: '/items' }, template: 'row' } },
            ],
          },
        },
      ],
      'cat',
    )
    const comps = updateComponents(msgs)

    // props bag flattened onto the component
    expect(byId(comps, 'name').value).toEqual({ path: '/form/name' })
    expect(byId(comps, 'name').label).toBe('Name')
    expect(byId(comps, 'name').props).toBeUndefined()

    // {$fn,args} → {call,args}
    expect(byId(comps, 'greet').text).toEqual({
      call: 'formatString',
      args: ['Hi {0}', { path: '/form/name' }],
    })

    // legacy List items+template → canonical children template
    expect(byId(comps, 'list').children).toEqual({ componentId: 'row', path: '/items' })
  })

  it('hoists an inline-object List template into a canonical child template', () => {
    const msgs = commandsToA2uiMessages(
      [
        {
          name: A2UI_CREATE_SURFACE,
          args: {
            surfaceId: 'tasks',
            components: [
              {
                id: 'list',
                component: 'List',
                props: {
                  items: { path: '/tasks' },
                  template: { id: 'tmpl', component: 'Row', children: ['icon', 'title'] },
                },
              },
              { id: 'icon', component: 'Icon', props: { name: 'check-circle' } },
              { id: 'title', component: 'Text', props: { text: { path: 'title' } } },
            ],
            dataModel: { tasks: [{ title: 'A' }] },
          },
        },
      ],
      'cat',
    )
    const comps = updateComponents(msgs)

    // List children rewritten to a canonical child-template; legacy keys gone.
    expect(byId(comps, 'list').children).toEqual({ componentId: 'tmpl', path: '/tasks' })
    expect(byId(comps, 'list').template).toBeUndefined()
    expect(byId(comps, 'list').items).toBeUndefined()

    // Template hoisted as its own component.
    expect(byId(comps, 'tmpl').component).toBe('Row')
    expect(byId(comps, 'tmpl').children).toEqual(['icon', 'title'])

    // Relative binding preserved (resolves per-item upstream); icon flattened.
    expect(byId(comps, 'title').text).toEqual({ path: 'title' })
    expect(byId(comps, 'icon').name).toBe('check-circle')
  })

  it('remaps a non-"root" root component id to "root"', () => {
    const msgs = commandsToA2uiMessages(
      [
        {
          name: A2UI_CREATE_SURFACE,
          args: {
            surfaceId: 's',
            root: 'card',
            components: [
              { id: 'card', component: 'Card', child: 'txt' },
              { id: 'txt', component: 'Text', text: 'hi' },
            ],
          },
        },
      ],
      'cat',
    )
    const comps = updateComponents(msgs)
    expect(byId(comps, 'root').component).toBe('Card') // renamed
    expect(byId(comps, 'card').component).toBeUndefined() // old id gone
  })

  it('stamps the registered catalogId onto createSurface', () => {
    const msgs = commandsToA2uiMessages(
      [{ name: A2UI_CREATE_SURFACE, args: { surfaceId: 's', components: [] } }],
      'CAT-XYZ',
    )
    const create = msgs.find(m => 'createSurface' in m) as
      | { createSurface: { catalogId: string } }
      | undefined
    expect(create?.createSurface.catalogId).toBe('CAT-XYZ')
  })

  it('expands update_data_model `patches` into one updateDataModel per pointer', () => {
    // The tool advertises patches:[{pointer,value}]; the action loop relies on
    // these reaching web_core as canonical single-pointer updates.
    const msgs = commandsToA2uiMessages(
      [
        {
          name: A2UI_UPDATE_DATA_MODEL,
          args: {
            surfaceId: 's',
            patches: [
              { pointer: '/form/name', value: 'Ada' },
              { pointer: '/status', value: 'ok' },
            ],
          },
        },
      ],
      'cat',
    )
    const updates = msgs
      .map(
        m =>
          (m as { updateDataModel?: { surfaceId: string; path?: string; value?: unknown } })
            .updateDataModel,
      )
      .filter(Boolean) as Array<{ surfaceId: string; path?: string; value?: unknown }>
    expect(updates).toHaveLength(2)
    expect(updates[0]).toEqual({ surfaceId: 's', path: '/form/name', value: 'Ada' })
    expect(updates[1]).toEqual({ surfaceId: 's', path: '/status', value: 'ok' })
  })

  it('still supports a single {path,value} update_data_model', () => {
    const msgs = commandsToA2uiMessages(
      [{ name: A2UI_UPDATE_DATA_MODEL, args: { surfaceId: 's', path: '/x', value: 1 } }],
      'cat',
    )
    const update = msgs.find(m => 'updateDataModel' in m) as
      | { updateDataModel: { surfaceId: string; path?: string; value?: unknown } }
      | undefined
    expect(update?.updateDataModel).toEqual({ surfaceId: 's', path: '/x', value: 1 })
  })

  it('shallow-merges `merge` per key instead of replacing the whole data model', () => {
    // A PATHLESS updateDataModel replaces the entire root in web_core, so a
    // `merge` must expand into one single-pointer write per key — otherwise it
    // wipes every untouched field. Keys are RFC-6901 escaped.
    const msgs = commandsToA2uiMessages(
      [
        {
          name: A2UI_UPDATE_DATA_MODEL,
          args: { surfaceId: 's', merge: { status: 'ok', 'a/b': 1 } },
        },
      ],
      'cat',
    )
    const updates = msgs
      .map(
        m =>
          (m as { updateDataModel?: { surfaceId: string; path?: string; value?: unknown } })
            .updateDataModel,
      )
      .filter(Boolean) as Array<{ surfaceId: string; path?: string; value?: unknown }>

    // No root-replacing (pathless / "/") update is emitted.
    expect(
      updates.every(u => typeof u.path === 'string' && u.path !== '/' && u.path !== ''),
    ).toBe(true)
    expect(updates).toContainEqual({ surfaceId: 's', path: '/status', value: 'ok' })
    // "a/b" must stay a single top-level key (escaped), not a nested /a/b path.
    expect(updates).toContainEqual({ surfaceId: 's', path: '/a~1b', value: 1 })
  })
})
