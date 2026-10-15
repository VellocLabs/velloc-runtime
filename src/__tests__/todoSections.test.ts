import { describe, expect, it } from 'vitest'
import {
  applyFinishedTurnStatus,
  buildTodoSections,
  carriedOverTodoIdentities,
  countSectionToolCalls,
  executedTodoEntries,
  parsePriorTodos,
  getTodoSectionToolTarget,
  summarizeTodoSectionTools,
  type TodoSectionPartLike,
} from '../utils/todoSections'
import type { TaskListEntry } from '../runtime/RuntimeTypes'

const text = (): TodoSectionPartLike => ({ type: 'text' })

const reasoning = (): TodoSectionPartLike => ({ type: 'reasoning' })

const tool = (toolName: string, id = `${toolName}-id`): TodoSectionPartLike => ({
  type: 'tool-call',
  toolName,
  toolCallId: id,
})

const todoWrite = (
  todos: Array<{
    content: string
    activeForm: string
    status: 'pending' | 'in_progress' | 'completed'
  }>,
  id = 'tw',
): TodoSectionPartLike => ({
  type: 'tool-call',
  toolName: 'TodoWrite',
  toolCallId: id,
  args: { todos },
})

describe('buildTodoSections', () => {
  it('returns a single plain segment when no TodoWrite is present', () => {
    const parts: TodoSectionPartLike[] = [text(), tool('Bash'), text()]

    const segments = buildTodoSections(parts)

    expect(segments).toEqual([{ kind: 'plain', indices: [0, 1, 2] }])
  })

  it('emits parts before the first TodoWrite as a plain segment', () => {
    const parts: TodoSectionPartLike[] = [
      text(),
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      ]),
      tool('Bash'),
    ]

    const segments = buildTodoSections(parts)

    expect(segments).toHaveLength(2)
    expect(segments[0]).toEqual({ kind: 'plain', indices: [0] })
    expect(segments[1]).toMatchObject({
      kind: 'todo-section',
      todoWriteIndices: [1],
      itemParts: { 0: [2] },
      prelude: [],
      trailing: [],
    })
  })

  it('attributes parts to whichever item was in_progress at the time', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
          { content: 'B', activeForm: 'Doing B', status: 'pending' },
        ],
        'tw-1',
      ),
      tool('Bash', 'b1'),
      tool('Read', 'r1'),
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'completed' },
          { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
        ],
        'tw-2',
      ),
      tool('Edit', 'e1'),
    ]

    const segments = buildTodoSections(parts)

    expect(segments).toHaveLength(1)
    const section = segments[0]!
    expect(section.kind).toBe('todo-section')
    if (section.kind !== 'todo-section') throw new Error('unreachable')
    expect(section.todoWriteIndices).toEqual([0, 3])
    expect(section.itemParts).toEqual({ 0: [1, 2], 1: [4] })
    expect(section.prelude).toEqual([])
    expect(section.trailing).toEqual([])
    // Latest view wins — both items should reflect the second TodoWrite.
    expect(section.todos.map(t => t.status)).toEqual([
      'completed',
      'in_progress',
    ])
  })

  it('keeps an already-started plan stable when a later TodoWrite sends only remaining work', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'completed' },
          { content: 'B', activeForm: 'Doing B', status: 'completed' },
          { content: 'C', activeForm: 'Doing C', status: 'in_progress' },
          { content: 'D', activeForm: 'Doing D', status: 'pending' },
          { content: 'E', activeForm: 'Doing E', status: 'pending' },
        ],
        'tw-5',
      ),
      tool('Bash', 'b1'),
      todoWrite(
        [
          { content: 'C', activeForm: 'Doing C', status: 'completed' },
          { content: 'D', activeForm: 'Doing D', status: 'in_progress' },
          { content: 'E', activeForm: 'Doing E', status: 'pending' },
        ],
        'tw-remaining',
      ),
      tool('Edit', 'e1'),
    ]

    const segments = buildTodoSections(parts)

    expect(segments).toHaveLength(1)
    const section = segments[0]!
    expect(section.kind).toBe('todo-section')
    if (section.kind !== 'todo-section') throw new Error('unreachable')
    expect(section.todos.map(t => t.content)).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(section.todos.map(t => t.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'in_progress',
      'pending',
    ])
    expect(section.itemParts).toEqual({ 2: [1], 3: [3] })
  })

  it('starts a new section instead of replacing an active plan with a disjoint TodoWrite', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'completed' },
          { content: 'B', activeForm: 'Doing B', status: 'completed' },
          { content: 'C', activeForm: 'Doing C', status: 'in_progress' },
          { content: 'D', activeForm: 'Doing D', status: 'pending' },
          { content: 'E', activeForm: 'Doing E', status: 'pending' },
        ],
        'tw-main',
      ),
      tool('Bash', 'main-work'),
      todoWrite(
        [
          { content: 'X', activeForm: 'Doing X', status: 'in_progress' },
          { content: 'Y', activeForm: 'Doing Y', status: 'pending' },
          { content: 'Z', activeForm: 'Doing Z', status: 'pending' },
        ],
        'tw-subplan',
      ),
      tool('Read', 'sub-work'),
    ]

    const segments = buildTodoSections(parts)

    expect(segments).toHaveLength(2)
    const main = segments[0]!
    const subplan = segments[1]!
    expect(main.kind).toBe('todo-section')
    expect(subplan.kind).toBe('todo-section')
    if (main.kind !== 'todo-section' || subplan.kind !== 'todo-section') {
      throw new Error('unreachable')
    }
    expect(main.persistKey).toBe('tw-main')
    expect(main.todos.map(t => t.content)).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(main.itemParts).toEqual({ 2: [1] })
    expect(subplan.persistKey).toBe('tw-subplan')
    expect(subplan.todos.map(t => t.content)).toEqual(['X', 'Y', 'Z'])
    expect(subplan.itemParts).toEqual({ 0: [3] })
  })

  it('persistKey comes from the first TodoWrite toolCallId so open state survives remounts', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [{ content: 'A', activeForm: 'Doing A', status: 'in_progress' }],
        'tw-first',
      ),
      todoWrite(
        [{ content: 'A', activeForm: 'Doing A', status: 'completed' }],
        'tw-last',
      ),
    ]

    const segments = buildTodoSections(parts)

    expect(segments).toHaveLength(1)
    if (segments[0]!.kind !== 'todo-section') throw new Error('unreachable')
    expect(segments[0]!.persistKey).toBe('tw-first')
  })

  it('buckets parts into prelude when the initial TodoWrite has no item in_progress', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'pending' },
        { content: 'B', activeForm: 'Doing B', status: 'pending' },
      ]),
      tool('Bash'),
      tool('Read'),
    ]

    const segments = buildTodoSections(parts)

    expect(segments).toHaveLength(1)
    if (segments[0]!.kind !== 'todo-section') throw new Error('unreachable')
    expect(segments[0]!.prelude).toEqual([1, 2])
    expect(segments[0]!.itemParts).toEqual({})
    expect(segments[0]!.trailing).toEqual([])
  })

  it('buckets parts into trailing when all items are completed before section end', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      ]),
      tool('Bash'),
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'completed' },
      ]),
      text(), // follow-up narration after the plan finished
    ]

    const segments = buildTodoSections(parts)

    expect(segments).toHaveLength(1)
    if (segments[0]!.kind !== 'todo-section') throw new Error('unreachable')
    expect(segments[0]!.itemParts).toEqual({ 0: [1] })
    expect(segments[0]!.trailing).toEqual([3])
    expect(segments[0]!.todos.every(t => t.status === 'completed')).toBe(true)
  })

  it('falls back to a plain part when TodoWrite args are malformed', () => {
    const parts: TodoSectionPartLike[] = [
      // No args at all — can't open a section from this.
      { type: 'tool-call', toolName: 'TodoWrite', toolCallId: 'broken' },
      tool('Bash'),
    ]

    const segments = buildTodoSections(parts)

    expect(segments).toEqual([{ kind: 'plain', indices: [0, 1] }])
  })

  it('records a malformed TodoWrite under the current item when a section is already open', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      ]),
      // Missing args — must still be visible, attached to item A.
      { type: 'tool-call', toolName: 'TodoWrite', toolCallId: 'broken' },
      tool('Bash'),
    ]

    const segments = buildTodoSections(parts)

    expect(segments).toHaveLength(1)
    if (segments[0]!.kind !== 'todo-section') throw new Error('unreachable')
    expect(segments[0]!.itemParts).toEqual({ 0: [1, 2] })
  })

  // --- settled: peel the trailing end_turn reply out of the in_progress step
  // so the agent's closing answer renders below the plan card instead of
  // buried inside a collapsed step. ---

  it('peels a trailing end_turn reply out of the in_progress item when settled', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
        { content: 'B', activeForm: 'Doing B', status: 'pending' },
      ]),
      text(), // 1 — Anthropic-bundled preamble for the tool below
      tool('Bash'), // 2 — the step's work
      text(), // 3 — end_turn reply to the user
    ]

    const segments = buildTodoSections(parts, { settled: true })

    expect(segments).toHaveLength(1)
    if (segments[0]!.kind !== 'todo-section') throw new Error('unreachable')
    // The preamble + tool stay nested under the still-in-progress step…
    expect(segments[0]!.itemParts).toEqual({ 0: [1, 2] })
    // …and the closing reply moves below the plan card.
    expect(segments[0]!.trailing).toEqual([3])
  })

  it('keeps the trailing reply nested while live (settled defaults false)', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      ]),
      text(), // 1
      tool('Bash'), // 2
      text(), // 3 — could still be a preamble whose tool-call hasn't streamed
    ]

    // Default (live): no peel — a trailing text mid-stream is indistinguishable
    // from a preamble awaiting its tool-call, so hoisting it would flicker.
    const live = buildTodoSections(parts)
    if (live[0]!.kind !== 'todo-section') throw new Error('unreachable')
    expect(live[0]!.itemParts).toEqual({ 0: [1, 2, 3] })
    expect(live[0]!.trailing).toEqual([])

    // Explicit settled:false matches the default.
    const explicit = buildTodoSections(parts, { settled: false })
    if (explicit[0]!.kind !== 'todo-section') throw new Error('unreachable')
    expect(explicit[0]!.itemParts).toEqual({ 0: [1, 2, 3] })
  })

  it('peels a trailing reasoning + text tail (everything after the last tool-call)', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      ]),
      tool('Bash'), // 1
      reasoning(), // 2 — end-of-turn thinking
      text(), // 3 — end_turn reply
    ]

    const segments = buildTodoSections(parts, { settled: true })

    if (segments[0]!.kind !== 'todo-section') throw new Error('unreachable')
    expect(segments[0]!.itemParts).toEqual({ 0: [1] })
    expect(segments[0]!.trailing).toEqual([2, 3])
  })

  it('does not peel when the turn ended right after a tool-call', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      ]),
      text(), // 1 — preamble
      tool('Bash'), // 2 — last part is a tool-call: no reply tail to peel
    ]

    const segments = buildTodoSections(parts, { settled: true })

    if (segments[0]!.kind !== 'todo-section') throw new Error('unreachable')
    expect(segments[0]!.itemParts).toEqual({ 0: [1, 2] })
    expect(segments[0]!.trailing).toEqual([])
  })

  it('drops the bucket to a bare row when the step held only the reply', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      ]),
      text(), // 1 — the only thing under the step is the closing reply
    ]

    const segments = buildTodoSections(parts, { settled: true })

    if (segments[0]!.kind !== 'todo-section') throw new Error('unreachable')
    // Bucket emptied → key removed so the row renders without a collapsible.
    expect(segments[0]!.itemParts).toEqual({})
    expect(segments[0]!.trailing).toEqual([1])
  })

  it('peels only the reply when later steps also ran and left trailing parts', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
          { content: 'B', activeForm: 'Doing B', status: 'pending' },
        ],
        'tw-1',
      ),
      tool('Bash', 'b1'), // 1 — item A work
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'completed' },
          { content: 'B', activeForm: 'Doing B', status: 'pending' },
        ],
        'tw-2',
      ),
      text(), // 3 — narration in the all-completed window → trailing
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'completed' },
          { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
        ],
        'tw-3',
      ),
      tool('Edit', 'e1'), // 5 — item B work
      text(), // 6 — end_turn reply while B is in_progress
    ]

    const segments = buildTodoSections(parts, { settled: true })

    if (segments[0]!.kind !== 'todo-section') throw new Error('unreachable')
    expect(segments[0]!.itemParts).toEqual({ 0: [1], 1: [5] })
    // Existing trailing part (3) plus the peeled reply (6), in ascending order.
    expect(segments[0]!.trailing).toEqual([3, 6])
  })

  // --- hoisted parts: a standalone part (AskUserQuestion, an a2ui surface, a
  // teammate spawn) is lifted to a top-level `hoisted` segment wherever it
  // falls. The hoist is STRUCTURAL — the caller derives `hoistedIndices` from
  // what the part is, not from whether the turn is live or the call is
  // answered — so the segments are the same at every point in the message's
  // life. An enclosing section CLOSES at the part (pending steps kept); what
  // follows is plain until the next TodoWrite opens a continuation card. ---

  it('closes the section at a question, keeps its pending steps, and renders what follows plain', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
          { content: 'B', activeForm: 'Doing B', status: 'pending' },
          { content: 'C', activeForm: 'Doing C', status: 'pending' },
        ],
        'tw',
      ),
      tool('Bash', 'b1'), // 1 — work under A
      tool('AskUserQuestion', 'q1'), // 2 — the question
      tool('Bash', 'b2'), // 3 — work after the answer, before any TodoWrite
    ]

    const segments = buildTodoSections(parts, { hoistedIndices: new Set([2]) })

    expect(segments).toHaveLength(3)
    const section = segments[0]!
    if (section.kind !== 'todo-section') throw new Error('unreachable')
    // The plan is intact: nothing is dropped for a question the turn will
    // continue past once it is answered.
    expect(section.todos.map(t => t.content)).toEqual(['A', 'B', 'C'])
    // The card shows the plan up to the break; the question is not bucketed
    // under the step.
    expect(section.itemParts).toEqual({ 0: [1] })
    expect(segments[1]).toEqual({ kind: 'hoisted', index: 2 })
    // Work after the break is plain until the model's next TodoWrite.
    expect(segments[2]).toEqual({ kind: 'plain', indices: [3] })
  })

  it('a TodoWrite after the break opens a continuation card that lists only the steps worked on after it', () => {
    // The reported session: TodoWrite[c,i,p,p,p], a question, a spawn, then
    // TodoWrite[c,c,c,i,p] and the closing reply — one assistant message.
    // Card 1 shows steps 1–2 (the plan at the break); card 2 shows steps
    // 3–4. Before this, the section stayed open across the break and card 1
    // listed all four executed steps as done.
    const step = (n: number, status: 'pending' | 'in_progress' | 'completed') => ({
      content: `step ${n}`,
      activeForm: `doing step ${n}`,
      status,
    })
    const parts: TodoSectionPartLike[] = [
      todoWrite([step(1, 'completed'), step(2, 'in_progress'), step(3, 'pending'), step(4, 'pending'), step(5, 'pending')], 'tw1'),
      tool('Bash', 'b1'), // 1 — under step 2
      tool('AskUserQuestion', 'q1'), // 2 — hoisted
      tool('Agent', 'spawn'), // 3 — hoisted
      todoWrite([step(1, 'completed'), step(2, 'completed'), step(3, 'completed'), step(4, 'in_progress'), step(5, 'pending')], 'tw2'),
      text(), // 5 — the closing reply
    ]

    const segments = buildTodoSections(parts, {
      settled: true,
      hoistedIndices: new Set([2, 3]),
    })

    expect(segments.map(s => s.kind)).toEqual(['todo-section', 'hoisted', 'hoisted', 'todo-section'])
    const first = segments[0]!
    const second = segments[3]!
    if (first.kind !== 'todo-section' || second.kind !== 'todo-section') throw new Error('unreachable')
    expect(first.todos.map(t => t.status)).toEqual(['completed', 'in_progress', 'pending', 'pending', 'pending'])
    expect(first.itemParts).toEqual({ 1: [1] })
    expect(first.carriedOver).toEqual([])
    // The continuation carries over from the plan state AT THE BREAK: steps 1
    // and 2 were shown by the card above (2 was in progress there) and are
    // merely marked done here.
    expect(second.persistKey).toBe('tw2')
    expect(second.carriedOver).toEqual(['step 1', 'step 2'])
    expect(executedTodoEntries(second.todos, new Set(second.carriedOver), second.itemParts).map(e => e.item.content))
      .toEqual(['step 3', 'step 4'])
    // The reply peels to the continuation's trailing slice as usual.
    expect(second.itemParts).toEqual({})
    expect(second.trailing).toEqual([5])
  })

  it('a continuation carries over from the break state, not from the message-level prior', () => {
    const step = (n: number, status: 'pending' | 'in_progress' | 'completed') => ({
      content: `step ${n}`,
      activeForm: `doing step ${n}`,
      status,
    })
    const parts: TodoSectionPartLike[] = [
      todoWrite([step(1, 'completed'), step(2, 'in_progress'), step(3, 'pending')], 'tw1'),
      tool('Agent', 'spawn'), // 1 — hoisted
      todoWrite([step(1, 'completed'), step(2, 'completed'), step(3, 'in_progress')], 'tw2'),
    ]

    const segments = buildTodoSections(parts, {
      hoistedIndices: new Set([1]),
      // The message-level prior knows nothing of step 2's progress; the break
      // state does.
      priorTodos: [{ content: 'step 1', status: 'completed' }],
    })

    const first = segments[0]!
    const second = segments[2]!
    if (first.kind !== 'todo-section' || second.kind !== 'todo-section') throw new Error('unreachable')
    expect(first.carriedOver).toEqual(['step 1'])
    expect(second.carriedOver).toEqual(['step 1', 'step 2'])
  })

  it('a break before the first TodoWrite carries over from the message-level prior', () => {
    const parts: TodoSectionPartLike[] = [
      tool('Agent', 'spawn'), // 0 — hoisted, no section open
      todoWrite([{ content: 'A', activeForm: 'Doing A', status: 'completed' }, { content: 'B', activeForm: 'Doing B', status: 'in_progress' }], 'tw'),
    ]

    const segments = buildTodoSections(parts, {
      hoistedIndices: new Set([0]),
      priorTodos: [{ content: 'A', status: 'in_progress' }],
    })

    const section = segments[1]!
    if (section.kind !== 'todo-section') throw new Error('unreachable')
    expect(section.carriedOver).toEqual(['a'])
  })

  it('segments identically whether the turn is live or settled', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
          { content: 'B', activeForm: 'Doing B', status: 'pending' },
        ],
        'tw',
      ),
      tool('Read', 'r1'), // 1
      tool('AskUserQuestion', 'q1'), // 2
    ]
    const hoistedIndices = new Set([2])

    const live = buildTodoSections(parts, { settled: false, hoistedIndices })
    const settled = buildTodoSections(parts, { settled: true, hoistedIndices })

    // Nothing here depends on the turn's state: the halted-and-pending render,
    // the answered render and the reloaded render are one and the same.
    expect(settled).toEqual(live)
    expect(live.map(s => s.kind)).toEqual(['todo-section', 'hoisted'])
  })

  it('does not peel the preamble to a hoisted question as a closing reply', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [{ content: 'A', activeForm: 'Doing A', status: 'in_progress' }],
        'tw',
      ),
      tool('Bash', 'b1'), // 1
      text(), // 2 — "let me ask you…", the question's bundled preamble
      tool('AskUserQuestion', 'q1'), // 3 — hoisted; the turn halts here
    ]

    const segments = buildTodoSections(parts, {
      settled: true,
      hoistedIndices: new Set([3]),
    })

    const section = segments[0]!
    if (section.kind !== 'todo-section') throw new Error('unreachable')
    // The tail text leads straight into the hoisted part: it is that part's
    // preamble, not the agent's answer, so it stays in the step.
    expect(section.itemParts).toEqual({ 0: [1, 2] })
    expect(section.trailing).toEqual([])
    expect(segments[1]).toEqual({ kind: 'hoisted', index: 3 })
  })

  it('peels the real reply after a hoisted question but not the preamble before it', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [{ content: 'A', activeForm: 'Doing A', status: 'in_progress' }],
        'tw',
      ),
      tool('Bash', 'b1'), // 1
      text(), // 2 — preamble to the question
      tool('AskUserQuestion', 'q1'), // 3 — hoisted, answered
      text(), // 4 — the closing reply after the answer (end_turn)
    ]

    const segments = buildTodoSections(parts, {
      settled: true,
      hoistedIndices: new Set([3]),
    })

    const section = segments[0]!
    if (section.kind !== 'todo-section') throw new Error('unreachable')
    // The section closes at the question with its preamble in the step; the
    // reply after the break is plain, below the question.
    expect(section.itemParts).toEqual({ 0: [1, 2] })
    expect(section.trailing).toEqual([])
    expect(segments[1]).toEqual({ kind: 'hoisted', index: 3 })
    expect(segments[2]).toEqual({ kind: 'plain', indices: [4] })
  })

  it('the peel stops at the gap an intermediate TodoWrite leaves in the bucket', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([{ content: 'A', activeForm: 'Doing A', status: 'in_progress' }], 'tw1'),
      tool('Bash', 'b1'), // 1
      text(), // 2 — preamble to the TodoWrite below
      todoWrite([{ content: 'A', activeForm: 'Doing A', status: 'in_progress' }], 'tw2'), // 3
      text(), // 4 — the closing reply
    ]

    const segments = buildTodoSections(parts, { settled: true })

    const section = segments[0]!
    if (section.kind !== 'todo-section') throw new Error('unreachable')
    expect(section.itemParts).toEqual({ 0: [1, 2] })
    expect(section.trailing).toEqual([4])
  })

  it('leaves the question in-flow when no hoisted indices are passed', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
          { content: 'B', activeForm: 'Doing B', status: 'pending' },
        ],
        'tw',
      ),
      tool('Bash', 'b1'), // 1
      tool('AskUserQuestion', 'q1'), // 2
    ]

    const segments = buildTodoSections(parts, { settled: true })

    expect(segments).toHaveLength(1)
    const section = segments[0]!
    if (section.kind !== 'todo-section') throw new Error('unreachable')
    // No hoist: the question stays bucketed under the step, plan intact.
    expect(section.todos.map(t => t.content)).toEqual(['A', 'B'])
    expect(section.itemParts).toEqual({ 0: [1, 2] })
  })

  it('splits a plain run around a hoisted question (buffer flushed first, run continues after)', () => {
    const parts: TodoSectionPartLike[] = [
      text(),
      tool('Bash', 'b1'),
      tool('AskUserQuestion', 'q1'), // 2
      tool('Bash', 'b2'), // 3 — resumed after the answer
    ]

    const segments = buildTodoSections(parts, { hoistedIndices: new Set([2]) })

    expect(segments).toEqual([
      { kind: 'plain', indices: [0, 1] },
      { kind: 'hoisted', index: 2 },
      { kind: 'plain', indices: [3] },
    ])
  })

  it('counts non-TodoWrite tool calls rendered in a section', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      ]),
      text(),
      tool('Read', 'r1'),
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'completed' },
      ]),
      tool('Done', 'done1'),
    ]
    const segments = buildTodoSections(parts)

    if (segments[0]!.kind !== 'todo-section') throw new Error('unreachable')
    expect(countSectionToolCalls(
      ['tool-call', 'text', 'tool-call', 'tool-call', 'tool-call'],
      segments[0]!,
      type => type === 'tool-call',
    )).toBe(2)
  })
})

