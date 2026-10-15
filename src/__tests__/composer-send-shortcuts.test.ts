import { describe, expect, it } from 'vitest'
import type { SlashCommandSummary } from '../browser/worker/workerProtocol'
import {
  composerShortcutModifiers,
  resolveComposerInputHint,
  resolveComposerSendShortcuts,
  shouldSendInForkOnModAltEnter,
} from '../components/assistant-ui/composer-send-shortcuts'
import { shouldQueueOnRunningModEnter } from '../components/assistant-ui/inject-message-context'
import { shouldSendOnRunningEnter } from '../components/assistant-ui/thread'
import { createTranslate } from '../browser/webview/i18n/translate'

/**
 * The composer's three send modes — Enter (Send), Ctrl/⌘+Enter (Queue for
 * later), Ctrl/⌘+Alt/⌥+Enter (Send in a forked session) — and the Send button
 * tooltip that lists them. Idle there is nothing to queue behind, so the
 * tooltip drops that row.
 */

describe('resolveComposerSendShortcuts', () => {
  it('lists Send and Send-in-a-fork while the session is idle', () => {
    expect(
      resolveComposerSendShortcuts({ isRunning: false, hasMessages: true }).map(s => s.id),
    ).toEqual(['send', 'fork'])
  })

  it('adds Queue for later between them while the turn runs', () => {
    expect(
      resolveComposerSendShortcuts({ isRunning: true, hasMessages: true }).map(s => s.id),
    ).toEqual(['send', 'queue', 'fork'])
  })

  it('drops the fork row in an empty session — there is nothing to fork', () => {
    expect(
      resolveComposerSendShortcuts({ isRunning: false, hasMessages: false }).map(s => s.id),
    ).toEqual(['send'])
    expect(
      resolveComposerSendShortcuts({ isRunning: true, hasMessages: false }).map(s => s.id),
    ).toEqual(['send', 'queue'])
  })

  it('renders the English rows with the platform modifier glyphs', () => {
    const t = createTranslate('en')
    const rows = (platform: string) =>
      resolveComposerSendShortcuts({ isRunning: true, hasMessages: true }).map(s => [
        t(s.labelKey),
        t(s.keysKey, composerShortcutModifiers(platform)),
      ])
    expect(rows('Win32')).toEqual([
      ['Send', 'Enter'],
      ['Queue for later', 'Ctrl+Enter'],
      ['Send in a forked session', 'Ctrl+Alt+Enter'],
    ])
    expect(rows('MacIntel')).toEqual([
      ['Send', 'Enter'],
      ['Queue for later', '⌘+Enter'],
      ['Send in a forked session', '⌘+⌥+Enter'],
    ])
  })

  it('fills both glyph placeholders in every locale', () => {
    for (const locale of ['zh', 'ja', 'ko', 'es', 'fr', 'de'] as const) {
      const t = createTranslate(locale)
      const forkKeys = t(
        'composer.sendShortcut.forkKeys',
        composerShortcutModifiers('Win32'),
      )
      expect(forkKeys, locale).toMatch(/^Ctrl\+Alt\+\S+$/)
    }
  })
})

describe('the placeholder no longer carries send hints', () => {
  it('points at slash commands only', () => {
    expect(createTranslate('en')('composer.placeholder')).toBe(
      'Type / for commands',
    )
  })

  it('invites a first task while the thread has no messages', () => {
    expect(createTranslate('en')('composer.placeholderEmptyThread')).toBe(
      'Describe a task or ask a question',
    )
  })
})

