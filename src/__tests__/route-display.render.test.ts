// @vitest-environment happy-dom
import { createElement, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

import { ModelQuickPicker } from '../browser/webview/ModelQuickPicker'
import { RouteMemberLabel, RouteSwitchNotice } from '../components/assistant-ui/route-lines'
import {
  RouteNamesContext,
  latestRoutedVia,
  liveRouteMemberReader,
  routeMemberName,
  routeNoticeKey,
} from '../browser/webview/routeDisplay'
import {
  convertBrowserRuntimeStateToThreadMessages,
  convertTranscriptToThreadMessages,
} from '../browser/webview/assistantUiAdapter'
import type { BrowserRuntimeClientState } from '../browser/webview/BrowserRuntimeClient'
import { prepareHistoryForModel } from '../messages/prepareModelHistory'
import { createTranslate } from '../browser/webview/i18n/translate'
import { en } from '../browser/webview/i18n/messages/en'
import type { BrowserLlmCatalog, BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import type { Message } from '../runtime/RuntimeTypes'

/**
 * A router's route in the conversation (F-27): its picker rows are marked as
 * routes and name the member that served the latest routed reply; each routed
 * reply names its member; a change of member is one quiet line ahead of the
 * reply, drawn from the reply's record and never sent to a model.
 */

afterEach(cleanup)

const t = createTranslate('en')

const provider = (id: string, label: string, models: Array<[string, string]>, kind?: 'router'): BrowserLlmProvider =>
  ({
    id,
    label,
    iconSvg: '',
    enabled: true,
    models: models.map(([mid, mlabel]) => ({ id: mid, label: mlabel, enabled: true })),
    ...(kind ? { mod: { state: 'ready', kind } } : {}),
  }) as BrowserLlmProvider

// Ids are opaque instance ids: nothing about them says "router".
const ROUTER = provider('inst-7f3a', 'Smart Route', [['auto', 'Auto']], 'router')
const ALPHA = provider('inst-a1', 'Alpha Cloud', [['alpha-large', 'Alpha Large']])
const BETA = provider('inst-b2', 'Beta Hosting', [['beta-small', 'Beta Small']])
const CATALOG = { providers: [ROUTER, ALPHA, BETA] } as unknown as BrowserLlmCatalog

function openPicker(routeMember?: { provider: string; model: string }, modelId = 'auto', providerId = ROUTER.id) {
  render(
    createElement(ModelQuickPicker, {
      catalog: CATALOG,
      selection: { providerId, modelId },
      onSelect: vi.fn(),
      routeMember,
    }),
  )
  fireEvent.click(screen.getByTestId('nexus-model-picker-trigger'))
}

describe('model picker: route rows', () => {
  it('marks a router row as a route and names the latest member', () => {
    openPicker({ provider: ALPHA.id, model: 'alpha-large' })
    expect(screen.getByTestId(`nexus-route-icon-${ROUTER.id}-auto`).getAttribute('aria-label')).toBe('Route')
    expect(screen.getByTestId(`nexus-route-member-${ROUTER.id}-auto`).textContent).toBe('via Alpha Large · Alpha Cloud')
  })

  it('shows the route with no member before any routed reply', () => {
    openPicker(undefined)
    expect(screen.getByTestId(`nexus-route-icon-${ROUTER.id}-auto`)).toBeTruthy()
    expect(screen.queryByTestId(`nexus-route-member-${ROUTER.id}-auto`)).toBeNull()
  })

  it('leaves an ordinary row unchanged', () => {
    openPicker({ provider: ALPHA.id, model: 'alpha-large' }, 'beta-small', BETA.id)
    expect(screen.queryByTestId(`nexus-route-icon-${BETA.id}-beta-small`)).toBeNull()
    expect(screen.queryByTestId(`nexus-route-member-${BETA.id}-beta-small`)).toBeNull()
    expect(screen.getByTestId(`nexus-model-option-${BETA.id}-beta-small`).textContent).toBe('Beta Small')
  })
})

const reply = (routedVia?: unknown, uuid = 'a-1'): Message =>
  ({
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'assistant', model: 'auto', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' },
    ...(routedVia ? { routedVia } : {}),
  }) as unknown as Message

const userRow = (uuid: string): Message =>
  ({ type: 'user', uuid, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } }) as unknown as Message

function renderRows(rows: readonly Message[]) {
  const messages = convertTranscriptToThreadMessages(rows).messages as unknown as ThreadMessageLike[]
  const AssistantMessage: FC = () =>
    createElement('div', { 'data-testid': 'reply' }, createElement(RouteSwitchNotice), createElement(RouteMemberLabel))
  const UserMessage: FC = () => null
  const Harness: FC = () => {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages,
      convertMessage: (m) => m,
      isRunning: false,
      onNew: async () => {},
    })
    return createElement(
      RouteNamesContext.Provider,
      { value: CATALOG },
      createElement(
        AssistantRuntimeProvider,
        { runtime },
        createElement(
          ThreadPrimitive.Root,
          null,
          createElement(ThreadPrimitive.Viewport, null, createElement(ThreadPrimitive.Messages, { components: { AssistantMessage, UserMessage } })),
        ),
      ),
    )
  }
  return render(createElement(Harness))
}

