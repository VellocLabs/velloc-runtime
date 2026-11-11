/**
 * Provider mods (F-27): the manifest's `providers.<key>.status` block. It is
 * validated strictly: what is accepted and kept, and what refuses the provider
 * with the field named.
 */
import { describe, expect, it } from 'vitest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { USER_MODEL_FORMATS } from '../config/nexusModelConfig/userModels'
import {
  PROVIDER_STATUS_DEFAULT_LIST_LIMIT,
  PROVIDER_STATUS_MAX_FIELDS,
  PROVIDER_STATUS_MAX_LIST_LIMIT,
} from '../mods/provider/providerStatusManifest'

/** Any wire format the manifest accepts; these tests do not depend on which. */
const WIRE = USER_MODEL_FORMATS[0]

function check(over: Record<string, unknown> = {}) {
  const { manifest, errors } = checkPluginDescriptor({
    name: 'acme',
    version: '1.0.0',
    providers: {
      main: {
        providerApi: 1,
        displayName: 'Acme',
        defaultBaseUrl: 'https://api.acme.test/v1',
        domains: ['api.acme.test'],
        format: WIRE,
        credentials: { methods: ['apiKey'] },
        module: './providers/main.js',
        ...over,
      },
    },
  })
  return { provider: manifest?.providers?.main, errors }
}

const view = (over: Record<string, unknown> = {}) => ({
  source: { store: 'status' },
  fields: [
    { key: 'state', label: { en: 'Status', 'zh-CN': '状态' }, format: 'badge' },
    { key: 'exposed', label: 'Exposed', format: 'count' },
    { key: 'lastProbe', label: 'Last probe', format: 'time' },
    { key: 'took', label: 'Took', format: 'duration' },
    { key: 'health', label: 'Health', format: 'percent' },
    { key: 'lastError', label: 'Last error', format: 'text' },
    {
      key: 'decisions',
      label: 'Recent decisions',
      format: 'list',
      columns: [
        { key: 'at', format: 'time' },
        { key: 'target', format: 'text', label: { en: 'Target' } },
        { key: 'reason', format: 'text' },
      ],
      limit: 50,
    },
  ],
  ...over,
})

describe('manifest status view: accepted', () => {
  it('a provider without the block is as before: no status, no error', () => {
    const { provider, errors } = check()
    expect(errors).toEqual([])
    expect(provider).toBeDefined()
    expect(provider && 'status' in provider).toBe(false)
  })

  it('keeps every format, the list columns and the limit as written', () => {
    const { provider, errors } = check({ status: view() })
    expect(errors).toEqual([])
    expect(provider?.status?.source).toEqual({ store: 'status' })
    expect(provider?.status?.fields.map(field => field.format)).toEqual([
      'badge', 'count', 'time', 'duration', 'percent', 'text', 'list',
    ])
    expect(provider?.status?.fields[6]).toEqual({
      key: 'decisions',
      label: 'Recent decisions',
      format: 'list',
      columns: [
        { key: 'at', format: 'time' },
        { key: 'target', format: 'text', label: { en: 'Target' } },
        { key: 'reason', format: 'text' },
      ],
      limit: 50,
    })
    expect(provider?.status?.actions).toBeUndefined()
  })

  it('a list without a limit gets the default', () => {
    const { provider } = check({
      status: view({ fields: [{ key: 'rows', label: 'Rows', format: 'list', columns: [{ key: 'a', format: 'text' }] }] }),
    })
    expect(provider?.status?.fields[0]).toMatchObject({ limit: PROVIDER_STATUS_DEFAULT_LIST_LIMIT })
  })

  it('an action names a job the same provider declares', () => {
    const { provider, errors } = check({
      jobs: [{ id: 'probe', everyMs: 1_800_000 }],
      status: view({ actions: [{ label: { en: 'Probe now' }, job: 'probe' }] }),
    })
    expect(errors).toEqual([])
    expect(provider?.status?.actions).toEqual([{ label: { en: 'Probe now' }, job: 'probe' }])
  })
})

