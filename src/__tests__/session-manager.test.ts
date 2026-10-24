import { afterEach, describe, expect, it } from 'vitest'
import { __setTemplateChannelForTest } from '../prompting/templateRegistry'
import { CLI_AGENT_IDS } from '../terminal/cliAgents'
import type { LocalSessionEntry } from '../browser/webview/useSessionManager'
import {
  findReusableEmptySession,
  mergeSessions,
  normalizeTemplateType,
} from '../browser/webview/useSessionManager'
import {
  formatWindowTitle,
  resolveActiveSessionWindowTitle,
} from '../browser/webview/windowTitle'
import { buildTurnEndNotification } from '../notifications/turnEndNotification'

function localEntry(
  partial: Partial<LocalSessionEntry> & { sessionId: string },
): LocalSessionEntry {
  return {
    sessionId: partial.sessionId,
    title: partial.title ?? 'New Thread',
    ...(partial.customTitle !== undefined
      ? { customTitle: partial.customTitle }
      : {}),
    previewText: partial.previewText ?? '',
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    messageCount: partial.messageCount ?? 0,
    composerDraft: partial.composerDraft ?? '',
    lastComposerEditAt: partial.lastComposerEditAt ?? 0,
    ...(partial.templateType !== undefined
      ? { templateType: partial.templateType }
      : {}),
    ...(partial.projectRoot !== undefined
      ? { projectRoot: partial.projectRoot }
      : {}),
    ...(partial.spawnerSessionId !== undefined
      ? { spawnerSessionId: partial.spawnerSessionId }
      : {}),
    ...(partial.teammateName !== undefined
      ? { teammateName: partial.teammateName }
      : {}),
  }
}

