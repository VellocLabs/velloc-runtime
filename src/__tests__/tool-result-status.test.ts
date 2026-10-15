import { describe, expect, it } from 'vitest'
import { toolResultIndicatesSoftFailure } from '../utils/toolResultStatus'

describe('toolResultIndicatesSoftFailure', () => {
  it('returns false for null/undefined', () => {
    expect(toolResultIndicatesSoftFailure(null)).toBe(false)
    expect(toolResultIndicatesSoftFailure(undefined)).toBe(false)
  })

  it('returns false for non-object primitives that fail to JSON-parse', () => {
    expect(toolResultIndicatesSoftFailure(42)).toBe(false)
    expect(toolResultIndicatesSoftFailure('plain string')).toBe(false)
  })

  it('returns true on top-level ok:false (browser_actions error envelope shape)', () => {
    expect(
      toolResultIndicatesSoftFailure({
        ok: false,
        error: { code: 'MISSING_ACTIONS_KEY', message: '...' },
      }),
    ).toBe(true)
  })

  it('returns false when ok is true, regardless of nested content', () => {
    expect(
      toolResultIndicatesSoftFailure({
        ok: true,
        observation: { elements: [] },
      }),
    ).toBe(false)
  })

  it('returns true when any inner results[].result.ok === false', () => {
    expect(
      toolResultIndicatesSoftFailure({
        ok: true,
        results: [
          { action: 'click', result: { ok: true } },
          {
            action: 'click',
            result: {
              ok: false,
              error: 'actor_error_20: element offscreen',
            },
          },
        ],
      }),
    ).toBe(true)
  })

  it('parses string-encoded JSON bodies (the C++ bridge sends a serialized JSON string)', () => {
    expect(
      toolResultIndicatesSoftFailure(
        JSON.stringify({
          ok: false,
          error: { code: 'MISSING_ACTIONS_KEY', message: '...' },
        }),
      ),
    ).toBe(true)
  })

  it('returns false on malformed JSON strings', () => {
    expect(toolResultIndicatesSoftFailure('{not json')).toBe(false)
  })

  it('returns false for browser_actions success shape', () => {
    expect(
      toolResultIndicatesSoftFailure({
        action: 'browser_actions',
        ok: true,
        stop_reason: 'complete',
        observation: { tab_id: 1 },
        results: [{ action: 'click', result: { ok: true } }],
      }),
    ).toBe(false)
  })
})
