/**
 * The side region's agent-opened float and settled-float hold (F-9): each
 * event carries its origin; a narrow window adds no form of its own.
 */
import { describe, expect, it } from 'vitest'

import {
  initialRightPanelPresence,
  stepRightPanelPresence,
  type RightPanelPresence,
  type RightPanelPresenceEvent,
} from '@/browser/webview/layout/rightPanelPresence'

const AREA = 900
const ROOM = 600

function run(state: RightPanelPresence, ...events: RightPanelPresenceEvent[]): RightPanelPresence {
  return events.reduce(stepRightPanelPresence, state)
}

const resize = (areaW = AREA, room = ROOM): RightPanelPresenceEvent => ({
  type: 'resize', areaW, room,
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

describe('opens by the person', () => {
  it('a view the person opens changes nothing while nothing floats or is held', () => {
    const beside = run(initialRightPanelPresence(), resize())
    expect(run(beside, { type: 'personOpen', view: 'diff' })).toBe(beside)
  })

  it('a resize at an unchanged room and width changes nothing', () => {
    const beside = run(initialRightPanelPresence(), resize())
    expect(run(beside, resize())).toBe(beside)
    expect(run(beside, resize(600, ROOM))).toBe(beside)
  })

  it('the state has only the float, the hold and the room: no width-driven form', () => {
    const state = run(initialRightPanelPresence(), { type: 'personOpen', view: 'tasks' }, resize(400, 100))
    expect(Object.keys(state).sort()).toEqual(['float', 'hold', 'room'])
    expect(state).toEqual({ float: null, hold: null, room: 100 })
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
    const state = run(closed, agentPlan(), resize(), { type: 'input' })
    expect(state.float).toBeNull()
    expect(state.hold).toEqual({ kind: 'plan', share: 300 / ROOM })
  })

  it('a resize settles it; a report at the same width does not', () => {
    const floating = run(closed, agentPlan(), resize())
    expect(floating.float).not.toBeNull()
    const state = run(floating, resize(1000, 700))
    expect(state.float).toBeNull()
    expect(state.hold).toEqual({ kind: 'plan', share: 300 / 700 })
  })

  it('another view coming forward settles it, held for that view\'s kind', () => {
    const floating = run(closed, agentPlan(), resize())
    const state = run(floating, { type: 'personOpen', view: 'tasks' })
    expect(state.float).toBeNull()
    expect(state.hold).toEqual({ kind: 'tasks', share: 300 / ROOM })
  })

  it('a resolved plan settles it for the view left in front, and drops it when nothing is left', () => {
    const floating = run(closed, agentPlan(), resize())
    expect(run(floating, { type: 'planClosed', nextView: 'diff' }).hold).toEqual({ kind: 'diff', share: 300 / ROOM })
    const gone = run(floating, { type: 'planClosed', nextView: null })
    expect(gone.float).toBeNull()
    expect(gone.hold).toBeNull()
  })

  it('closing the panel drops it without a hold', () => {
    const state = run(closed, agentPlan(), resize(), { type: 'close' })
    expect(state.float).toBeNull()
    expect(state.hold).toBeNull()
  })

  it('a switch into a session whose plan auto-opens keeps that plan\'s float', () => {
    const state = run(closed, agentPlan({ sessionId: 's2' }), { type: 'sessionSwitch', sessionId: 's2' })
    expect(state.float).toEqual({ width: 300, areaW: AREA, view: 'plan', sessionId: 's2' })
  })

  it('a switch drops the float of the session left behind', () => {
    const state = run(closed, agentPlan({ sessionId: 's1' }), { type: 'sessionSwitch', sessionId: 's2' })
    expect(state.float).toBeNull()
  })
})

describe('held share', () => {
  const held = (): RightPanelPresence =>
    run(initialRightPanelPresence(), agentPlan(), resize(), { type: 'input' })

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