describe('mergeSessions', () => {
  it('prefers newer local transcript metadata over remote summaries', () => {
    const merged = mergeSessions(
      [
        {
          sessionId: 'session-1',
          updatedAt: 100,
          title: 'remote title',
          previewText: 'remote preview',
        },
      ],
      new Map([
        [
          'session-1',
          localEntry({
            sessionId: 'session-1',
            title: 'local title',
            previewText: 'local preview',
            createdAt: 50,
            updatedAt: 200,
          }),
        ],
      ]),
    )

    expect(merged).toEqual([
      localEntry({
        sessionId: 'session-1',
        title: 'local title',
        previewText: 'local preview',
        createdAt: 50,
        updatedAt: 200,
      }),
    ])
  })

  it('keeps newer remote transcript metadata when the local cache is older', () => {
    const merged = mergeSessions(
      [
        {
          sessionId: 'session-1',
          updatedAt: 200,
          title: 'remote title',
          previewText: 'remote preview',
        },
      ],
      new Map([
        [
          'session-1',
          localEntry({
            sessionId: 'session-1',
            title: 'local title',
            previewText: 'local preview',
            createdAt: 50,
            updatedAt: 100,
          }),
        ],
      ]),
    )

    expect(merged).toEqual([
      localEntry({
        sessionId: 'session-1',
        title: 'remote title',
        previewText: 'remote preview',
        createdAt: 50,
        updatedAt: 200,
      }),
    ])
  })

  it('does not let a resumed session\'s empty boot placeholder mask the persisted title', () => {
    // An empty placeholder for the active session (seeded with `updatedAt = Date.now()` on cold-boot resume) defers
    // to the content-bearing remote summary, though its timestamp is newer.
    const merged = mergeSessions(
      [
        {
          sessionId: 'resumed',
          updatedAt: 500,
          title: 'Fix the login bug',
          previewText: 'Fix the login bug',
          messageCount: 6,
          templateType: 'code',
        },
      ],
      new Map([
        [
          'resumed',
          localEntry({
            sessionId: 'resumed',
            title: 'New Thread',
            previewText: '',
            createdAt: 999_999,
            updatedAt: 999_999,
            messageCount: 0,
          }),
        ],
      ]),
    )

    expect(merged[0]?.title).toBe('Fix the login bug')
    expect(merged[0]?.previewText).toBe('Fix the login bug')
    expect(merged[0]?.messageCount).toBe(6)
    expect(merged[0]?.updatedAt).toBe(500)
    expect(merged[0]?.templateType).toBe('code')
  })

  it('still prefers a NON-empty local entry over an older remote summary', () => {
    // Guard the fix's boundary: once the transcript has loaded (or the user has
    // typed), `updateSessionMeta` populates title + messageCount, so the entry is
    // no longer an untouched placeholder and the optimistic-local-wins rule must
    // still hold — a stale fs broadcast can't clobber the fresher UI state.
    const merged = mergeSessions(
      [
        {
          sessionId: 'session-1',
          updatedAt: 100,
          title: 'stale remote title',
          previewText: 'stale remote preview',
          messageCount: 2,
        },
      ],
      new Map([
        [
          'session-1',
          localEntry({
            sessionId: 'session-1',
            title: 'live local title',
            previewText: 'live local preview',
            createdAt: 50,
            updatedAt: 200,
            messageCount: 4,
          }),
        ],
      ]),
    )

    expect(merged[0]?.title).toBe('live local title')
    expect(merged[0]?.previewText).toBe('live local preview')
    expect(merged[0]?.updatedAt).toBe(200)
  })

  it('keeps local-only sessions that have no remote summary yet', () => {
    const merged = mergeSessions(
      [],
      new Map([
        [
          'fresh',
          localEntry({
            sessionId: 'fresh',
            createdAt: 10,
            updatedAt: 10,
          }),
        ],
      ]),
    )

    expect(merged).toEqual([
      localEntry({
        sessionId: 'fresh',
        createdAt: 10,
        updatedAt: 10,
      }),
    ])
  })

  it('reconciles composer draft fields independently of transcript fields', () => {
    // Local cache has a fresher draft (UI just typed); remote has a
    // fresher transcript (assistant just replied). Both wins should
    // land in the merged entry.
    const merged = mergeSessions(
      [
        {
          sessionId: 'session-1',
          updatedAt: 200,
          title: 'remote title',
          previewText: 'remote preview',
          composerDraft: 'stale draft on disk',
          lastComposerEditAt: 50,
        },
      ],
      new Map([
        [
          'session-1',
          localEntry({
            sessionId: 'session-1',
            title: 'local title',
            previewText: 'local preview',
            createdAt: 10,
            updatedAt: 100,
            composerDraft: 'fresh local draft',
            lastComposerEditAt: 999,
          }),
        ],
      ]),
    )

    expect(merged).toEqual([
      localEntry({
        sessionId: 'session-1',
        title: 'remote title',
        previewText: 'remote preview',
        createdAt: 10,
        updatedAt: 200,
        composerDraft: 'fresh local draft',
        lastComposerEditAt: 999,
      }),
    ])
  })

  it('takes remote draft when remote.lastComposerEditAt is newer than local', () => {
    const merged = mergeSessions(
      [
        {
          sessionId: 'session-1',
          updatedAt: 100,
          composerDraft: 'remote draft',
          lastComposerEditAt: 999,
        },
      ],
      new Map([
        [
          'session-1',
          localEntry({
            sessionId: 'session-1',
            updatedAt: 100,
            composerDraft: 'local draft',
            lastComposerEditAt: 100,
          }),
        ],
      ]),
    )

    expect(merged[0]?.composerDraft).toBe('remote draft')
    expect(merged[0]?.lastComposerEditAt).toBe(999)
  })

  it('sorts by max(updatedAt, lastComposerEditAt) descending', () => {
    const merged = mergeSessions(
      [
        // Session A: transcript activity at 100, no draft.
        { sessionId: 'a', updatedAt: 100 },
        // Session B: transcript activity at 50, but the user is
        // actively typing a draft at t=300 — should rank first.
        { sessionId: 'b', updatedAt: 50 },
        // Session C: transcript activity at 200, no draft.
        { sessionId: 'c', updatedAt: 200 },
      ],
      new Map([
        [
          'b',
          localEntry({
            sessionId: 'b',
            title: 'b',
            updatedAt: 50,
            composerDraft: 'wip',
            lastComposerEditAt: 300,
          }),
        ],
      ]),
    )

    expect(merged.map(s => s.sessionId)).toEqual(['b', 'c', 'a'])
  })

  it('breaks ties by sessionId localeCompare ascending', () => {
    const merged = mergeSessions(
      [
        { sessionId: 'b', updatedAt: 100 },
        { sessionId: 'a', updatedAt: 100 },
      ],
      new Map(),
    )

    expect(merged.map(s => s.sessionId)).toEqual(['a', 'b'])
  })

  it('considers remote-only lastComposerEditAt in the sort key', () => {
    // Fresh boot with no local cache: drafts come exclusively from
    // remote. Sort must still respect them.
    const merged = mergeSessions(
      [
        { sessionId: 'a', updatedAt: 100 },
        {
          sessionId: 'b',
          updatedAt: 50,
          composerDraft: 'wip',
          lastComposerEditAt: 999,
        },
      ],
      new Map(),
    )

    expect(merged.map(s => s.sessionId)).toEqual(['b', 'a'])
  })

  it('prefers a manual customTitle over the derived title', () => {
    const merged = mergeSessions(
      [
        {
          sessionId: 's1',
          updatedAt: 100,
          title: 'derived from first prompt',
          customTitle: 'My Renamed Chat',
        },
      ],
      new Map(),
    )

    expect(merged[0]?.title).toBe('My Renamed Chat')
    expect(merged[0]?.customTitle).toBe('My Renamed Chat')
  })

  it('does not let a newer remote derived title clobber a local manual rename', () => {
    // The riskiest case: the user renamed (local customTitle), then a new
    // assistant turn produced a NEWER remote summary carrying only the
    // re-derived title (no customTitle). The manual title must still win.
    const merged = mergeSessions(
      [{ sessionId: 's1', updatedAt: 500, title: 'derived title (newer)' }],
      new Map([
        [
          's1',
          localEntry({
            sessionId: 's1',
            title: 'Manual',
            customTitle: 'Manual',
            updatedAt: 100,
          }),
        ],
      ]),
    )

    expect(merged[0]?.title).toBe('Manual')
    expect(merged[0]?.customTitle).toBe('Manual')
  })

  it('rehydrates a manual customTitle from the remote summary when the local cache is empty (post-reload)', () => {
    const merged = mergeSessions(
      [
        {
          sessionId: 's1',
          updatedAt: 100,
          title: 'derived',
          customTitle: 'Persisted Rename',
        },
      ],
      new Map(),
    )

    expect(merged[0]?.title).toBe('Persisted Rename')
    expect(merged[0]?.customTitle).toBe('Persisted Rename')
  })

  it('keeps a fresh boot placeholder newest when the runtime card has no clock yet', () => {
    // A live session with no transcript: the runtime card carries no updatedAt.
    const merged = mergeSessions(
      [
        { sessionId: 'boot', messageCount: 0 },
        { sessionId: 'older', updatedAt: 500, title: 'Older', messageCount: 2 },
      ],
      new Map([
        ['boot', localEntry({ sessionId: 'boot', createdAt: 9_000, updatedAt: 9_000 })],
      ]),
    )

    expect(merged.map(s => s.sessionId)).toEqual(['boot', 'older'])
    expect(merged[0]?.updatedAt).toBe(9_000)
  })

  // A re-launched empty session must float to the top of the sidebar. It
  // can't do that through the local `updatedAt`: an empty session is an
  // "untouched placeholder", so its local clock deliberately loses to the
  // persisted summary's. `relaunchedAt` is a floor applied after that
  // resolution — the title/preview still come from the remote summary.
  it('floors updatedAt at relaunchedAt for a re-launched empty session', () => {
    const merged = mergeSessions(
      [{ sessionId: 's1', updatedAt: 100, title: '', previewText: '' }],
      new Map([
        [
          's1',
          {
            ...localEntry({ sessionId: 's1', createdAt: 10, updatedAt: 900 }),
            relaunchedAt: 900,
          },
        ],
      ]),
    )

    expect(merged[0]?.updatedAt).toBe(900)
    expect(merged[0]?.relaunchedAt).toBe(900)
  })

  it('never lets relaunchedAt pull a real activity clock BACKWARDS', () => {
    const merged = mergeSessions(
      [{ sessionId: 's1', updatedAt: 5_000, title: 'real', messageCount: 4 }],
      new Map([
        [
          's1',
          {
            ...localEntry({ sessionId: 's1', updatedAt: 900, messageCount: 4 }),
            relaunchedAt: 900,
          },
        ],
      ]),
    )

    expect(merged[0]?.updatedAt).toBe(5_000)
  })
})