describe('manifest status view: refused, naming the field', () => {
  const refused = (status: unknown, expected: string, extra: Record<string, unknown> = {}) => {
    const { provider, errors } = check({ ...extra, status })
    expect(provider).toBeUndefined()
    expect(errors.join('\n')).toContain(expected)
  }

  it('a block that is not an object', () => refused([], 'providers.main.status: expected an object'))

  it('an unknown property at any level', () => {
    refused(view({ html: '<b>x</b>' }), 'providers.main.status: unknown property "html"')
    refused(view({ source: { store: 'status', path: 'a.b' } }), 'providers.main.status.source: unknown property "path"')
    refused(
      view({ fields: [{ key: 'a', label: 'A', format: 'text', render: 'x' }] }),
      'providers.main.status.fields[0]: unknown property "render"',
    )
    refused(
      view({ fields: [{ key: 'l', label: 'L', format: 'list', columns: [{ key: 'a', format: 'text', width: 3 }] }] }),
      'providers.main.status.fields[0].columns[0]: unknown property "width"',
    )
  })

  it('a missing or empty source', () => {
    refused({ fields: view().fields }, 'providers.main.status.source: required')
    refused(view({ source: { store: ' ' } }), 'providers.main.status.source.store: required')
    refused(view({ source: { store: 7 } }), 'providers.main.status.source.store: required')
  })

  it('no fields, or too many', () => {
    refused(view({ fields: [] }), 'providers.main.status.fields: required')
    const many = Array.from({ length: PROVIDER_STATUS_MAX_FIELDS + 1 }, (_, i) => ({ key: `k${i}`, label: 'K', format: 'text' }))
    refused(view({ fields: many }), `a list of 1 to ${PROVIDER_STATUS_MAX_FIELDS} fields`)
  })

  it('a format outside the closed set, a misspelt one included', () => {
    refused(view({ fields: [{ key: 'a', label: 'A', format: 'html' }] }), 'providers.main.status.fields[0].format: expected one of text / count')
    refused(view({ fields: [{ key: 'a', label: 'A', format: 'Text' }] }), 'providers.main.status.fields[0].format')
  })

  it('a bad key, a repeated key, a missing label', () => {
    refused(view({ fields: [{ key: '__proto__.x', label: 'A', format: 'text' }] }), 'providers.main.status.fields[0].key: required')
    refused(view({ fields: [{ key: '9a', label: 'A', format: 'text' }] }), 'providers.main.status.fields[0].key: required')
    refused(
      view({ fields: [{ key: 'a', label: 'A', format: 'text' }, { key: 'a', label: 'B', format: 'count' }] }),
      'providers.main.status.fields[1].key: "a" is used twice',
    )
    refused(view({ fields: [{ key: 'a', format: 'text' }] }), 'providers.main.status.fields[0].label')
  })

  it('columns or a limit on a field that is not a list', () => {
    refused(
      view({ fields: [{ key: 'a', label: 'A', format: 'text', columns: [{ key: 'x', format: 'text' }] }] }),
      'providers.main.status.fields[0].columns: only a "list" field has columns',
    )
    refused(view({ fields: [{ key: 'a', label: 'A', format: 'count', limit: 3 }] }), 'providers.main.status.fields[0].limit: only a "list" field has a limit')
  })

  it('a list without columns, with a bare-string column, a nested list, or a limit out of range', () => {
    refused(view({ fields: [{ key: 'l', label: 'L', format: 'list' }] }), 'providers.main.status.fields[0].columns: a "list" field needs 1 to 6 columns')
    refused(
      view({ fields: [{ key: 'l', label: 'L', format: 'list', columns: ['at', 'target'] }] }),
      'providers.main.status.fields[0].columns[0]: expected an object { key, format }',
    )
    refused(
      view({ fields: [{ key: 'l', label: 'L', format: 'list', columns: [{ key: 'inner', format: 'list' }] }] }),
      'providers.main.status.fields[0].columns[0].format: expected one of text / count / time / duration / percent / badge',
    )
    for (const limit of [0, 1.5, PROVIDER_STATUS_MAX_LIST_LIMIT + 1, '50']) {
      refused(
        view({ fields: [{ key: 'l', label: 'L', format: 'list', columns: [{ key: 'a', format: 'text' }], limit }] }),
        `providers.main.status.fields[0].limit: expected a whole number from 1 to ${PROVIDER_STATUS_MAX_LIST_LIMIT}`,
      )
    }
  })

  it('an action whose job the provider does not declare, a callback, a second button for one job', () => {
    refused(view({ actions: [{ label: 'Probe now', job: 'probe' }] }), 'providers.main.status.actions[0].job: "probe" is not a job this provider declares')
    refused(
      view({ actions: [{ label: 'Probe now', job: 'other' }] }),
      'providers.main.status.actions[0].job: "other" is not a job this provider declares',
      { jobs: [{ id: 'probe' }] },
    )
    refused(
      view({ actions: [{ label: 'Go', job: 'probe', run: 'alert(1)' }] }),
      'providers.main.status.actions[0]: unknown property "run"',
      { jobs: [{ id: 'probe' }] },
    )
    refused(
      view({ actions: [{ label: 'A', job: 'probe' }, { label: 'B', job: 'probe' }] }),
      'providers.main.status.actions[1].job: "probe" has a button already',
      { jobs: [{ id: 'probe' }] },
    )
    refused(view({ actions: [{ job: 'probe' }] }), 'providers.main.status.actions[0].label', { jobs: [{ id: 'probe' }] })
  })

  it('refuses only that provider: a sibling with a good manifest is kept', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'acme',
      version: '1.0.0',
      providers: Object.fromEntries(
        ['good', 'bad'].map(key => [
          key,
          {
            providerApi: 1,
            displayName: 'Acme',
            defaultBaseUrl: 'https://api.acme.test/v1',
            domains: ['api.acme.test'],
            format: WIRE,
            credentials: { methods: ['apiKey'] },
            module: './providers/main.js',
            ...(key === 'bad' ? { status: { source: { store: 's' }, fields: [{ key: 'a', label: 'A', format: 'nope' }] } } : {}),
          },
        ]),
      ),
    })
    expect(Object.keys(manifest?.providers ?? {})).toEqual(['good'])
    expect(errors.join('\n')).toContain('providers.bad.status.fields[0].format')
  })
})
