import { beforeEach, describe, expect, it } from 'vitest'
import {
  hostModelIdsFor,
  publishHostModelCatalog,
  resetHostModelCatalog,
} from '../config/hostModelCatalog'

const provider = (
  id: string,
  models: Array<{ id: string; enabled?: boolean; pickerAliasId?: string }>,
  enabled = true,
) => ({
  id,
  label: id,
  iconSvg: '',
  enabled,
  models: models.map(m => ({
    id: m.id,
    label: m.id,
    enabled: m.enabled ?? true,
    ...(m.pickerAliasId ? { pickerAliasId: m.pickerAliasId } : {}),
  })),
})

beforeEach(resetHostModelCatalog)

describe('hostModelCatalog', () => {
  it('is empty until a catalog is published', () => {
    expect(hostModelIdsFor('anthropic')).toEqual([])
  })

  it('reports exactly the ids the quick picker would show', () => {
    // Same visibility rule as `ModelQuickPicker`: a disabled row is not
    // pickable, and an alias-hidden snapshot row duplicates its curated twin.
    publishHostModelCatalog({
      providers: [
        provider('anthropic', [
          { id: 'claude-opus-5' },
          { id: 'claude-sonnet-5' },
          { id: 'claude-sonnet-5-20260101', pickerAliasId: 'claude-sonnet-5' },
          { id: 'claude-haiku-4-5', enabled: false },
        ]),
      ],
    })
    expect(hostModelIdsFor('anthropic')).toEqual(['claude-opus-5', 'claude-sonnet-5'])
  })

  it('skips a provider that is not set up', () => {
    publishHostModelCatalog({
      providers: [provider('openai', [{ id: 'gpt-5.6' }], false)],
    })
    expect(hostModelIdsFor('openai')).toEqual([])
  })

  it('replaces the whole map, so a removed provider stops being reported', () => {
    publishHostModelCatalog({ providers: [provider('openai', [{ id: 'gpt-5.6' }])] })
    publishHostModelCatalog({ providers: [provider('anthropic', [{ id: 'claude-opus-5' }])] })
    expect(hostModelIdsFor('openai')).toEqual([])
    expect(hostModelIdsFor('anthropic')).toEqual(['claude-opus-5'])
  })

  it('IGNORES an empty or missing catalog rather than blanking a good one', () => {
    // Mirrors AgentModelController's "only adopt a populated catalog" rule: an
    // empty result means the broker was not ready, and adopting it would make
    // the team survey report "no models" for a provider full of them.
    publishHostModelCatalog({ providers: [provider('anthropic', [{ id: 'claude-opus-5' }])] })
    publishHostModelCatalog({ providers: [] })
    publishHostModelCatalog(null)
    publishHostModelCatalog(undefined)
    expect(hostModelIdsFor('anthropic')).toEqual(['claude-opus-5'])
  })
})