// findReusableEmptySession is the launcher's reuse rule. The ACTIVE-session
// condition is the bug fix: without it, clicking "New agent" on a fresh
// profile matched the empty untyped BOOT session — the row already on screen
// — so the click added nothing to the list and switched nothing. Chat/code
// hid the same defect behind their type key: nothing of their type exists
// until the first click.
describe('mergeSessions — teammate identity', () => {
  // `spawnerSessionId` is identity, not "newest wins" data: it decides whether
  // the session is a sidebar row or a tab under its lead. Whichever side knows
  // it must win, in BOTH merge branches.
  it('takes the remote parent even when the local transcript is newer', () => {
    const merged = mergeSessions(
      [
        {
          sessionId: 'teammate-1',
          updatedAt: 100,
          spawnerSessionId: 'lead-1',
          teammateName: 'worker-a',
        },
      ],
      new Map([
        [
          'teammate-1',
          // A local placeholder created before the spawn broadcast landed.
          localEntry({ sessionId: 'teammate-1', updatedAt: 500 }),
        ],
      ]),
    )
    expect(merged[0]!.spawnerSessionId).toBe('lead-1')
    expect(merged[0]!.teammateName).toBe('worker-a')
  })

  it('keeps a local parent when the remote summary has not caught up', () => {
    const merged = mergeSessions(
      [{ sessionId: 'teammate-1', updatedAt: 900 }],
      new Map([
        [
          'teammate-1',
          localEntry({
            sessionId: 'teammate-1',
            updatedAt: 100,
            spawnerSessionId: 'lead-1',
            teammateName: 'worker-a',
          }),
        ],
      ]),
    )
    expect(merged[0]!.spawnerSessionId).toBe('lead-1')
    expect(merged[0]!.teammateName).toBe('worker-a')
  })

  it('leaves an ordinary session with no parent', () => {
    const merged = mergeSessions(
      [{ sessionId: 'session-1', updatedAt: 1 }],
      new Map(),
    )
    expect(merged[0]!.spawnerSessionId).toBeUndefined()
  })
})