describe('todo section tool summary', () => {
  it('aggregates file operations and chooses the running tool target', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      ]),
      {
        type: 'tool-call',
        toolName: 'Read',
        args: { file_path: 'D:\\repo\\Launcher.cpp' },
        status: { type: 'complete' },
      },
      {
        type: 'tool-call',
        toolName: 'Edit',
        args: { file_path: 'D:/repo/Launcher.cpp' },
        status: { type: 'running' },
      },
      {
        type: 'tool-call',
        toolName: 'Delete',
        args: { path: 'D:/repo/old.txt' },
        status: { type: 'complete' },
      },
    ]
    const segments = buildTodoSections(parts)
    const section = segments[0]!
    if (section.kind !== 'todo-section') throw new Error('unreachable')

    expect(summarizeTodoSectionTools(parts, section)).toEqual({
      callTotal: 3,
      fileOperations: { read: 1, edited: 1, deleted: 1 },
      currentOrLastTarget: 'Launcher.cpp',
    })
  })

  it('uses the last target when no tool is currently running', () => {
    expect(getTodoSectionToolTarget('Grep', { pattern: 'x' })).toBe('grep')
    expect(getTodoSectionToolTarget('Bash', { command: 'npm test' })).toBe('Bash')
  })
})
describe('applyFinishedTurnStatus', () => {
  const todo = (
    content: string,
    status: 'pending' | 'in_progress' | 'completed',
  ): TaskListEntry => ({ content, activeForm: `Doing ${content}`, status })

  it('resolves a trailing in_progress step to completed on a finished turn', () => {
    const todos = [todo('A', 'completed'), todo('B', 'in_progress')]

    const result = applyFinishedTurnStatus(todos, true)

    expect(result.map(t => t.status)).toEqual(['completed', 'completed'])
  })

  it('resolves the active step to completed even when pending steps remain', () => {
    // The turn finished (or the section was superseded) with work left on the
    // plan. The UI hides unexecuted (pending) items, so the visible plan must
    // read as done — resolving the active step keeps the header "Done" instead
    // of a misleading "Paused" for steps the user can no longer see.
    const todos = [
      todo('A', 'completed'),
      todo('B', 'in_progress'),
      todo('C', 'pending'),
    ]

    const result = applyFinishedTurnStatus(todos, true)

    expect(result).not.toBe(todos)
    expect(result.map(t => t.status)).toEqual([
      'completed',
      'completed',
      'pending',
    ])
  })

  it('is a no-op (same reference) when the turn is not finished', () => {
    const todos = [todo('A', 'in_progress')]

    const result = applyFinishedTurnStatus(todos, false)

    // Same reference → in_progress is preserved (renders "Paused"/"Working").
    expect(result).toBe(todos)
    expect(result[0]!.status).toBe('in_progress')
  })

  it('is a no-op (same reference) when there is no in_progress step', () => {
    const todos = [todo('A', 'completed'), todo('B', 'completed')]

    const result = applyFinishedTurnStatus(todos, true)

    expect(result).toBe(todos)
  })

  it('does not mutate the input array when it resolves a step', () => {
    const todos = [todo('A', 'in_progress')]

    const result = applyFinishedTurnStatus(todos, true)

    expect(result).not.toBe(todos)
    expect(todos[0]!.status).toBe('in_progress') // original untouched
    expect(result[0]!.status).toBe('completed')
  })
})

