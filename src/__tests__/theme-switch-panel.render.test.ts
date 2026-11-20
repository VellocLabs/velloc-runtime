// @vitest-environment happy-dom
/**
 * The theme switch panel (F-25): the latest switch's steps in the window's
 * corner, how it ended, and when it closes.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { en as EN } from '../browser/webview/i18n/messages/en'
import { THEME_SWITCH_CLOSE_MS, ThemeSwitchPanel } from '../browser/webview/mods/ThemeSwitchPanel'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { THEME_SWITCH_TOPIC, type ThemeSwitchEntry } from '../mods/themeSwitch'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** A connection whose `theme/switch` events the test sends. */
function topic() {
  let deliver: ((event: { payload: unknown }) => void) | null = null
  const subscribed: string[] = []
  const connection = {
    subscribe: (id: string, listener: (event: { payload: unknown }) => void) => {
      subscribed.push(id)
      deliver = listener
      return () => {
        deliver = null
      }
    },
  } as unknown as RuntimeConnection
  const runtimeConnection = async () => connection
  const send = (...switches: ThemeSwitchEntry[]) => act(() => deliver?.({ payload: { switches } }))
  return { runtimeConnection, send, subscribed }
}

const LOOK: ThemeSwitchEntry = {
  id: 'switch-1',
  subject: { kind: 'look', plugin: 'pack', look: 'Honu Lagoon' },
  steps: [
    { kind: 'waitTurn', state: 'done' },
    { kind: 'turnOff', state: 'done', plugins: ['rival', 'other'] },
    { kind: 'turnOn', state: 'done', plugin: 'pack' },
    { kind: 'load', state: 'done', plugin: 'pack' },
    { kind: 'command', state: 'running', command: '/pick-look lagoon' },
  ],
}

async function mount() {
  const rig = topic()
  render(createElement(ThemeSwitchPanel, { runtimeConnection: rig.runtimeConnection }))
  await act(async () => {})
  return rig
}

describe('theme switch panel', () => {
  it('shows nothing until a switch runs, then its title and every step in order', async () => {
    const { send, subscribed } = await mount()
    expect(subscribed).toEqual([THEME_SWITCH_TOPIC])
    expect(screen.queryByTestId('theme-switch-panel')).toBeNull()
    send(LOOK)
    const panel = screen.getByTestId('theme-switch-panel')
    expect(panel.getAttribute('data-state')).toBe('running')
    expect(panel.getAttribute('role')).toBe('status')
    expect(screen.getByTestId('theme-switch-title').textContent).toBe(EN['themeSwitch.title.look'].replace('{name}', 'Honu Lagoon'))
    const steps = within(screen.getByTestId('theme-switch-steps')).getAllByRole('listitem')
    expect(steps.map(step => [step.getAttribute('data-testid'), step.getAttribute('data-state'), step.textContent])).toEqual([
      ['theme-switch-step:waitTurn', 'done', EN['themeSwitch.step.waitTurn']],
      ['theme-switch-step:turnOff', 'done', EN['themeSwitch.step.turnOff'].replace('{names}', 'rival, other')],
      ['theme-switch-step:turnOn', 'done', EN['themeSwitch.step.turnOn'].replace('{name}', 'pack')],
      ['theme-switch-step:load', 'done', EN['themeSwitch.step.load'].replace('{name}', 'pack')],
      ['theme-switch-step:command', 'running', EN['themeSwitch.step.command'].replace('{command}', '/pick-look lagoon')],
    ])
    expect(screen.queryByTestId('theme-switch-result')).toBeNull()
  })

  it('shows how it ended and closes five seconds later, not before', async () => {
    vi.useFakeTimers()
    const { send } = await mount()
    send(LOOK)
    vi.advanceTimersByTime(60_000)
    // Still running: it stays.
    expect(screen.getByTestId('theme-switch-panel')).toBeTruthy()
    send({ ...LOOK, steps: LOOK.steps.map(step => ({ ...step, state: 'done' as const })), outcome: { ok: true } })
    expect(screen.getByTestId('theme-switch-panel').getAttribute('data-state')).toBe('done')
    expect(screen.getByTestId('theme-switch-result').textContent).toBe(EN['themeSwitch.done.look'].replace('{name}', 'Honu Lagoon'))
    act(() => vi.advanceTimersByTime(THEME_SWITCH_CLOSE_MS - 1))
    expect(screen.getByTestId('theme-switch-panel')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByTestId('theme-switch-panel')).toBeNull()
    // A new switch shows again.
    send({ id: 'switch-2', subject: { kind: 'turnOffAll' }, steps: [{ kind: 'turnOff', state: 'running', plugins: [] }] })
    expect(screen.getByTestId('theme-switch-title').textContent).toBe(EN['themeSwitch.title.turnOffAll'])
    expect(screen.getByTestId('theme-switch-step:turnOff').textContent).toBe(EN['themeSwitch.step.turnOffAny'])
  })

  it('says why a switch failed, and that none was on for a Turn off all with nothing on', async () => {
    const { send } = await mount()
    send({ ...LOOK, outcome: { ok: false, reason: 'notLoaded' } })
    expect(screen.getByTestId('theme-switch-panel').getAttribute('data-state')).toBe('failed')
    expect(screen.getByTestId('theme-switch-step:command').getAttribute('data-state')).toBe('running')
    expect(screen.getByTestId('theme-switch-result').textContent).toBe(EN['customize.themes.reason.notLoaded'])
    send({ ...LOOK, id: 'switch-2', outcome: { ok: false, reason: 'cancelled' } })
    expect(screen.getByTestId('theme-switch-result').textContent).toBe(EN['themeSwitch.cancelled'])
    send({ id: 'switch-3', subject: { kind: 'turnOffAll' }, steps: [{ kind: 'turnOff', state: 'done', plugins: [] }], outcome: { ok: true } })
    expect(screen.getByTestId('theme-switch-step:turnOff').textContent).toBe(EN['customize.themes.notice.noneOn'])
    expect(screen.getByTestId('theme-switch-result').textContent).toBe(EN['customize.themes.notice.turnedOff'])
    send({ id: 'switch-4', subject: { kind: 'enable', plugin: 'pack' }, steps: [], outcome: { ok: true } })
    expect(screen.getByTestId('theme-switch-title').textContent).toBe(EN['themeSwitch.title.enable'].replace('{name}', 'pack'))
    expect(screen.getByTestId('theme-switch-result').textContent).toBe(EN['themeSwitch.done.enable'].replace('{name}', 'pack'))
  })

  it('the close button hides the switch it shows', async () => {
    const { send } = await mount()
    send(LOOK)
    const close = screen.getByTestId('theme-switch-close')
    expect(close.getAttribute('aria-label')).toBe(EN['themeSwitch.close'])
    fireEvent.click(close)
    expect(screen.queryByTestId('theme-switch-panel')).toBeNull()
    send({ ...LOOK, steps: [...LOOK.steps, { kind: 'turnOn', state: 'running', plugin: 'x' }] })
    expect(screen.queryByTestId('theme-switch-panel')).toBeNull()
  })
})
