import { describe, expect, it } from 'vitest'

import type { BrowserLlmCatalog } from '../browser/bridge/protocol/nexus_llm'
import type { ImportSource } from '../browser/bridge/protocol/sessionImport'
import {
  IMPORT_SOURCE_META,
  topbarImportEntries,
} from '../browser/webview/sessionImport/sourceMeta'

const [FIRST, SECOND] = Object.keys(IMPORT_SOURCE_META) as ImportSource[]
const SOURCES: Array<{ source: ImportSource }> = [{ source: FIRST }, { source: SECOND }]
const iconId = (source: ImportSource) => IMPORT_SOURCE_META[source].providerIconId

function catalogWith(providers: Array<{ id: string; iconSvg?: string }>): BrowserLlmCatalog {
  return { providers: providers as unknown as BrowserLlmCatalog['providers'] }
}

describe('topbarImportEntries', () => {
  it('shows no import buttons before the catalog arrives', () => {
    expect(topbarImportEntries(null, SOURCES)).toEqual([])
    expect(topbarImportEntries(undefined, SOURCES)).toEqual([])
  })

  it('shows no import buttons while the catalog has no providers', () => {
    expect(topbarImportEntries(catalogWith([]), SOURCES)).toEqual([])
  })

  it('carries each source brand mark once the catalog is populated', () => {
    const entries = topbarImportEntries(
      catalogWith([
        { id: iconId(FIRST), iconSvg: '<svg id="a"/>' },
        { id: iconId(SECOND), iconSvg: '<svg id="o"/>' },
      ]),
      SOURCES,
    )
    expect(entries.map(e => [e.source, e.iconSvg])).toEqual([
      [FIRST, '<svg id="a"/>'],
      [SECOND, '<svg id="o"/>'],
    ])
    expect(entries.every(e => e.label.length > 0)).toBe(true)
  })

  it('keeps the button without a mark when a populated catalog lacks the provider', () => {
    const entries = topbarImportEntries(catalogWith([{ id: 'other', iconSvg: '<svg/>' }]), SOURCES)
    expect(entries).toHaveLength(2)
    expect(entries.every(e => e.iconSvg === undefined)).toBe(true)
  })
})