const REASONS: Array<[string | undefined, string]> = [
  ['rate_limit', 'Alpha Large · Alpha Cloud hit its rate limit. Switched to Beta Small · Beta Hosting.'],
  ['quota', 'Alpha Large · Alpha Cloud is out of quota. Switched to Beta Small · Beta Hosting.'],
  ['billing', 'Alpha Large · Alpha Cloud has a billing problem. Switched to Beta Small · Beta Hosting.'],
  ['credentials', 'Alpha Large · Alpha Cloud rejected the credentials. Switched to Beta Small · Beta Hosting.'],
  ['model_unavailable', 'Alpha Large · Alpha Cloud cannot use this model. Switched to Beta Small · Beta Hosting.'],
  ['service', 'Alpha Large · Alpha Cloud had a server error. Switched to Beta Small · Beta Hosting.'],
  ['network', 'Alpha Large · Alpha Cloud could not be reached. Switched to Beta Small · Beta Hosting.'],
  ['provider_policy', 'Switched from Alpha Large · Alpha Cloud to Beta Small · Beta Hosting.'],
  [undefined, 'Switched from Alpha Large · Alpha Cloud to Beta Small · Beta Hosting.'],
]

describe('a routed reply', () => {
  it('names the member that served it', () => {
    renderRows([userRow('u-1'), reply({ provider: ALPHA.id, model: 'alpha-large' })])
    expect(screen.getByTestId('reply').querySelector('[data-role="route-member"]')!.textContent).toBe('Served by Alpha Large · Alpha Cloud')
    expect(screen.getByTestId('reply').querySelector('[data-role="route-switch-notice"]')).toBeNull()
  })

  it('leaves a reply served by no router unchanged', () => {
    renderRows([userRow('u-1'), reply()])
    expect(screen.getByTestId('reply').textContent).toBe('')
  })

  it.each(REASONS)('draws one sentence for a switch with reason %s', (reason, sentence) => {
    renderRows([
      userRow('u-1'),
      reply({ provider: BETA.id, model: 'beta-small', switchedFrom: { provider: ALPHA.id, model: 'alpha-large', ...(reason ? { reason } : {}) } }),
    ])
    const notices = screen.getAllByRole('note')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.textContent).toBe(sentence)
  })

  it('has a whole catalog sentence for every reason', () => {
    for (const reason of ['rate_limit', 'quota', 'billing', 'credentials', 'model_unavailable', 'service', 'network', 'other']) {
      expect(en[routeNoticeKey(reason)]).toMatch(/\{from\}.*\{to\}/)
    }
  })

  it('draws the same member and notice from a reloaded transcript', () => {
    const rows = [
      userRow('u-1'),
      reply({ provider: BETA.id, model: 'beta-small', switchedFrom: { provider: ALPHA.id, model: 'alpha-large', reason: 'quota' } }),
    ]
    const first = renderRows(rows).container.innerHTML
    cleanup()
    const reloaded = JSON.parse(JSON.stringify(rows)) as Message[]
    expect(renderRows(reloaded).container.innerHTML).toBe(first)
    expect(screen.getByRole('note').textContent).toBe('Alpha Large · Alpha Cloud is out of quota. Switched to Beta Small · Beta Hosting.')
  })
})

describe('a routed reply while it streams', () => {
  it('carries its record on the live row, as on the stored row', () => {
    const via = { provider: BETA.id, model: 'beta-small', switchedFrom: { provider: ALPHA.id, model: 'alpha-large', reason: 'quota' } }
    const state = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [userRow('u-1')],
      liveEvents: [reply(via, 'a-live')],
      lastError: null,
    } as unknown as BrowserRuntimeClientState
    const live = convertBrowserRuntimeStateToThreadMessages(state).find((m) => m.role === 'assistant')!
    expect((live.metadata?.custom as Record<string, unknown>).routedVia).toEqual(via)
  })

  it('carries nothing on a live row served by no router', () => {
    const state = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [userRow('u-1')],
      liveEvents: [reply(undefined, 'a-live')],
      lastError: null,
    } as unknown as BrowserRuntimeClientState
    const live = convertBrowserRuntimeStateToThreadMessages(state).find((m) => m.role === 'assistant')!
    expect(live.metadata?.custom).not.toHaveProperty('routedVia')
  })
})