describe('executedTodoEntries', () => {
  const todo = (
    content: string,
    status: 'pending' | 'in_progress' | 'completed',
  ): TaskListEntry => ({ content, activeForm: `Doing ${content}`, status })

  it('drops pending items and keeps executed ones in list order', () => {
    // Models skip and reorder steps, so the UI renders only what actually ran.
    const todos = [
      todo('A', 'completed'),
      todo('B', 'pending'),
      todo('C', 'in_progress'),
      todo('D', 'pending'),
    ]

    const executed = executedTodoEntries(todos)

    expect(executed.map(e => e.item.content)).toEqual(['A', 'C'])
    expect(executed.map(e => e.item.status)).toEqual([
      'completed',
      'in_progress',
    ])
  })

  it('preserves the ORIGINAL index so itemParts lookups stay valid', () => {
    // After filtering, item 'C' is display position 1 but still lives at index 2
    // of the full list — itemParts / update-text buckets are keyed by the full
    // position, so re-numbering would mis-attribute nested tool calls.
    const todos = [
      todo('A', 'completed'),
      todo('B', 'pending'),
      todo('C', 'in_progress'),
    ]

    const executed = executedTodoEntries(todos)

    expect(executed.map(e => e.originalIndex)).toEqual([0, 2])
  })

  it('returns an empty list when nothing has been executed yet', () => {
    const todos = [todo('A', 'pending'), todo('B', 'pending')]

    expect(executedTodoEntries(todos)).toEqual([])
  })

  it('returns every item (original order) when all are executed', () => {
    const todos = [todo('A', 'completed'), todo('B', 'in_progress')]

    const executed = executedTodoEntries(todos)

    expect(executed.map(e => e.originalIndex)).toEqual([0, 1])
    expect(executed.map(e => e.item.content)).toEqual(['A', 'B'])
  })
})

