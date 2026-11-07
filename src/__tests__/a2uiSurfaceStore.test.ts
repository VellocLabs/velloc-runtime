import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import {
  A2UI_CREATE_SURFACE,
  A2UI_DELETE_SURFACE,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
} from '../toolkit/builtin/a2ui/a2uiToolNames'
import { deriveA2uiPresentation } from '../browser/webview/a2ui/surfaceStore'

describe('deriveA2uiPresentation (inline move-to-latest)', () => {
  function call(toolCallId: string, name: string, surfaceId: string): Message {
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId, toolName: name, args: { surfaceId } }],
      },
    } as unknown as Message
  }

  it('marks only the LATEST tool-call per surface as live (older → breadcrumb)', () => {
    const { latestToolCallIdBySurface, deletedSurfaceIds } = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('c2', A2UI_CREATE_SURFACE, 'beta'),
      call('u1', A2UI_UPDATE_COMPONENTS, 'alpha'),
    ])
    // alpha's live position is the update (u1), not the create (c1).
    expect(latestToolCallIdBySurface.get('alpha')).toBe('u1')
    expect(latestToolCallIdBySurface.get('beta')).toBe('c2')
    expect(deletedSurfaceIds.size).toBe(0)
  })

  it('flags a deleted surface (no live position); a re-create revives it', () => {
    const deleted = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('d1', A2UI_DELETE_SURFACE, 'alpha'),
    ])
    expect(deleted.deletedSurfaceIds.has('alpha')).toBe(true)
    expect(deleted.latestToolCallIdBySurface.has('alpha')).toBe(false)

    const revived = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('d1', A2UI_DELETE_SURFACE, 'alpha'),
      call('c2', A2UI_CREATE_SURFACE, 'alpha'),
    ])
    expect(revived.deletedSurfaceIds.has('alpha')).toBe(false)
    expect(revived.latestToolCallIdBySurface.get('alpha')).toBe('c2')
  })

  it('keeps a deleted surface deleted on a later update_* (only a re-create revives)', () => {
    // A delete is a tombstone: a subsequent update_data_model / update_components
    // must NOT resurrect the surface at a new render position (the processor has
    // already removed it, so it would render a half-built/empty surface).
    const afterDataUpdate = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('d1', A2UI_DELETE_SURFACE, 'alpha'),
      call('u1', A2UI_UPDATE_DATA_MODEL, 'alpha'),
    ])
    expect(afterDataUpdate.deletedSurfaceIds.has('alpha')).toBe(true)
    expect(afterDataUpdate.latestToolCallIdBySurface.has('alpha')).toBe(false)

    const afterComponentUpdate = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('d1', A2UI_DELETE_SURFACE, 'alpha'),
      call('u1', A2UI_UPDATE_COMPONENTS, 'alpha'),
    ])
    expect(afterComponentUpdate.deletedSurfaceIds.has('alpha')).toBe(true)
    expect(afterComponentUpdate.latestToolCallIdBySurface.has('alpha')).toBe(false)

    // A re-create (not an update) DOES revive it at the new position.
    const revived = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('d1', A2UI_DELETE_SURFACE, 'alpha'),
      call('u1', A2UI_UPDATE_DATA_MODEL, 'alpha'),
      call('c2', A2UI_CREATE_SURFACE, 'alpha'),
    ])
    expect(revived.deletedSurfaceIds.has('alpha')).toBe(false)
    expect(revived.latestToolCallIdBySurface.get('alpha')).toBe('c2')
  })

  it('moves the surface to the latest data-model update (older positions → breadcrumb)', () => {
    const { latestToolCallIdBySurface } = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'counter'),
      call('d1', A2UI_UPDATE_DATA_MODEL, 'counter'),
      call('d2', A2UI_UPDATE_DATA_MODEL, 'counter'),
    ])
    // A data patch (e.g. a counter increment) relocates the surface to its
    // newest tool-call position; the create + earlier update render breadcrumbs.
    expect(latestToolCallIdBySurface.get('counter')).toBe('d2')
  })
})

describe('latestA2uiMentionTime', () => {
  it('reads the timestamp of the newest assistant message with an a2ui tool-call', async () => {
    const { latestA2uiMentionTime } = await import('../browser/webview/a2ui/surfaceStore')
    const call = (id: string) => ({ type: 'tool-call', toolCallId: id, toolName: 'a2ui_create_surface', args: { surfaceId: 's' } })
    const messages = [
      { type: 'assistant', timestamp: '2026-11-07T00:00:00Z', message: { content: [call('a')] } },
      { type: 'assistant', timestamp: '2026-11-07T00:05:00Z', message: { content: [call('b')] } },
      { type: 'assistant', timestamp: '2026-11-07T00:09:00Z', message: { content: [{ type: 'text', text: 'done' }] } },
    ]
    expect(latestA2uiMentionTime(messages as never)).toBe(Date.parse('2026-11-07T00:05:00Z'))
    expect(latestA2uiMentionTime([] as never)).toBeNull()
  })

  it('reads a tool-call named by `name` when `toolName` is not a string', async () => {
    const { latestA2uiMentionTime } = await import('../browser/webview/a2ui/surfaceStore')
    const messages = [
      { type: 'assistant', timestamp: '2026-11-07T00:05:00Z', message: { content: [{ type: 'tool-call', toolName: null, name: 'a2ui_create_surface' }] } },
    ]
    expect(latestA2uiMentionTime(messages as never)).toBe(Date.parse('2026-11-07T00:05:00Z'))
  })
})

describe('isRecentMention', () => {
  it('counts a mention within two minutes as live, and an older or missing one as replay', async () => {
    const { isRecentMention } = await import('../browser/webview/a2ui/A2uiPresentationContext')
    const now = Date.parse('2026-11-07T00:10:00Z')
    expect(isRecentMention(now - 5_000, now)).toBe(true)
    expect(isRecentMention(now - 119_999, now)).toBe(true)
    expect(isRecentMention(now - 120_000, now)).toBe(false)
    expect(isRecentMention(now - 10 * 60_000, now)).toBe(false)
    expect(isRecentMention(null, now)).toBe(false)
  })
})