describe('the switch notice is not a message', () => {
  const rows = [
    userRow('u-1'),
    reply({ provider: BETA.id, model: 'beta-small', switchedFrom: { provider: ALPHA.id, model: 'alpha-large', reason: 'quota' } }),
    userRow('u-2'),
  ]

  it('adds no thread message of its own', () => {
    expect(convertTranscriptToThreadMessages(rows).messages).toHaveLength(convertTranscriptToThreadMessages(rows.map((r) => {
      const { routedVia: _drop, ...rest } = r as Message & { routedVia?: unknown }
      return rest as Message
    })).messages.length)
  })

  it('is absent from the history sent to the model', () => {
    const sent = JSON.stringify(prepareHistoryForModel(rows).map((r) => (r as { message?: unknown }).message))
    expect(sent).not.toContain('Switched')
    expect(sent).not.toContain('out of quota')
  })
})

describe('member names', () => {
  it('falls back to the raw model id and the stored provider id, never parsing it', () => {
    expect(routeMemberName(t, CATALOG, { provider: ALPHA.id, model: 'alpha-gone' })).toBe('alpha-gone · Alpha Cloud')
    expect(routeMemberName(t, CATALOG, { provider: 'inst-removed/x:1', model: 'm-9' })).toBe('m-9 · inst-removed/x:1')
    expect(routeMemberName(t, null, { provider: 'inst-a1', model: 'alpha-large' })).toBe('alpha-large · inst-a1')
  })

  it('names a Latest entry by the model it runs today', () => {
    const latest = {
      ...ALPHA,
      models: [{ id: 'alpha-latest', label: 'Alpha', enabled: true, entry: { kind: 'latest', resolvedVersion: '4.5' } }],
    } as unknown as BrowserLlmProvider
    expect(routeMemberName(t, { providers: [latest] }, { provider: ALPHA.id, model: 'alpha-latest' })).toBe('Alpha 4.5 · Alpha Cloud')
  })

  it('reads the latest routed reply of a session', () => {
    const rows = [reply({ provider: ALPHA.id, model: 'alpha-large' }, 'a-1'), userRow('u-2'), reply(undefined, 'a-2'), reply({ provider: BETA.id, model: 'beta-small' }, 'a-3')]
    expect(latestRoutedVia(rows)).toEqual({ provider: BETA.id, model: 'beta-small' })
    expect(latestRoutedVia([reply()])).toBeUndefined()
  })

  it('reads who serves the turn in hand from its live events, as they arrive', () => {
    const read = liveRouteMemberReader()
    const alpha = { provider: ALPHA.id, model: 'alpha-large' }
    const beta = { provider: BETA.id, model: 'beta-small' }
    const delta = { type: 'stream_event', event: { type: 'content_block_delta' } }
    expect(read([])).toBeUndefined()
    // The first stream event of a reply names its member, before any reply row.
    const live: unknown[] = [{ ...delta, routedVia: alpha }]
    expect(read(live)).toEqual(alpha)
    live.push(delta, delta)
    expect(read(live)).toEqual(alpha)
    // A later reply of the same turn, served by another member.
    live.push(reply(alpha, 'a-1'), { ...delta, routedVia: beta })
    expect(read(live)).toEqual(beta)
    // The list was cleared, then replaced: nothing is carried over.
    expect(read([])).toBeUndefined()
    expect(read([delta, delta, delta, delta, delta, delta])).toBeUndefined()
    expect(read([{ ...delta, routedVia: alpha }, delta, delta, delta, delta, delta])).toEqual(alpha)
  })

  it('reads a recorded member name and tiers, dropping empty or malformed ones', () => {
    const facts = { provider: BETA.id, model: 'beta-x', label: 'Beta X', tiers: ['low', 'high'], defaultTier: 'low' }
    expect(latestRoutedVia([reply(facts as never, 'a-1')])).toEqual(facts)
    const bad = { provider: BETA.id, model: 'beta-x', label: '', tiers: ['low', 3], defaultTier: '' }
    expect(latestRoutedVia([reply(bad as never, 'a-1')])).toEqual({ provider: BETA.id, model: 'beta-x' })
  })
})