describe('buildTodoSections — hoisted teammate spawn', () => {
  // Starting a teammate is a second CONVERSATION, not a step in this one. As a
  // plain part it sat inside a plan step, and a collapsed step unmounts its
  // content — so the spawn was invisible unless the user expanded exactly the
  // right container. This is the break-out that fixes that.
  it('lifts the spawn to its own segment and keeps the plan intact', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(
        [
          { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
          { content: 'B', activeForm: 'Doing B', status: 'pending' },
        ],
        'tw',
      ),
      tool('Read', 'r1'), // 1 — work under A
      tool('Agent', 'spawn'), // 2 — the spawn
      tool('Read', 'r2'), // 3 — work after the spawn, before any TodoWrite
    ]

    const segments = buildTodoSections(parts, { hoistedIndices: new Set([2]) })

    expect(segments).toHaveLength(3)
    const section = segments[0]!
    if (section.kind !== 'todo-section') throw new Error('unreachable')
    // The plan is intact (pending steps kept): the turn did not halt, it
    // started a teammate partway through the work. The card shows the plan up
    // to the break; what follows is plain until the next TodoWrite.
    expect(section.todos.map(t => t.content)).toEqual(['A', 'B'])
    expect(section.itemParts).toEqual({ 0: [1] })
    expect(segments[1]).toEqual({ kind: 'hoisted', index: 2 })
    expect(segments[2]).toEqual({ kind: 'plain', indices: [3] })
  })

  it('lifts it out of a plain run too, flushing what came before', () => {
    const parts: TodoSectionPartLike[] = [
      tool('Read', 'r1'),
      tool('Agent', 'spawn'),
      tool('Read', 'r2'),
    ]

    const segments = buildTodoSections(parts, { hoistedIndices: new Set([1]) })

    expect(segments).toEqual([
      { kind: 'plain', indices: [0] },
      { kind: 'hoisted', index: 1 },
      { kind: 'plain', indices: [2] },
    ])
  })

  it('leaves the part in-flow when no hoisted indices are passed', () => {
    const parts: TodoSectionPartLike[] = [tool('Read'), tool('Agent')]

    expect(buildTodoSections(parts)).toEqual([
      { kind: 'plain', indices: [0, 1] },
    ])
  })
})

