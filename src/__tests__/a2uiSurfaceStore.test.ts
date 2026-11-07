import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import {
  A2UI_CREATE_SURFACE,
  A2UI_DELETE_SURFACE,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
} from '../toolkit/builtin/a2ui/a2uiToolNames'
import { deriveA2uiPresentation, extractA2uiSources, latestA2uiMentionTime } from '../browser/webview/a2ui/surfaceStore'
import { hasA2uiContent } from '../browser/webview/a2ui/hasA2uiSurface'
import { a2uiBlockKey } from '../toolkit/builtin/a2ui/express/a2uiBlocks'

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
    const { latestMentionBySurface, deletedSurfaceIds } = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('c2', A2UI_CREATE_SURFACE, 'beta'),
      call('u1', A2UI_UPDATE_COMPONENTS, 'alpha'),
    ])
    // alpha's live position is the update (u1), not the create (c1).
    expect(latestMentionBySurface.get('alpha')).toBe('u1')
    expect(latestMentionBySurface.get('beta')).toBe('c2')
    expect(deletedSurfaceIds.size).toBe(0)
  })

  it('flags a deleted surface (no live position); a re-create revives it', () => {
    const deleted = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('d1', A2UI_DELETE_SURFACE, 'alpha'),
    ])
    expect(deleted.deletedSurfaceIds.has('alpha')).toBe(true)
    expect(deleted.latestMentionBySurface.has('alpha')).toBe(false)

    const revived = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('d1', A2UI_DELETE_SURFACE, 'alpha'),
      call('c2', A2UI_CREATE_SURFACE, 'alpha'),
    ])
    expect(revived.deletedSurfaceIds.has('alpha')).toBe(false)
    expect(revived.latestMentionBySurface.get('alpha')).toBe('c2')
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
    expect(afterDataUpdate.latestMentionBySurface.has('alpha')).toBe(false)

    const afterComponentUpdate = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('d1', A2UI_DELETE_SURFACE, 'alpha'),
      call('u1', A2UI_UPDATE_COMPONENTS, 'alpha'),
    ])
    expect(afterComponentUpdate.deletedSurfaceIds.has('alpha')).toBe(true)
    expect(afterComponentUpdate.latestMentionBySurface.has('alpha')).toBe(false)

    // A re-create (not an update) DOES revive it at the new position.
    const revived = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'alpha'),
      call('d1', A2UI_DELETE_SURFACE, 'alpha'),
      call('u1', A2UI_UPDATE_DATA_MODEL, 'alpha'),
      call('c2', A2UI_CREATE_SURFACE, 'alpha'),
    ])
    expect(revived.deletedSurfaceIds.has('alpha')).toBe(false)
    expect(revived.latestMentionBySurface.get('alpha')).toBe('c2')
  })

  it('moves the surface to the latest data-model update (older positions → breadcrumb)', () => {
    const { latestMentionBySurface } = deriveA2uiPresentation([
      call('c1', A2UI_CREATE_SURFACE, 'counter'),
      call('d1', A2UI_UPDATE_DATA_MODEL, 'counter'),
      call('d2', A2UI_UPDATE_DATA_MODEL, 'counter'),
    ])
    // A data patch (e.g. a counter increment) relocates the surface to its
    // newest tool-call position; the create + earlier update render breadcrumbs.
    expect(latestMentionBySurface.get('counter')).toBe('d2')
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

describe('A2UI blocks in reply text', () => {
  const reply = (text: string, timestamp?: string): Message =>
    ({
      type: 'assistant',
      timestamp,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) as unknown as Message
  const form = 'surface("contact")\nroot = Text("Hi")'
  const update = 'surface("contact")\n$/x = 1'

  it('lists finished blocks as sources, in order, and skips one still being written', () => {
    const sources = extractA2uiSources([
      reply(`a\n<a2ui>\n${form}\n</a2ui>\nb`),
      reply('<a2ui>\nsurface("later")\nroot = Card('),
    ])
    expect(sources).toEqual([
      { kind: 'block', block: { body: form, targets: ['contact'], deletes: [] } },
    ])
  })

  it('places a surface at its latest block, and a deleteSurface line removes it', () => {
    const live = deriveA2uiPresentation([reply(`<a2ui>\n${form}\n</a2ui>`), reply(`<a2ui>\n${update}\n</a2ui>`)])
    expect(live.latestMentionBySurface.get('contact')).toBe(a2uiBlockKey('contact', update))
    const removed = deriveA2uiPresentation([
      reply(`<a2ui>\n${form}\n</a2ui>`),
      reply('<a2ui>\ndeleteSurface("contact")\n</a2ui>'),
    ])
    expect(removed.deletedSurfaceIds.has('contact')).toBe(true)
    expect(removed.latestMentionBySurface.has('contact')).toBe(false)
  })

  it('counts a reply with a block as an A2UI mention', () => {
    expect(latestA2uiMentionTime([reply(`<a2ui>\n${form}\n</a2ui>`, '2026-11-06T10:00:00.000Z')])).toBe(
      Date.parse('2026-11-06T10:00:00.000Z'),
    )
    expect(hasA2uiContent([reply(`<a2ui>\n${form}\n</a2ui>`)])).toBe(true)
    expect(hasA2uiContent([reply('no interface here')])).toBe(false)
  })
})
