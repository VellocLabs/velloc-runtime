import { describe, expect, it } from 'vitest'
import {
  listingHasModel,
  modelAvailability,
  pickerModelIds,
} from '../browser/webview/settings/providerModelAvailability'

// The settings home page's "N models available": which models count, when a
// listing confirms them, and how a curated id meets a vendor's listing.

describe('provider model availability', () => {
  it('counts the picker models: enabled rows, no alias rows', () => {
    expect(pickerModelIds({
      providers: [{
        id: 'p', label: 'P', iconSvg: '', enabled: true,
        models: [
          { id: 'a', label: 'A', enabled: true },
          { id: 'b', label: 'B', enabled: false },
          { id: 'a-20250101', label: 'A', enabled: true, pickerAliasId: 'a' },
        ],
      }],
    }, 'p')).toEqual(['a'])
    expect(pickerModelIds(undefined, 'p')).toEqual([])
  })

  it('a curated id matches exactly, behind models/, or as a dated / versioned snapshot — never a longer name', () => {
    const listed = new Set(['models/gemini-3-pro', 'claude-haiku-4-5-20251001', 'gpt-6-astra', 'qwen3.8-max-2026-07-01'])
    expect(listingHasModel('gemini-3-pro', listed, false)).toBe(true)
    expect(listingHasModel('claude-haiku-4-5', listed, false)).toBe(true)
    expect(listingHasModel('qwen3.8-max', listed, false)).toBe(true)
    expect(listingHasModel('GPT-6-Astra', listed, false)).toBe(true)
    // `gpt-6` is not `gpt-6-astra`: a snapshot suffix starts with a digit.
    expect(listingHasModel('gpt-6', listed, false)).toBe(false)
    // A pick from a gateway / custom endpoint listing matches verbatim only.
    expect(listingHasModel('claude-haiku-4-5', listed, true)).toBe(false)
    expect(listingHasModel('gpt-6-astra', listed, true)).toBe(true)
  })

  it('only a fetched, non-empty, well-formed listing confirms a count', () => {
    const picker = ['a', 'b']
    expect(modelAvailability(picker, undefined, true)).toEqual({ count: 2, confirmed: false })
    expect(modelAvailability(picker, { ok: false, error: 'x' }, true)).toEqual({ count: 2, confirmed: false })
    expect(modelAvailability(picker, { ok: true, ids: [] }, true)).toEqual({ count: 2, confirmed: false })
    expect(modelAvailability(picker, {} as never, true)).toEqual({ count: 2, confirmed: false })
    expect(modelAvailability(picker, { ok: true, ids: ['b', 'c'] }, true)).toEqual({ count: 1, confirmed: true })
    expect(modelAvailability(picker, { ok: true, ids: ['c'] }, true)).toEqual({ count: 0, confirmed: true })
  })
})