describe('buildTodoSections — a plan continued across a turn boundary', () => {
  // The body segments one message at a time. A plan that resumes after a
  // teammate's report / a user reply re-sends the whole list in its first
  // TodoWrite, so each new card rendered every step again (a plan broken
  // twice showed every step three times). The conversion stamps the message
  // with the plan state that preceded it; steps completed on BOTH sides are
  // this card's `carriedOver` and stay hidden.
  const plan = (statuses: Array<'pending' | 'in_progress' | 'completed'>) =>
    statuses.map((status, i) => ({
      content: `step ${i + 1}`,
      activeForm: `doing step ${i + 1}`,
      status,
    }))

  it('records the steps already finished before this message as carriedOver', () => {
    const parts: TodoSectionPartLike[] = [
      todoWrite(plan(['completed', 'completed', 'completed', 'in_progress', 'pending']), 'tw2'),
      tool('Bash', 'b1'),
    ]

    const segments = buildTodoSections(parts, {
      priorTodos: plan(['completed', 'completed', 'completed', 'in_progress', 'pending']),
    })

    const section = segments[0]!
    if (section.kind !== 'todo-section') throw new Error('unreachable')
    expect(section.carriedOver).toEqual(['step 1', 'step 2', 'step 3'])
    // The full plan is still the section's plan — only the RENDER hides them.
    expect(section.todos).toHaveLength(5)
    expect(section.itemParts).toEqual({ 3: [1] })
  })

  it('a step left in_progress at the boundary and completed at open was already shown — carried over', () => {
    // The earlier card resolved it to done when its turn finished (a clean
    // end_turn), so listing it again here is the reported duplicate.
    expect(
      carriedOverTodoIdentities(
        plan(['completed', 'completed', 'in_progress']),
        plan(['completed', 'in_progress', 'pending']),
      ),
    ).toEqual(['step 1', 'step 2'])
  })

  it('a step still in_progress at open is this card\u2019s own even though it was shown before', () => {
    expect(
      carriedOverTodoIdentities(
        plan(['completed', 'in_progress']),
        plan(['completed', 'in_progress']),
      ),
    ).toEqual(['step 1'])
  })

  it('carries nothing over without a prior plan, or when the prior finished nothing', () => {
    expect(carriedOverTodoIdentities(plan(['completed', 'in_progress']), undefined)).toEqual([])
    expect(carriedOverTodoIdentities(plan(['completed', 'in_progress']), [])).toEqual([])
    // Pending before = never shown before: completing it here is this card's.
    expect(
      carriedOverTodoIdentities(plan(['completed']), plan(['pending'])),
    ).toEqual([])
    const parts: TodoSectionPartLike[] = [todoWrite(plan(['completed', 'in_progress']))]
    const [section] = buildTodoSections(parts)
    if (section!.kind !== 'todo-section') throw new Error('unreachable')
    expect(section!.carriedOver).toEqual([])
  })

  it('matches steps by identity, not position (a shortened or reordered list)', () => {
    const prior = [
      { content: 'Investigate', status: 'completed' as const },
      { content: 'Fix', status: 'pending' as const },
    ]
    const opening = [
      { content: 'fix', activeForm: 'Fixing', status: 'completed' as const },
      { content: '  Investigate ', activeForm: 'Investigating', status: 'completed' as const },
      { content: 'Verify', activeForm: 'Verifying', status: 'in_progress' as const },
    ]
    expect(carriedOverTodoIdentities(opening, prior)).toEqual(['investigate'])
  })
})

