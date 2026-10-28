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
import { clearModContributions, setModContributions } from '../browser/webview/mods/modContributionsView'
import { __setTemplateChannelForTest } from '../prompting/templateRegistry'
import type { ModContributionsState } from '../browser/runtimeProtocol/modContributions'

// A session whose type the current channel's launcher catalog does not list is
// hidden, and its teammates with it. `team` is the live case: `index-beta.md`
// lists it, `index.md` does not. A plugin type is hidden once the contributions
// snapshot says no plugin in effect offers it.

afterEach(() => {
  __setTemplateChannelForTest(null)
  clearModContributions()
})

/** A snapshot with `types` contributed; `[]` is a real snapshot that offers nothing. */
const contributing = (...types: string[]): ModContributionsState => ({
  templates: types.map(type => ({
    type,
    plugin: type.slice(0, type.indexOf(':')),
    owner: 'acme@mkt',
    title: type,
    launcher: 'both',
  })),
  topbar: [],
  icons: {},
  waiting: [],
})

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

describe('isSessionTypeOffered — plugin types', () => {
  const mine = { sessionId: 'mine', templateType: 'acme:review' }

  it('before the first contributions snapshot every plugin type is shown', () => {
    __setTemplateChannelForTest('stable')
    expect(isSessionTypeOffered('acme:review')).toBe(true)
    expect(hiddenSessionIds([code, plain, mine]).size).toBe(0)
    expect(isSessionTypeOffered('acme:')).toBe(false)
    // `null` is the explicit spelling of "no snapshot yet".
    expect(isSessionTypeOffered('acme:review', null)).toBe(true)
    expect(hiddenSessionIds([mine], null).size).toBe(0)
  })

  it('a snapshot is known by having been taken, not by its contents: an empty one hides, the topic released shows again', () => {
    __setTemplateChannelForTest('stable')
    // The topic delivers a structured clone, a fresh empty object and never
    // the module's constant, and that is a real "nothing offered".
    setModContributions({ templates: [], topbar: [], icons: {}, waiting: [] })
    expect(isSessionTypeOffered('acme:review')).toBe(false)
    expect(hiddenSessionIds([mine]).has('mine')).toBe(true)
    // The topic released (the worker restarted): nothing is known until the
    // next snapshot, and the rows are back meanwhile.
    clearModContributions()
    expect(isSessionTypeOffered('acme:review')).toBe(true)
    expect(hiddenSessionIds([mine]).size).toBe(0)
  })

  it('a plugin type is shown while a plugin in effect contributes it', () => {
    __setTemplateChannelForTest('stable')
    setModContributions(contributing('acme:review', 'acme:plan'))
    expect(isSessionTypeOffered('acme:review')).toBe(true)
    expect(hiddenSessionIds([code, plain, mine]).size).toBe(0)
  })

  it('a plugin type no plugin offers now is hidden: off, removed, or waiting for its provider', () => {
    __setTemplateChannelForTest('stable')
    // A real snapshot that offers nothing: the plugin is off, gone, or its
    // required provider is not set up (its templates are then not contributed).
    setModContributions(contributing())
    expect(isSessionTypeOffered('acme:review')).toBe(false)
    expect([...hiddenSessionIds([code, plain, mine])]).toEqual(['mine'])
    // Another plugin's type does not stand in for it.
    setModContributions(contributing('acme:plan'))
    expect(isSessionTypeOffered('acme:review')).toBe(false)
    // Bundled types are judged by the catalog as before.
    expect(isSessionTypeOffered('code')).toBe(true)
    expect(isSessionTypeOffered('team')).toBe(false)
    expect(isSessionTypeOffered('removed_type')).toBe(false)
  })

  it('a snapshot passed explicitly beats the store, so the shell re-judges on each one', () => {
    __setTemplateChannelForTest('stable')
    setModContributions(contributing('acme:review'))
    expect(isSessionTypeOffered('acme:review', contributing())).toBe(false)
    expect(hiddenSessionIds([mine], contributing()).has('mine')).toBe(true)
    expect(hiddenSessionIds([mine], contributing('acme:review')).has('mine')).toBe(false)
  })

  it('a teammate of a hidden plugin-type lead goes with it', () => {
    __setTemplateChannelForTest('stable')
    setModContributions(contributing())
    const pluginLead = { sessionId: 'plead', templateType: 'acme:team' }
    const child = { sessionId: 'pchild', templateType: 'code', spawnerSessionId: 'plead' }
    expect([...hiddenSessionIds([pluginLead, child, code])].sort()).toEqual(['pchild', 'plead'])
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
