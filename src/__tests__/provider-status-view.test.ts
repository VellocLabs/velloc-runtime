/**
 * Provider mods (F-27): shaping a status view from a stored value. The store
 * is untrusted: only declared keys through their declared formats, text cut,
 * lists cut, and one entry's text bounded.
 */
import { describe, expect, it } from 'vitest'
import type { ProviderStatusView } from '../mods/provider/providerStatusManifest'
import { PROVIDER_STATUS_ENTRY_TEXT_BUDGET, PROVIDER_STATUS_TEXT_MAX } from '../mods/provider/providerStatusState'
import { shapeProviderStatus, shapeStatusValue } from '../mods/provider/providerStatusView'

const VIEW: ProviderStatusView = {
  source: { store: 'status' },
  fields: [
    { key: 'state', label: 'Status', format: 'badge' },
    { key: 'exposed', label: 'Exposed', format: 'count' },
    { key: 'lastProbe', label: 'Last probe', format: 'time' },
    { key: 'took', label: 'Took', format: 'duration' },
    { key: 'health', label: 'Health', format: 'percent' },
    { key: 'lastError', label: 'Last error', format: 'text' },
    {
      key: 'decisions',
      label: 'Recent decisions',
      format: 'list',
      columns: [{ key: 'at', format: 'time' }, { key: 'target', format: 'text' }],
      limit: 3,
    },
  ],
  actions: [{ label: 'Probe now', job: 'probe' }],
}

const cellOf = (entry: ReturnType<typeof shapeProviderStatus>, key: string) => {
  const row = entry.rows.find(r => r.key === key)
  return row?.kind === 'value' ? row.cell : undefined
}