describe('shouldSendInForkOnModAltEnter', () => {
  const base = {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: true,
    metaKey: false,
    altKey: true,
    isComposing: false,
    defaultPrevented: false,
    sendBlocked: false,
    hasContent: true,
  }

  it('fires on Ctrl+Alt+Enter and ⌘+⌥+Enter', () => {
    expect(shouldSendInForkOnModAltEnter(base)).toBe(true)
    expect(
      shouldSendInForkOnModAltEnter({ ...base, ctrlKey: false, metaKey: true }),
    ).toBe(true)
  })

  it('needs both the modifier and Alt', () => {
    expect(shouldSendInForkOnModAltEnter({ ...base, altKey: false })).toBe(false)
    expect(shouldSendInForkOnModAltEnter({ ...base, ctrlKey: false })).toBe(false)
  })

  it('stays out of the way of Shift, IME, the slash picker, a pending question and an empty composer', () => {
    expect(shouldSendInForkOnModAltEnter({ ...base, shiftKey: true })).toBe(false)
    expect(shouldSendInForkOnModAltEnter({ ...base, isComposing: true })).toBe(false)
    expect(shouldSendInForkOnModAltEnter({ ...base, defaultPrevented: true })).toBe(false)
    expect(shouldSendInForkOnModAltEnter({ ...base, sendBlocked: true })).toBe(false)
    expect(shouldSendInForkOnModAltEnter({ ...base, hasContent: false })).toBe(false)
    expect(shouldSendInForkOnModAltEnter({ ...base, key: 'a' })).toBe(false)
  })

  it('never overlaps the running Enter / Ctrl+Enter gates', () => {
    const running = { ...base, isRunning: true }
    expect(shouldQueueOnRunningModEnter(running)).toBe(false)
    expect(shouldSendOnRunningEnter(running)).toBe(false)
  })
})

describe('resolveComposerInputHint', () => {
  const commands = [
    {name: 'loop', kind: 'skill', argumentHint: '[interval] <prompt>', description: 'Run a prompt on an interval'},
    {name: 'compact', kind: 'builtin'},
  ] as unknown as SlashCommandSummary[]
  const hint = (text: string, isRunning = false, hasMessages = true) =>
    resolveComposerInputHint({text, isRunning, hasMessages, commands})

  it('shows nothing for an empty composer — the placeholder covers that', () => {
    expect(hint('')).toBeNull()
    expect(hint('   \n')).toBeNull()
  })

  it('teaches the send shortcuts for the current state once text is typed', () => {
    expect(hint('hello')).toEqual({kind: 'send', isRunning: false, hasMessages: true})
    expect(hint('hello', true)).toEqual({kind: 'send', isRunning: true, hasMessages: true})
    // A slash later in the text is not a command.
    expect(hint('use a/b paths')).toEqual({kind: 'send', isRunning: false, hasMessages: true})
  })

  it('carries the empty-session flag so the hint drops the fork clause', () => {
    expect(hint('hello', false, false)).toEqual({kind: 'send', isRunning: false, hasMessages: false})
    expect(hint('hello', true, false)).toEqual({kind: 'send', isRunning: true, hasMessages: false})
  })

  it('explains the picker while a command name is still being typed', () => {
    expect(hint('/')).toEqual({kind: 'command-pick'})
    expect(hint('/lo')).toEqual({kind: 'command-pick'})
  })

  it("shows a known command's syntax from its argument hint", () => {
    for (const text of ['/loop', '/loop ', '/loop 5m check the deploy']) {
      expect(hint(text)).toMatchObject({
        kind: 'command-usage',
        name: 'loop',
        usage: '/loop [interval] <prompt>',
      })
    }
    expect(hint('/compact')).toMatchObject({kind: 'command-usage', usage: '/compact'})
  })

  it('names an unknown command once the user types past its name', () => {
    expect(hint('/nope args')).toEqual({kind: 'command-unknown', name: 'nope'})
  })

  it('renders every hint from the English catalog', () => {
    const t = createTranslate('en')
    const glyphs = composerShortcutModifiers('Win32')
    expect(t('composer.hint.send', glyphs)).toBe(
      'Enter to send · Ctrl+Alt+Enter to send in a forked session · Shift+Enter for a new line',
    )
    expect(t('composer.hint.sendRunning', glyphs)).toBe(
      'Enter to add to this turn · Ctrl+Enter to queue for later · Ctrl+Alt+Enter to send in a forked session',
    )
    // Empty-session variants carry no fork clause.
    expect(t('composer.hint.sendEmpty', glyphs)).toBe(
      'Enter to send · Shift+Enter for a new line',
    )
    expect(t('composer.hint.sendRunningEmpty', glyphs)).toBe(
      'Enter to add to this turn · Ctrl+Enter to queue for later',
    )
    expect(t('composer.hint.commandUsage', {usage: '/loop [interval] <prompt>'})).toBe(
      'Usage: /loop [interval] <prompt>',
    )
    expect(t('composer.hint.commandUnknown', {name: 'nope'})).toBe('No command named /nope')
  })
})
