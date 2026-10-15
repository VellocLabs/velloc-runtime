// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hiddenSessionIds,
  isSessionTypeOffered,
  pickVisibleSession,
  withoutHidden,
  withoutHiddenKeys,
} from '../browser/webview/sessionVisibility'
import { useSessionManager } from '../browser/webview/useSessionManager'
import {
  __resetLocalOverlayForTest,
  __setTemplateChannelForTest,
  applyLocalCatalog,
} from '../prompting/templateRegistry'

// A session whose type the current channel's launcher catalog does not list is
// hidden, and its teammates with it. `team` is the live case: `index-beta.md`
// lists it, `index.md` does not.

afterEach(() => __setTemplateChannelForTest(null))

const lead = { sessionId: 'lead', templateType: 'team' }
const mate = { sessionId: 'mate', templateType: 'code', spawnerSessionId: 'lead' }
const code = { sessionId: 'code-1', templateType: 'code' }
const plain = { sessionId: 'agent-1' }
const safe = { sessionId: 'safe-1', templateType: 'safe_code' }

describe('isSessionTypeOffered', () => {
  it('follows the current channel catalog', () => {
    __setTemplateChannelForTest('stable')
    expect(isSessionTypeOffered('team')).toBe(false)
    expect(isSessionTypeOffered('code')).toBe(true)
    __setTemplateChannelForTest('beta')
    expect(isSessionTypeOffered('team')).toBe(true)
  })

  it('an untyped session (the boot default) is always offered', () => {
    __setTemplateChannelForTest('stable')
    expect(isSessionTypeOffered(undefined)).toBe(true)
  })

  it('a launcher-hidden type is still listed, so its sessions are shown', () => {
    // `safe_code` carries `launcherHidden: both` — not OFFERED as a new
    // session, but it is in the catalog, and its existing sessions stay.
    __setTemplateChannelForTest('stable')
    expect(isSessionTypeOffered('safe_code')).toBe(true)
  })

  it('a type no catalog lists is hidden on both channels', () => {
    for (const channel of ['stable', 'beta'] as const) {
      __setTemplateChannelForTest(channel)
      expect(isSessionTypeOffered('removed_local_type'), channel).toBe(false)
    }
  })
})

describe('isSessionTypeOffered — under a local catalog overlay', () => {
  afterEach(() => __resetLocalOverlayForTest())

  it('a local catalog naming only its own types hides no bundled-type session', async () => {
    // `?template=local` REPLACES the launcher list; the bundled types it leaves
    // out still exist and still run, so their sessions stay listed.
    __setTemplateChannelForTest('stable')
    await applyLocalCatalog('---\ntypes:\n  - type: mytype\n---\n')
    expect(isSessionTypeOffered('mytype')).toBe(true)
    expect(isSessionTypeOffered('code')).toBe(true)
    expect(hiddenSessionIds([code, plain, { sessionId: 'mine', templateType: 'mytype' }]).size).toBe(0)
    // The channel rule is unchanged: stable's bundled catalog never listed `team`.
    expect(isSessionTypeOffered('team')).toBe(false)
    expect(isSessionTypeOffered('removed_local_type')).toBe(false)
  })
})

describe('hiddenSessionIds', () => {
  it('stable hides the team lead AND its teammate; beta hides nothing', () => {
    const all = [lead, mate, code, plain, safe]
    __setTemplateChannelForTest('stable')
    expect([...hiddenSessionIds(all)].sort()).toEqual(['lead', 'mate'])
    __setTemplateChannelForTest('beta')
    expect([...hiddenSessionIds(all)]).toEqual([])
  })

  it('a teammate is judged by its lead, not by its own (listed) type', () => {
    __setTemplateChannelForTest('stable')
    // `mate` is a `code` session — stable lists `code` — yet it goes with its lead.
    expect(hiddenSessionIds([lead, mate]).has('mate')).toBe(true)
  })

  it('a teammate whose lead is not in the list is judged by its own type', () => {
    __setTemplateChannelForTest('stable')
    expect(hiddenSessionIds([mate]).has('mate')).toBe(false)
    expect(
      hiddenSessionIds([{ sessionId: 'x', templateType: 'team', spawnerSessionId: 'gone' }]).has('x'),
    ).toBe(true)
  })
})

describe('pickVisibleSession', () => {
  it('takes the first entry that is neither hidden nor a teammate', () => {
    __setTemplateChannelForTest('stable')
    const ordered = [lead, mate, code, plain]
    expect(pickVisibleSession(ordered, hiddenSessionIds(ordered))?.sessionId).toBe('code-1')
  })

  it('is undefined when nothing visible is left', () => {
    __setTemplateChannelForTest('stable')
    const ordered = [lead, mate]
    expect(pickVisibleSession(ordered, hiddenSessionIds(ordered))).toBeUndefined()
  })
})

describe('withoutHidden / withoutHiddenKeys', () => {
  it('drop hidden ids and return the SAME object when nothing is hidden', () => {
    const ids = new Set(['a', 'b'])
    const map = new Map([
      ['a', 'q?'],
      ['b', 'r?'],
    ])
    expect(withoutHidden(ids, new Set())).toBe(ids)
    expect(withoutHiddenKeys(map, new Set())).toBe(map)
    expect([...withoutHidden(ids, new Set(['a']))]).toEqual(['b'])
    expect([...withoutHiddenKeys(map, new Set(['b'])).keys()]).toEqual(['a'])
  })
})

describe('useSessionManager — deleting the active session never promotes a hidden one', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('skips the team session (and its teammate) on stable and lands on the next visible row', () => {
    __setTemplateChannelForTest('stable')
    const { result } = renderHook(() => useSessionManager({ openingSessionId: 'code-1' }))
    const now = Date.now()
    act(() => {
      // Activity order (newest first): lead, mate, code-1 (active), agent-1.
      result.current.applyRemoteList([
        { sessionId: 'lead', templateType: 'team', updatedAt: now, messageCount: 2 },
        {
          sessionId: 'mate',
          templateType: 'code',
          spawnerSessionId: 'lead',
          updatedAt: now - 1,
          messageCount: 2,
        },
        { sessionId: 'code-1', templateType: 'code', updatedAt: now - 2, messageCount: 2 },
        { sessionId: 'agent-1', updatedAt: now - 3, messageCount: 2 },
      ])
    })
    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(result.current.activeSessionId).toBe('code-1')

    act(() => {
      result.current.deleteSession('code-1')
    })
    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(result.current.activeSessionId).toBe('agent-1')
  })
})
