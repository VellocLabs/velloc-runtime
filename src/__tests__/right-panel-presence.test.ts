/**
 * The Right Panel's overlay, agent-opened float and settled-float hold
 * (F-9): each event carries its origin, and only a view the person opens
 * shows the overlay.
 */
import { describe, expect, it } from 'vitest'

import {
  initialRightPanelPresence,
  stepRightPanelPresence,
  type RightPanelPresence,
  type RightPanelPresenceEvent,
} from '@/browser/webview/layout/rightPanelPresence'
import type { PanelForm } from '@/browser/webview/layout/shellLayout'

const AREA = 900
const ROOM = 600

function run(state: RightPanelPresence, ...events: RightPanelPresenceEvent[]): RightPanelPresence {
  return events.reduce(stepRightPanelPresence, state)
}

const resize = (form: PanelForm, areaW = AREA, room = ROOM): RightPanelPresenceEvent => ({
  type: 'resize', areaW, form, room,
})

const agentPlan = (
  over: Partial<Extract<RightPanelPresenceEvent, { type: 'agentOpen' }>> = {},
): RightPanelPresenceEvent => ({
  type: 'agentOpen',
  view: 'plan',
  sessionId: 's1',
  panelOpen: false,
  spare: 320,
  dockedWidth: 300,
  areaW: AREA,
  ...over,
})

/** The panel open and overlaid, the overlay hidden. */
const overlaid = (): RightPanelPresence => run(initialRightPanelPresence(), resize('overlay'))

describe('overlay', () => {
  it('a view the person opens shows the overlay', () => {
    expect(run(overlaid(), { type: 'personOpen', view: 'diff' }).overlay).toBe(true)
  })

  it('a view the person opens shows the overlay even when already in front', () => {
    const state = run(overlaid(), { type: 'personOpen', view: 'tasks' }, { type: 'dismiss' })
    expect(state.overlay).toBe(false)
    expect(run(state, { type: 'personOpen', view: 'tasks' }).overlay).toBe(true)
  })

  it('opening the closed panel shows the overlay only when it lands overlaid', () => {
    const closed = initialRightPanelPresence()
    expect(run(closed, { type: 'personOpen', view: 'tasks' }, resize('overlay')).overlay).toBe(true)
    expect(run(closed, { type: 'personOpen', view: 'tasks' }, resize('beside')).overlay).toBe(false)
  })

  it('a person opening a view beside the chat does not arm the overlay for a later narrowing', () => {
    const beside = run(initialRightPanelPresence(), resize('beside'))
    const state = run(beside, { type: 'personOpen', view: 'diff' }, resize('overlay', 600))
    expect(state.overlay).toBe(false)
  })

  it('an agent-opened plan does not show the overlay', () => {
    expect(run(overlaid(), agentPlan({ panelOpen: true })).overlay).toBe(false)
  })

  it('the view a resolved plan leaves in front does not show the overlay', () => {
    const state = run(overlaid(), agentPlan({ panelOpen: true }), { type: 'planClosed', nextView: 'diff' })
    expect(state.overlay).toBe(false)
  })

  it('Escape or a press outside hides it', () => {
    const shown = run(overlaid(), { type: 'personOpen', view: 'diff' })
    expect(run(shown, { type: 'dismiss' }).overlay).toBe(false)
  })

  it('the toggle hides and shows it while overlaid, and does nothing otherwise', () => {
    const shown = run(overlaid(), { type: 'personOpen', view: 'diff' })
    const hidden = run(shown, { type: 'toggle' })
    expect(hidden.overlay).toBe(false)
    expect(run(hidden, { type: 'toggle' }).overlay).toBe(true)
    const beside = run(initialRightPanelPresence(), resize('beside'))
    expect(run(beside, { type: 'toggle' })).toBe(beside)
  })

  it('a session switch hides it', () => {
    const shown = run(overlaid(), { type: 'personOpen', view: 'diff' })
    expect(run(shown, { type: 'sessionSwitch', sessionId: 's2' }).overlay).toBe(false)
  })

  it('widening the window out of overlay hides it, and narrowing again keeps it hidden', () => {
    const shown = run(overlaid(), { type: 'personOpen', view: 'diff' })
    const widened = run(shown, resize('beside', 1400))
    expect(widened.overlay).toBe(false)
    expect(run(widened, resize('overlay', 600)).overlay).toBe(false)
  })

  it('closing the panel hides it', () => {
    const shown = run(overlaid(), { type: 'personOpen', view: 'diff' })
    expect(run(shown, { type: 'close' }).overlay).toBe(false)
  })
})

