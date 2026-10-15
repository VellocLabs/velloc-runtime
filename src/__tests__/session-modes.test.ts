import { describe, expect, it } from 'vitest'
import {
  coerceSessionMode,
  mayEnterMode,
  modeLabel,
  modePillLabel,
  modeTone,
  nextModeInCycle,
  pickerModes,
  SETTINGS_MODE_IDS,
} from '../permissions/sessionModes'

// Behaviour pins for the session permission modes: the ids users write in
// settings, the picker list, labels, pill tone, the keyboard cycle and the
// bypass kill switch.

const ALL = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto', 'bubble'] as const

describe('settings mode ids', () => {
  it('accepts exactly the five settings ids', () => {
    expect([...SETTINGS_MODE_IDS].sort()).toEqual(
      ['acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'].sort(),
    )
  })

  it('coerces a string to a known id, else default', () => {
    for (const id of ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']) {
      expect(coerceSessionMode(id)).toBe(id)
    }
    for (const bad of ['auto', 'bubble', '', 'Plan', ' plan', 'nonsense', 'toString']) {
      expect(coerceSessionMode(bad)).toBe('default')
    }
  })
})

describe('mode labels and tone', () => {
  it('has a menu label for every mode, falling back to the default one', () => {
    expect(ALL.map(m => modeLabel(m))).toEqual([
      'Ask permissions',
      'Accept edits',
      'Plan mode',
      'Bypass permissions',
      "Don't ask",
      'Auto mode',
      'Ask permissions',
    ])
  })

  it('has a compact pill label for every mode', () => {
    expect(ALL.map(m => modePillLabel(m))).toEqual([
      'Ask',
      'Accept',
      'Plan',
      'Bypass',
      'DontAsk',
      'Auto',
      'Ask',
    ])
  })

  // The tone keys are compared through the classes the composer pill renders.
  it('groups modes by pill tone', () => {
    const tone = (m: (typeof ALL)[number]) => modeTone(m)
    expect(tone('bubble')).toBe(tone('default'))
    expect(tone('dontAsk')).toBe(tone('bypassPermissions'))
    const distinct = new Set([tone('default'), tone('acceptEdits'), tone('plan'), tone('bypassPermissions'), tone('auto')])
    expect(distinct.size).toBe(5)
  })
})

describe('picker list', () => {
  it('lists the four reachable modes in order', () => {
    expect(pickerModes(undefined)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ])
    expect(pickerModes(false)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ])
  })

  it('drops bypass when the kill switch is on', () => {
    expect(pickerModes(true)).toEqual([
      'default',
      'acceptEdits',
      'plan',
    ])
  })
})

describe('entering a mode', () => {
  it('refuses only bypass, and only under the kill switch', () => {
    for (const m of ALL) {
      expect(mayEnterMode(m, undefined)).toBe(true)
      expect(mayEnterMode(m, { bypassPermissionsModeDisabled: false })).toBe(true)
      expect(mayEnterMode(m, { bypassPermissionsModeDisabled: true })).toBe(
        m !== 'bypassPermissions',
      )
    }
    expect(mayEnterMode('whatever', { bypassPermissionsModeDisabled: true })).toBe(true)
  })
})

describe('keyboard cycle', () => {
  const next = (mode: string, offered?: boolean, disabled?: boolean) =>
    nextModeInCycle(mode, { bypassOffered: offered, bypassDisabled: disabled })

  it('walks default → acceptEdits → plan → default without bypass', () => {
    expect(next('default')).toBe('acceptEdits')
    expect(next('acceptEdits')).toBe('plan')
    expect(next('plan')).toBe('default')
    expect(next('plan', false)).toBe('default')
  })

  it('visits bypass after plan when offered and allowed', () => {
    expect(next('plan', true)).toBe('bypassPermissions')
    expect(next('plan', true, false)).toBe('bypassPermissions')
    expect(next('bypassPermissions', true)).toBe('default')
  })

  it('skips bypass under the kill switch', () => {
    expect(next('plan', true, true)).toBe('default')
    expect(next('default', true, true)).toBe('acceptEdits')
  })

  it('returns to default from any mode outside the ring', () => {
    for (const m of ['bypassPermissions', 'dontAsk', 'auto', 'bubble', 'bogus', '']) {
      for (const offered of [undefined, false, true]) {
        for (const disabled of [undefined, false, true]) {
          expect(next(m, offered, disabled)).toBe('default')
        }
      }
    }
  })
})