describe('executedTodoEntries — carried-over steps', () => {
  const todo = (
    content: string,
    status: 'pending' | 'in_progress' | 'completed',
  ): TaskListEntry => ({ content, activeForm: `doing ${content}`, status })

  it('hides a carried-over step while it is still completed, keeping original indices', () => {
    const todos = [todo('A', 'completed'), todo('B', 'completed'), todo('C', 'in_progress'), todo('D', 'pending')]

    const executed = executedTodoEntries(todos, new Set(['a', 'b']))

    expect(executed.map(e => e.item.content)).toEqual(['C'])
    expect(executed.map(e => e.originalIndex)).toEqual([2])
  })

  it('shows a carried-over step again once the model moves it back to in_progress', () => {
    const todos = [todo('A', 'in_progress'), todo('B', 'completed')]

    const executed = executedTodoEntries(todos, new Set(['a', 'b']))

    expect(executed.map(e => e.item.content)).toEqual(['A'])
  })

  it('keeps a carried-over step that was reopened and completed again — it owns parts now', () => {
    // TodoWrite[c,i], Bash, TodoWrite[i,c], Bash, TodoWrite[c,c]
    // with prior [c,i] — step 1 is carried over, reopened, worked on (part 3)
    // and completed again. Filtering on its LATEST status alone hid the row
    // and, with it, the bucket nothing else renders.
    const parts: TodoSectionPartLike[] = [
      todoWrite([
        { content: 'step 1', activeForm: 'doing 1', status: 'completed' },
        { content: 'step 2', activeForm: 'doing 2', status: 'in_progress' },
      ], 'tw1'),
      tool('Bash', 'b1'), // 1 — under step 2
      todoWrite([
        { content: 'step 1', activeForm: 'doing 1', status: 'in_progress' },
        { content: 'step 2', activeForm: 'doing 2', status: 'completed' },
      ], 'tw2'),
      tool('Bash', 'b2'), // 3 — under the reopened step 1
      todoWrite([
        { content: 'step 1', activeForm: 'doing 1', status: 'completed' },
        { content: 'step 2', activeForm: 'doing 2', status: 'completed' },
      ], 'tw3'),
    ]
    const [section] = buildTodoSections(parts, {
      priorTodos: [
        { content: 'step 1', status: 'completed' },
        { content: 'step 2', status: 'in_progress' },
      ],
    })
    if (section!.kind !== 'todo-section') throw new Error('unreachable')
    expect(section!.carriedOver).toEqual(['step 1'])
    expect(section!.itemParts).toEqual({ 0: [3], 1: [1] })

    const executed = executedTodoEntries(
      section!.todos,
      new Set(section!.carriedOver),
      section!.itemParts,
    )
    // Both rows render: step 1 owns part 3, so it is this card's work too.
    expect(executed.map(e => e.originalIndex)).toEqual([0, 1])

    // Without a bucket the same carried-over step is hidden (the plain case).
    expect(
      executedTodoEntries(section!.todos, new Set(section!.carriedOver), { 1: [1] })
        .map(e => e.originalIndex),
    ).toEqual([1])
  })

  it('hides nothing extra without a carried-over set', () => {
    const todos = [todo('A', 'completed'), todo('B', 'pending')]
    expect(executedTodoEntries(todos).map(e => e.item.content)).toEqual(['A'])
  })
})

describe('parsePriorTodos', () => {
  it('round-trips the stamped JSON and rejects anything else', () => {
    const json = JSON.stringify([
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
    ])
    expect(parsePriorTodos(json)).toEqual([
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
    ])
    expect(parsePriorTodos(undefined)).toBeUndefined()
    expect(parsePriorTodos('')).toBeUndefined()
    expect(parsePriorTodos('not json')).toBeUndefined()
    expect(parsePriorTodos(JSON.stringify({ content: 'A' }))).toBeUndefined()
    expect(parsePriorTodos(JSON.stringify([{ content: 'A', status: 'done' }]))).toBeUndefined()
  })
})