describe('findReusableEmptySession', () => {
  const empty = (
    sessionId: string,
    templateType?: string,
  ): LocalSessionEntry => ({
    ...localEntry({ sessionId }),
    ...(templateType ? { templateType } : {}),
  })

  it('never reuses the session that is already active', () => {
    expect(
      findReusableEmptySession([empty('boot')], undefined, undefined, 'boot'),
    ).toBeUndefined()
  })

  it('reuses an empty same-type session that is not active', () => {
    expect(
      findReusableEmptySession(
        [empty('active'), empty('idle')],
        undefined,
        undefined,
        'active',
      )?.sessionId,
    ).toBe('idle')
  })

  // The active-session exclusion applies to the project-bound branch too:
  // a project launch whose only same-folder empty IS the active row must
  // allocate, exactly as the plain launcher does.
  it('never reuses the active session on a PROJECT launch either', () => {
    const bound = localEntry({
      sessionId: 'active',
      templateType: 'code',
      projectRoot: '/repo/one',
    })
    expect(
      findReusableEmptySession([bound], 'code', '/repo/one', 'active'),
    ).toBeUndefined()
  })

  // The unbound fallback must not smuggle the active row back in: it is a
  // second `find` over the same list, so it needs the same exclusion.
  it('the unbound fallback also skips the active session', () => {
    const bound = localEntry({
      sessionId: 'active',
      templateType: 'code',
      projectRoot: '/repo/one',
    })
    expect(
      findReusableEmptySession([bound], 'code', undefined, 'active'),
    ).toBeUndefined()
  })

  it('matches on templateType — a chat launch never reuses an empty agent', () => {
    const merged = [empty('agent'), empty('chat', 'chat')]
    expect(
      findReusableEmptySession(merged, 'chat', undefined, 'agent')?.sessionId,
    ).toBe('chat')
    expect(
      findReusableEmptySession(merged, 'code', undefined, 'agent'),
    ).toBeUndefined()
  })

  it('skips sessions with messages or a manual rename', () => {
    const withMessages = {
      ...localEntry({ sessionId: 'used', messageCount: 2 }),
    }
    const renamed = {
      ...localEntry({ sessionId: 'kept', customTitle: 'Mine', title: 'Mine' }),
    }
    expect(
      findReusableEmptySession(
        [withMessages, renamed],
        undefined,
        undefined,
        'active',
      ),
    ).toBeUndefined()
  })

  it('reuses an empty thread of the same type when neither is project-bound', () => {
    const found = findReusableEmptySession(
      [localEntry({ sessionId: 'empty', templateType: 'chat' })],
      'chat',
      undefined,
      undefined,
    )
    expect(found?.sessionId).toBe('empty')
  })

  it('never reuses across template types', () => {
    const found = findReusableEmptySession(
      [localEntry({ sessionId: 'empty', templateType: 'chat' })],
      'code',
      undefined,
      undefined,
    )
    expect(found).toBeUndefined()
  })

  it('never reuses a thread bound to a DIFFERENT project', () => {
    // Reuse across projects would file the user's work in the wrong project
    // and drop a row out of the sidebar's Projects node.
    const found = findReusableEmptySession(
      [
        localEntry({
          sessionId: 'other-project',
          templateType: 'code',
          projectRoot: '/repo/one',
        }),
      ],
      'code',
      '/repo/two',
      undefined,
    )
    expect(found).toBeUndefined()
  })

  describe('CLI session types (F-34)', () => {
    afterEach(() => __setTemplateChannelForTest(null))

    it('never reuses an empty-looking CLI session: it counts no messages even after running', () => {
      __setTemplateChannelForTest('beta')
      for (const cli of CLI_AGENT_IDS) {
        const type = `cli-${cli}`
        const ran = localEntry({ sessionId: `ran-${cli}`, templateType: type, projectRoot: '/repo/one' })
        expect(findReusableEmptySession([ran], type, '/repo/one', 'other')).toBeUndefined()
        expect(findReusableEmptySession([ran], type, undefined, 'other')).toBeUndefined()
      }
    })
  })

  it('never reuses an UNBOUND thread for a project launch', () => {
    const found = findReusableEmptySession(
      [localEntry({ sessionId: 'unbound', templateType: 'code' })],
      'code',
      '/repo/one',
      undefined,
    )
    expect(found).toBeUndefined()
  })

  it('an unbound launch FALLS BACK to a project-bound empty rather than stacking a new one', () => {
    // A `code` session auto-binds a folder at init, so an idle empty one
    // almost always carries a projectRoot. Refusing it here would break the
    // launcher reuse the sidebar has always done (e2e cases 4 / 4b).
    const found = findReusableEmptySession(
      [
        localEntry({
          sessionId: 'bound',
          templateType: 'code',
          projectRoot: '/repo/one',
        }),
      ],
      'code',
      undefined,
      undefined,
    )
    expect(found?.sessionId).toBe('bound')
  })

  it('an unbound launch PREFERS an unbound empty over a project-bound one', () => {
    const found = findReusableEmptySession(
      [
        localEntry({
          sessionId: 'bound',
          templateType: 'code',
          projectRoot: '/repo/one',
        }),
        localEntry({sessionId: 'unbound', templateType: 'code'}),
      ],
      'code',
      undefined,
      undefined,
    )
    expect(found?.sessionId).toBe('unbound')
  })

  it('reuses an empty thread already bound to the SAME project', () => {
    const found = findReusableEmptySession(
      [
        localEntry({
          sessionId: 'same-project',
          templateType: 'agent',
          projectRoot: '/repo/one',
        }),
      ],
      'agent',
      '/repo/one',
      undefined,
    )
    expect(found?.sessionId).toBe('same-project')
  })

  it('never reuses a thread that has messages', () => {
    const found = findReusableEmptySession(
      [
        localEntry({
          sessionId: 'used',
          templateType: 'code',
          projectRoot: '/repo/one',
          messageCount: 3,
        }),
      ],
      'code',
      '/repo/one',
      undefined,
    )
    expect(found).toBeUndefined()
  })

  it('never reuses a thread the user manually renamed', () => {
    const found = findReusableEmptySession(
      [
        localEntry({
          sessionId: 'renamed',
          templateType: 'code',
          projectRoot: '/repo/one',
          customTitle: 'Keep me',
        }),
      ],
      'code',
      '/repo/one',
      undefined,
    )
    expect(found).toBeUndefined()
  })
})