describe('agent-opened float', () => {
  const closed = initialRightPanelPresence()

  it('floats a closed panel at the spare width, no wider than it would dock', () => {
    expect(run(closed, agentPlan()).float).toEqual({ width: 300, areaW: AREA, view: 'plan', sessionId: 's1' })
    expect(run(closed, agentPlan({ spare: 290 })).float?.width).toBe(290)
  })

  it('does not float without the room, unmeasured, or when the panel is already shown', () => {
    expect(run(closed, agentPlan({ spare: 279 })).float).toBeNull()
    expect(run(closed, agentPlan({ spare: null })).float).toBeNull()
    expect(run(closed, agentPlan({ panelOpen: true })).float).toBeNull()
  })

  it('the person\'s next input settles it into a held share of its kind', () => {
    const state = run(closed, agentPlan(), resize('float'), { type: 'input' })
    expect(state.float).toBeNull()
    expect(state.hold).toEqual({ kind: 'plan', share: 300 / ROOM })
  })

  it('a resize settles it; a report at the same width does not', () => {
    const floating = run(closed, agentPlan(), resize('float'))
    expect(floating.float).not.toBeNull()
    const state = run(floating, resize('float', 1000, 700))
    expect(state.float).toBeNull()
    expect(state.hold).toEqual({ kind: 'plan', share: 300 / 700 })
  })

  it('another view coming forward settles it, held for that view\'s kind', () => {
    const floating = run(closed, agentPlan(), resize('float'))
    const state = run(floating, { type: 'personOpen', view: 'tasks' })
    expect(state.float).toBeNull()
    expect(state.hold).toEqual({ kind: 'tasks', share: 300 / ROOM })
    expect(state.overlay).toBe(false)
  })

  it('a resolved plan settles it for the view left in front, and drops it when nothing is left', () => {
    const floating = run(closed, agentPlan(), resize('float'))
    expect(run(floating, { type: 'planClosed', nextView: 'diff' }).hold).toEqual({ kind: 'diff', share: 300 / ROOM })
    const gone = run(floating, { type: 'planClosed', nextView: null })
    expect(gone.float).toBeNull()
    expect(gone.hold).toBeNull()
  })

  it('closing the panel drops it without a hold', () => {
    const state = run(closed, agentPlan(), resize('float'), { type: 'close' })
    expect(state.float).toBeNull()
    expect(state.hold).toBeNull()
  })

  it('a switch into a session whose plan auto-opens keeps that plan\'s float', () => {
    const state = run(closed, agentPlan({ sessionId: 's2' }), { type: 'sessionSwitch', sessionId: 's2' })
    expect(state.float).toEqual({ width: 300, areaW: AREA, view: 'plan', sessionId: 's2' })
    expect(state.overlay).toBe(false)
  })

  it('a switch drops the float of the session left behind', () => {
    const state = run(closed, agentPlan({ sessionId: 's1' }), { type: 'sessionSwitch', sessionId: 's2' })
    expect(state.float).toBeNull()
  })
})

describe('held share', () => {
  const held = (): RightPanelPresence =>
    run(initialRightPanelPresence(), agentPlan(), resize('float'), { type: 'input' })

  it('lasts while its kind stays in front', () => {
    expect(run(held(), { type: 'personOpen', view: 'plan' }).hold).not.toBeNull()
  })

  it('goes when another kind comes forward, the panel closes, the splitter drags or the session switches', () => {
    expect(run(held(), { type: 'personOpen', view: 'diff' }).hold).toBeNull()
    expect(run(held(), { type: 'close' }).hold).toBeNull()
    expect(run(held(), { type: 'drag' }).hold).toBeNull()
    expect(run(held(), { type: 'sessionSwitch', sessionId: 's2' }).hold).toBeNull()
  })
})
