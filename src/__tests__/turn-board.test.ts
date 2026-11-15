import { describe, expect, it } from 'vitest'

import { MAX_TURN_STEPS, MAX_TURN_STEP_CHARS, TurnBoard, type TurnStep } from '../sessions/turnBoard'

// The turn board (F-41): the latest accepted call is the state, updates merge
// into the list the board holds, and a person's message answers the closing.

const plan = (...statuses: TurnStep['status'][]): TurnStep[] =>
  statuses.map((status, index) => ({ text: `step ${index + 1}`, status }))
const statuses = (board: TurnBoard, sessionId = 's1') => board.read(sessionId).steps.map(step => step.status)

function tracked() {
  const board = new TurnBoard()
  const changes: string[] = []
  board.onChange(sessionId => changes.push(sessionId))
  return { board, changes }
}

describe('TurnBoard', () => {
  it('reads an empty state for a session it has never seen', () => {
    expect(new TurnBoard().read('s1')).toEqual({ steps: [], closing: null })
  })

  it('setPlan replaces the list per session, bounds it, and notifies once', () => {
    const { board, changes } = tracked()
    board.setPlan('s1', plan('in_progress', 'pending'))
    board.setPlan('s2', plan('pending'))
    const many = Array<TurnStep['status']>(MAX_TURN_STEPS + 3).fill('pending')
    board.setPlan('s1', [{ text: 'x'.repeat(MAX_TURN_STEP_CHARS + 20), status: 'in_progress' }, ...plan(...many)])
    expect(board.read('s1').steps).toHaveLength(MAX_TURN_STEPS)
    expect(board.read('s1').steps[0]!.text).toHaveLength(MAX_TURN_STEP_CHARS)
    expect(statuses(board, 's2')).toEqual(['pending'])
    expect(changes).toEqual(['s1', 's2', 's1'])
  })

  it('next completes the step in progress and starts the first pending one', () => {
    const { board } = tracked()
    board.setPlan('s1', plan('in_progress', 'pending', 'pending'))
    expect(board.update('s1', { next: true })).toMatchObject({ ok: true })
    expect(statuses(board)).toEqual(['completed', 'in_progress', 'pending'])
    board.update('s1', { next: true })
    board.update('s1', { next: true })
    expect(statuses(board)).toEqual(['completed', 'completed', 'completed'])
    expect(board.update('s1', { next: true })).toMatchObject({ ok: true })
    expect(statuses(board)).toEqual(['completed', 'completed', 'completed'])
  })

  it('next with nothing in progress starts the first pending step', () => {
    const { board } = tracked()
    board.setPlan('s1', plan('completed', 'pending'))
    board.update('s1', { next: true })
    expect(statuses(board)).toEqual(['completed', 'in_progress'])
  })

  it('next with no list is accepted, changes nothing and notifies nobody', () => {
    const { board, changes } = tracked()
    expect(board.update('s1', { next: true })).toEqual({ ok: true, steps: [] })
    expect(changes).toEqual([])
  })

  it('done and start work on the list the board holds; start leaves other steps as they are', () => {
    const { board } = tracked()
    board.setPlan('s1', plan('in_progress', 'pending', 'pending', 'pending'))
    expect(board.update('s1', { done: [2], start: 4 })).toMatchObject({ ok: true })
    expect(statuses(board)).toEqual(['in_progress', 'completed', 'pending', 'in_progress'])
    board.update('s1', { done: [4] })
    expect(statuses(board)).toEqual(['in_progress', 'completed', 'pending', 'completed'])
  })

  it('one update applies done, then start, then next', () => {
    const { board } = tracked()
    board.setPlan('s1', plan('in_progress', 'pending', 'pending', 'pending'))
    board.update('s1', { done: [1], start: 3, next: true })
    expect(statuses(board)).toEqual(['completed', 'in_progress', 'completed', 'pending'])
  })

  it('a step number outside the list refuses the whole update, naming the list size', () => {
    const { board, changes } = tracked()
    expect(board.update('s1', { done: [1] })).toEqual({ ok: false, count: 0 })
    board.setPlan('s1', plan('in_progress', 'pending'))
    changes.length = 0
    const cases: Array<{ done?: number[]; start?: number; next?: boolean }> = [
      { done: [3] },
      { done: [0] },
      { start: 5 },
      { done: [1.5] },
      { done: [1, 9], next: true },
      { done: ['1' as unknown as number] },
    ]
    for (const update of cases) {
      expect(board.update('s1', update), JSON.stringify(update)).toEqual({ ok: false, count: 2 })
    }
    expect(statuses(board)).toEqual(['in_progress', 'pending'])
    expect(changes).toEqual([])
  })

  it('a list with several steps in progress is kept as sent', () => {
    const { board } = tracked()
    board.setPlan('s1', plan('in_progress', 'in_progress', 'pending'))
    expect(statuses(board)).toEqual(['in_progress', 'in_progress', 'pending'])
  })

  it('close records the closing and checks off every step', () => {
    const { board } = tracked()
    board.setPlan('s1', plan('completed', 'in_progress', 'pending'))
    board.close('s1', { summary: 'Done so far.', question: 'Ship it?', replies: ['Ship', 'Not yet'], waiting: true })
    expect(statuses(board)).toEqual(['completed', 'completed', 'completed'])
    expect(board.read('s1').closing).toEqual({
      summary: 'Done so far.',
      question: 'Ship it?',
      replies: ['Ship', 'Not yet'],
      waiting: true,
    })
  })

  it('a new plan clears an earlier closing', () => {
    const { board } = tracked()
    board.close('s1', { summary: 'S.', replies: [], waiting: false })
    board.setPlan('s1', plan('in_progress'))
    expect(board.read('s1').closing).toBeNull()
  })

  it('a second close with no plan change or message in between is reported as repeated', () => {
    const { board } = tracked()
    const closing = { summary: 'S.', replies: [], waiting: false }
    expect(board.close('s1', closing)).toEqual({ repeated: false })
    expect(board.close('s1', { ...closing, summary: 'Later.' })).toEqual({ repeated: true })
    expect(board.read('s1').closing!.summary).toBe('Later.')
    board.personWrote('s1')
    expect(board.close('s1', closing)).toEqual({ repeated: false })
    board.setPlan('s1', plan('in_progress'))
    expect(board.close('s1', closing)).toEqual({ repeated: false })
  })

  it('a message from the person answers the closing and leaves the plan, finished or not', () => {
    const { board, changes } = tracked()
    board.setPlan('s1', plan('in_progress'))
    board.close('s1', { summary: 'S.', question: 'Q?', replies: ['Yes'], waiting: false })
    changes.length = 0
    board.personWrote('s1')
    expect(board.read('s1').closing).toBeNull()
    expect(statuses(board)).toEqual(['completed'])
    expect(changes).toEqual(['s1'])
  })

  it('a message from the person with no closing standing changes nothing', () => {
    const { board, changes } = tracked()
    board.setPlan('s1', plan('completed', 'in_progress', 'pending'))
    changes.length = 0
    board.personWrote('s1')
    board.personWrote('unknown')
    expect(statuses(board)).toEqual(['completed', 'in_progress', 'pending'])
    expect(changes).toEqual([])
  })

  it('a message that starts a new turn drops the plan and the closing', () => {
    const { board, changes } = tracked()
    board.setPlan('s1', plan('completed', 'in_progress'))
    board.close('s1', { summary: 'S.', question: 'Q?', replies: ['Yes'], waiting: false })
    changes.length = 0
    board.personWrote('s1', true)
    expect(board.read('s1')).toEqual({ steps: [], closing: null })
    expect(changes).toEqual(['s1'])
    board.personWrote('s1', true)
    expect(changes).toEqual(['s1'])
  })

  it('a message typed into a running turn keeps an unfinished plan', () => {
    const { board, changes } = tracked()
    board.setPlan('s1', plan('in_progress', 'pending'))
    changes.length = 0
    board.personWrote('s1', false)
    expect(statuses(board)).toEqual(['in_progress', 'pending'])
    expect(changes).toEqual([])
  })

  it('forget drops a session and notifies only when it held something', () => {
    const { board, changes } = tracked()
    board.forget('s1')
    board.setPlan('s1', plan('pending'))
    board.forget('s1')
    expect(board.read('s1')).toEqual({ steps: [], closing: null })
    expect(changes).toEqual(['s1', 's1'])
  })
})