describe('findReusableEmptySession — teammates', () => {
  it('never reuses an empty teammate for a launcher click', () => {
    // A teammate belongs to its lead and is not in the sidebar the user
    // clicked from; reusing one would hand back a session that disappears
    // when the lead is deleted.
    const teammate = localEntry({
      sessionId: 'teammate-1',
      templateType: 'code',
      spawnerSessionId: 'lead-1',
    })
    expect(
      findReusableEmptySession([teammate], 'code', undefined, 'other'),
    ).toBeUndefined()
    // The same entry WITHOUT a parent is reusable, so the exclusion is the
    // parent and nothing else.
    const plain = localEntry({ sessionId: 's1', templateType: 'code' })
    expect(
      findReusableEmptySession([plain], 'code', undefined, 'other')?.sessionId,
    ).toBe('s1')
  })
})

describe('normalizeTemplateType', () => {
  it('passes real string template types through unchanged', () => {
    expect(normalizeTemplateType('code')).toBe('code')
    expect(normalizeTemplateType('chat')).toBe('chat')
    expect(normalizeTemplateType('')).toBe('')
  })

  it('maps undefined (boot-default agent thread) to undefined', () => {
    expect(normalizeTemplateType(undefined)).toBeUndefined()
  })

  // Regression: a "New thread" button bound `onClick={openNewSession}` raw,
  // so React passed a SyntheticEvent as `templateType`. That event object
  // was stored on the session and spread into the `worker.init` payload,
  // where `postMessage` threw `DataCloneError: PointerEvent could not be
  // cloned` and the new session never booted. `openNewSession` now routes
  // its arg through `normalizeTemplateType`, which must coerce any non-string —
  // event-like objects, DOM nodes, functions — to undefined so the init
  // payload is always structured-cloneable.
  it('coerces a React-SyntheticEvent-like object to undefined (DataCloneError guard)', () => {
    const syntheticEventLike = {
      nativeEvent: { type: 'pointerup' },
      target: { tagName: 'BUTTON' },
      view: {},
      getModifierState: () => false,
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
    }
    expect(normalizeTemplateType(syntheticEventLike)).toBeUndefined()
  })

  it('coerces other non-string inputs to undefined', () => {
    expect(normalizeTemplateType(null)).toBeUndefined()
    expect(normalizeTemplateType(42)).toBeUndefined()
    expect(normalizeTemplateType({ type: 'code' })).toBeUndefined()
    expect(normalizeTemplateType(() => 'code')).toBeUndefined()
    expect(normalizeTemplateType(['code'])).toBeUndefined()
  })
})

