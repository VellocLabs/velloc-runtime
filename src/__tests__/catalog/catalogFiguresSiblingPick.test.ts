/**
 * A built-in row with no exact catalog key reads the sibling the catalog's own
 * lookup picks, whatever order the document lists its records in (F-28).
 */
import { describe, expect, it } from 'vitest'
import { findNormalized, normalizeModelId } from '../../catalog/catalogMatch'
import {
  findCatalogFigures,
  type CatalogFigureLayer,
  type CatalogModelFigures,
} from '../../config/nexusModelConfig/catalogFigures'

const DATED: CatalogModelFigures = { contextWindow: 200_000 } as CatalogModelFigures
const UNDATED: CatalogModelFigures = { contextWindow: 1_000_000 } as CatalogModelFigures

describe('catalog figures for a row reached by its normalized id', () => {
  it('read the same sibling in either document order, the one the catalog lookup picks', () => {
    const datedFirst: CatalogFigureLayer = new Map([
      ['acme-wide-5-5-20260901', DATED],
      ['acme-wide-5-5', UNDATED],
    ])
    const undatedFirst: CatalogFigureLayer = new Map([
      ['acme-wide-5-5', UNDATED],
      ['acme-wide-5-5-20260901', DATED],
    ])
    expect(findCatalogFigures([datedFirst], 'acme-wide-5.5')).toBe(UNDATED)
    expect(findCatalogFigures([undatedFirst], 'acme-wide-5.5')).toBe(UNDATED)

    const records = Object.fromEntries([...datedFirst.keys()].map(id => [id, {}]))
    expect(findNormalized(records as never, normalizeModelId('acme-wide-5.5'))).toBe('acme-wide-5-5')
  })

  it('an exact key still answers before any sibling', () => {
    const layer: CatalogFigureLayer = new Map([
      ['acme-wide-5-5', UNDATED],
      ['acme-wide-5-5-20260901', DATED],
    ])
    expect(findCatalogFigures([layer], 'acme-wide-5-5-20260901')).toBe(DATED)
  })
})