describe('shapeProviderStatus', () => {
  it('shapes each declared field through its format, in the declared order', () => {
    const entry = shapeProviderStatus(
      VIEW,
      {
        state: { text: 'Healthy', tone: 'ok' },
        exposed: 12.9,
        lastProbe: '2026-11-10T08:00:00Z',
        took: 1530.7,
        health: 97.5,
        lastError: 'HTTP 503',
        decisions: [{ at: 1_800_000_000_000, target: 'a' }],
        notDeclared: 'never shown',
      },
      42,
    )
    expect(entry.readAt).toBe(42)
    expect(entry.empty).toBeUndefined()
    expect(entry.rows.map(row => row.key)).toEqual(VIEW.fields.map(field => field.key))
    expect(cellOf(entry, 'state')).toEqual({ format: 'badge', text: 'Healthy', tone: 'ok' })
    expect(cellOf(entry, 'exposed')).toEqual({ format: 'count', value: 12 })
    expect(cellOf(entry, 'lastProbe')).toEqual({ format: 'time', at: Date.parse('2026-11-10T08:00:00Z') })
    expect(cellOf(entry, 'took')).toEqual({ format: 'duration', ms: 1530 })
    expect(cellOf(entry, 'health')).toEqual({ format: 'percent', value: 97.5 })
    expect(cellOf(entry, 'lastError')).toEqual({ format: 'text', text: 'HTTP 503' })
    expect(entry.rows[6]).toMatchObject({
      kind: 'list',
      total: 1,
      items: [[{ format: 'time', at: 1_800_000_000_000 }, { format: 'text', text: 'a' }]],
    })
    expect(JSON.stringify(entry)).not.toContain('never shown')
    expect(entry.actions).toEqual([{ job: 'probe', label: 'Probe now' }])
  })

  it('a store with nothing under the key: every row without a value, marked empty', () => {
    for (const stored of [undefined, null, 'text', 7, ['a']]) {
      const entry = shapeProviderStatus(VIEW, stored, 1)
      expect(entry.empty).toBe(true)
      expect(entry.rows).toHaveLength(VIEW.fields.length)
      expect(entry.rows.every(row => (row.kind === 'value' ? row.cell === undefined : row.items.length === 0))).toBe(true)
    }
  })

  it('a value of the wrong type is dropped, never coerced into something else', () => {
    const entry = shapeProviderStatus(
      VIEW,
      {
        state: { tone: 'ok' },
        exposed: '12',
        lastProbe: 'yesterday',
        took: -5,
        health: Number.NaN,
        lastError: { toString: 'x' },
        decisions: { length: 3 },
      },
      1,
    )
    for (const key of ['state', 'exposed', 'lastProbe', 'took', 'health', 'lastError']) expect(cellOf(entry, key)).toBeUndefined()
    expect(entry.rows[6]).toMatchObject({ kind: 'list', items: [], total: 0 })
  })

  it('reads own properties only', () => {
    const stored = Object.create({ lastError: 'inherited' }) as Record<string, unknown>
    stored.exposed = 1
    const entry = shapeProviderStatus(VIEW, stored, 1)
    expect(cellOf(entry, 'lastError')).toBeUndefined()
    expect(cellOf(entry, 'exposed')).toEqual({ format: 'count', value: 1 })
  })

  it('cuts text to the fixed length and replaces control characters', () => {
    const long = shapeStatusValue('text', 'x'.repeat(PROVIDER_STATUS_TEXT_MAX + 200))
    expect(long?.format === 'text' && long.text.length).toBe(PROVIDER_STATUS_TEXT_MAX)
    expect(long?.format === 'text' && long.text.endsWith('…')).toBe(true)
    const odd = shapeStatusValue('text', `a${String.fromCharCode(0)}b${String.fromCharCode(0x1b)}[31mc${String.fromCharCode(0x2028)}d\ne`)
    expect(odd).toEqual({ format: 'text', text: 'a b [31mc d\ne' })
    expect(shapeStatusValue('text', '   ')).toBeUndefined()
    expect(shapeStatusValue('text', '<img src=x onerror=alert(1)>')).toEqual({ format: 'text', text: '<img src=x onerror=alert(1)>' })
  })

  it('clamps numbers: a percent to 0..100, a tone to the known set, a time to a real date', () => {
    expect(shapeStatusValue('percent', 250)).toEqual({ format: 'percent', value: 100 })
    expect(shapeStatusValue('percent', -3)).toEqual({ format: 'percent', value: 0 })
    expect(shapeStatusValue('badge', { text: 'x', tone: 'bg-red-500 animate-ping' })).toEqual({ format: 'badge', text: 'x', tone: 'neutral' })
    expect(shapeStatusValue('badge', 'plain')).toEqual({ format: 'badge', text: 'plain', tone: 'neutral' })
    expect(shapeStatusValue('time', 1e20)).toBeUndefined()
    expect(shapeStatusValue('time', 0)).toBeUndefined()
    expect(shapeStatusValue('count', Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('cuts a list to the field limit, keeps the true total, and skips rows that are not objects or hold nothing', () => {
    const rows = [
      'junk',
      { other: 1 },
      ...Array.from({ length: 10 }, (_, i) => ({ at: 1_800_000_000_000 + i, target: `t${i}` })),
    ]
    const entry = shapeProviderStatus(VIEW, { decisions: rows }, 1)
    const list = entry.rows[6]
    expect(list?.kind === 'list' && list.items).toHaveLength(3)
    expect(list?.kind === 'list' && list.total).toBe(12)
    expect(list?.kind === 'list' && list.items[0]?.[1]).toEqual({ format: 'text', text: 't0' })
  })

  it('stops adding list rows once the entry holds its budget of text', () => {
    const view: ProviderStatusView = {
      source: { store: 's' },
      fields: [
        { key: 'a', label: 'A', format: 'list', columns: [{ key: 't', format: 'text' }], limit: 100 },
        { key: 'b', label: 'B', format: 'list', columns: [{ key: 't', format: 'text' }], limit: 100 },
      ],
    }
    const big = Array.from({ length: 100 }, () => ({ t: 'y'.repeat(PROVIDER_STATUS_TEXT_MAX) }))
    const entry = shapeProviderStatus(view, { a: big, b: big }, 1)
    const text = entry.rows.flatMap(row => (row.kind === 'list' ? row.items.flat() : [])).reduce(
      (sum, cell) => sum + (cell?.format === 'text' ? cell.text.length : 0),
      0,
    )
    expect(text).toBeLessThanOrEqual(PROVIDER_STATUS_ENTRY_TEXT_BUDGET + PROVIDER_STATUS_TEXT_MAX)
    const second = entry.rows[1]
    expect(second?.kind === 'list' && second.items.length).toBeLessThan(100)
    expect(second?.kind === 'list' && second.total).toBe(100)
  })
})