// Feeds the kNexus window's native title: the active title is published to
// the host via `ui.setActiveSessionTitle` (the host composes
// "{title} - {product}" in CustomBrowserView::GetWindowTitle), and the same
// composed string is mirrored into document.title via formatWindowTitle.
describe('window title helpers', () => {
  it('resolves the active entry\'s display title', () => {
    const sessions = [
      localEntry({ sessionId: 'session-1', title: 'Fix login bug' }),
      localEntry({ sessionId: 'session-2', title: 'Other thread' }),
    ]
    expect(resolveActiveSessionWindowTitle(sessions, 'session-1')).toBe(
      'Fix login bug',
    )
    expect(resolveActiveSessionWindowTitle(sessions, 'session-2')).toBe(
      'Other thread',
    )
  })

  it('returns the empty clear-signal when the active id is unknown', () => {
    const sessions = [localEntry({ sessionId: 'session-1' })]
    expect(resolveActiveSessionWindowTitle(sessions, 'missing')).toBe('')
    expect(resolveActiveSessionWindowTitle([], 'session-1')).toBe('')
  })

  it('treats a whitespace-only title as empty', () => {
    const sessions = [localEntry({ sessionId: 'session-1', title: '   ' })]
    expect(resolveActiveSessionWindowTitle(sessions, 'session-1')).toBe('')
  })

  it('composes "{title} - {product}" and falls back to the bare product', () => {
    expect(formatWindowTitle('Fix login bug', 'Nexus')).toBe(
      'Fix login bug - Nexus',
    )
    expect(formatWindowTitle('', 'Nexus')).toBe('Nexus')
  })
})

// The turn-end OS toast is an idle-prompt nudge: the bold line is the
// session title and the body is "{product} is waiting for your input".
// Regression guard for the old payload, which set a fixed body ("Agent
// finished responding — your turn.") and no title.
describe('buildTurnEndNotification', () => {
  it('uses the session title as the bold line and a waiting-for-input body', () => {
    const n = buildTurnEndNotification('Nexus', 'Main contents view refactoring')
    expect(n.title).toBe('Main contents view refactoring')
    expect(n.message).toBe('Nexus is waiting for your input')
    expect(n.notificationType).toBe('turn_complete')
  })

  it('honors a rebranded product name in the body', () => {
    expect(buildTurnEndNotification('Acme', 'Some session').message).toBe(
      'Acme is waiting for your input',
    )
  })

  it('omits the title when the session has no derived title yet', () => {
    const blank = buildTurnEndNotification('Nexus', undefined)
    expect(blank.title).toBeUndefined()
    expect(blank.message).toBe('Nexus is waiting for your input')
    // Whitespace-only titles collapse to "no title" too.
    expect(buildTurnEndNotification('Nexus', '   ').title).toBeUndefined()
  })
})
