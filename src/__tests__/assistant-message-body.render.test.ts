// @vitest-environment happy-dom
import { createElement, type FC } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { AssistantMessageBody } from '../components/assistant-ui/assistant-message-body'

/**
 * A standalone part (an AskUserQuestion here) lands in the same place in the rendered message body at every
 * point in its life: the hoist is decided from the part's identity alone.
 */

function makeHarness(message: ThreadMessageLike, isRunning: boolean): FC {
  const AssistantMessage: FC = () => createElement(AssistantMessageBody)
  const UserMessage: FC = () => null // required by the components contract
  return function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [message],
      convertMessage: (m) => m,
      isRunning,
      onNew: async () => {},
    })
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(
        ThreadPrimitive.Root,
        null,
        createElement(
          ThreadPrimitive.Viewport,
          null,
          createElement(ThreadPrimitive.Messages, {
            components: { AssistantMessage, UserMessage },
          }),
        ),
      ),
    )
  }
}

const TODO_WRITE = {
  type: 'tool-call' as const,
  toolCallId: 'tw',
  toolName: 'TodoWrite',
  args: {
    todos: [
      {
        content: 'Choose a framework',
        activeForm: 'Choosing a framework',
        status: 'in_progress',
      },
      { content: 'Scaffold the app', activeForm: 'Scaffolding', status: 'pending' },
    ],
  },
  result: 'ok',
}

const BASH = {
  type: 'tool-call' as const,
  toolCallId: 'b1',
  toolName: 'Bash',
  args: { command: 'ls' },
  result: 'ok',
}

const question = (result?: unknown) => ({
  type: 'tool-call' as const,
  toolCallId: 'q1',
  toolName: 'AskUserQuestion',
  args: {
    questions: [
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [{ label: 'React', description: 'Component-based.' }],
      },
    ],
  },
  ...(result === undefined ? {} : { result }),
})

/**
 * The question row's placement. No tool UI is registered here, so the
 * AskUserQuestion part renders through ToolFallback and is found by its
 * `tool-row-<name>` testid — the same marker the e2e probes use.
 */
async function readPlacement(container: HTMLElement) {
  await waitFor(() => {
    // The body defers its first paint one macrotask (hydration gate).
    expect(container.querySelector('[data-slot="assistant-message-body"]')).not.toBeNull()
  })
  const row = container.querySelector('[data-testid="tool-row-AskUserQuestion"]')
  return {
    rendered: row !== null,
    insideInteractionSegment: !!row?.closest('[data-slot="interaction-request"]'),
    insideTodoStep: !!row?.closest('[data-slot="todo-section-content"]'),
    topLevelSegments: container.querySelector('[data-slot="assistant-message-body"]')!
      .children.length,
  }
}


/** Every multi-tool card mounts COLLAPSED now, running or settled, so the
 *  row-level assertions below open the card first — the one click a user
 *  makes. Clicks every closed Plan card trigger under `root`. */
function openPlanCards(root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLElement>(
      '[data-slot="tool-plan-stream-trigger"][data-state="closed"], ' +
        '[data-slot="todo-section-trigger"][data-state="closed"]',
    )
    .forEach((el) => fireEvent.click(el))
}

describe('AssistantMessageBody — standalone parts are hoisted structurally', () => {
  afterEach(cleanup)

  it('a pending question in a LIVE plan step renders top-level, never inside the step', async () => {
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'running' },
        content: [TODO_WRITE, BASH, question()],
      },
      true,
    )
    const { container } = render(createElement(Harness))
    openPlanCards(container)

    const placement = await readPlacement(container)
    expect(placement.rendered, 'the question must be on screen').toBe(true)
    expect(placement.insideInteractionSegment).toBe(true)
    expect(placement.insideTodoStep).toBe(false)
    // Plan card + hoisted question.
    expect(placement.topLevelSegments).toBe(2)
  })

  it('the ANSWERED question stays top-level once the turn settles (no fold-back into the step)', async () => {
    // A persisted question always carries its result, so this is also what a
    // reload and a session switch render. Before the fix the question folded
    // back into the collapsed-by-default step here and vanished from view.
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [TODO_WRITE, BASH, question('React'), { type: 'text', text: 'React it is.' }],
      },
      false,
    )
    const { container } = render(createElement(Harness))
    openPlanCards(container)

    const placement = await readPlacement(container)
    expect(placement.rendered, 'the answered question must still be on screen').toBe(true)
    expect(placement.insideInteractionSegment).toBe(true)
    expect(placement.insideTodoStep).toBe(false)
    // Plan card, hoisted question, and the closing reply — plain, below the
    // question: the section closes at the break, so what follows the answer
    // is not folded back into the card.
    expect(placement.topLevelSegments).toBe(3)
  })

  it('an answered question in a plain tool run stays top-level as well', async () => {
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [
          { type: 'text', text: 'looking around' },
          BASH,
          { ...BASH, toolCallId: 'b2' },
          question('React'),
          { ...BASH, toolCallId: 'b3' },
        ],
      },
      false,
    )
    const { container } = render(createElement(Harness))
    openPlanCards(container)

    const placement = await readPlacement(container)
    expect(placement.rendered).toBe(true)
    expect(placement.insideInteractionSegment).toBe(true)
    // The run before it, the question, the run after it.
    expect(placement.topLevelSegments).toBe(3)
  })
})

describe('AssistantMessageBody — a plan continued across a turn boundary shows only its own steps', () => {
  afterEach(cleanup)

  const plan = (
    statuses: Array<'pending' | 'in_progress' | 'completed'>,
  ) =>
    statuses.map((status, i) => ({
      content: `step ${i + 1}`,
      activeForm: `doing step ${i + 1}`,
      status,
    }))
  const todoWrite = (
    statuses: Array<'pending' | 'in_progress' | 'completed'>,
    id = 'tw',
  ) => ({
    type: 'tool-call' as const,
    toolCallId: id,
    toolName: 'TodoWrite',
    args: { todos: plan(statuses) },
    result: 'ok',
  })

  /** Row titles of EVERY plan card, in document order. */
  async function readAllRows(container: HTMLElement): Promise<string[][]> {
    await waitFor(() => {
      expect(container.querySelector('[data-slot="assistant-message-body"]')).not.toBeNull()
    })
    return Array.from(container.querySelectorAll('[data-slot="todo-section-content"]')).map(
      (content) =>
        Array.from(content.querySelectorAll('li'))
          .filter((li) => !li.parentElement?.closest('li'))
          .map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim()),
    )
  }

  /** Titles of the plan card's rows (the `<li>`s in its content). */
  async function readRows(container: HTMLElement): Promise<string[] | null> {
    await waitFor(() => {
      expect(container.querySelector('[data-slot="assistant-message-body"]')).not.toBeNull()
    })
    const content = container.querySelector('[data-slot="todo-section-content"]')
    if (!content) return null
    return Array.from(content.querySelectorAll('li'))
      .filter((li) => !li.parentElement?.closest('li'))
      .map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim())
  }

  it('hides the steps already finished before this message (the bug: every card re-listed the whole plan)', async () => {
    // Turn 2 of a plan: steps 1–3 were shown and finished in turn 1's card;
    // this turn re-sends the list and works on step 4.
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        metadata: {
          custom: {
            priorTodos: JSON.stringify(
              plan(['completed', 'completed', 'completed', 'in_progress', 'pending']),
            ),
          },
        },
        content: [
          todoWrite(['completed', 'completed', 'completed', 'in_progress', 'pending']),
          BASH,
          todoWrite(['completed', 'completed', 'completed', 'completed', 'in_progress'], 'tw2'),
        ],
      },
      false,
    )
    const { container } = render(createElement(Harness))
    openPlanCards(container)

    const rows = await readRows(container)
    expect(rows).not.toBeNull()
    // Only this card's own work: step 4 (finished here) and step 5 (running,
    // resolved to done on the clean finish). Steps 1–3 belong to the earlier card.
    expect(rows!.join(' | ')).toContain('step 4')
    expect(rows!.join(' | ')).toContain('step 5')
    expect(rows!.join(' | ')).not.toContain('step 1')
    expect(rows!.join(' | ')).not.toContain('step 2')
    expect(rows!.join(' | ')).not.toContain('step 3')
    expect(rows).toHaveLength(2)
  })

  it('a carried-over step reopened and completed again in this card keeps its row and its parts', async () => {
    // The step's latest status is `completed` and it is
    // carried over, but it was worked on HERE (its bucket holds a Bash) —
    // hiding the row would drop that Bash from the transcript entirely.
    const step = (
      s1: 'pending' | 'in_progress' | 'completed',
      s2: 'pending' | 'in_progress' | 'completed',
      id: string,
    ) => ({
      type: 'tool-call' as const,
      toolCallId: id,
      toolName: 'TodoWrite',
      args: {
        todos: [
          { content: 'step 1', activeForm: 'doing step 1', status: s1 },
          { content: 'step 2', activeForm: 'doing step 2', status: s2 },
        ],
      },
      result: 'ok',
    })
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        metadata: {
          custom: {
            priorTodos: JSON.stringify([
              { content: 'step 1', status: 'completed' },
              { content: 'step 2', status: 'in_progress' },
            ]),
          },
        },
        content: [
          step('completed', 'in_progress', 'tw1'),
          BASH,
          step('in_progress', 'completed', 'tw2'),
          { ...BASH, toolCallId: 'b-reopened', args: { command: 'echo reopened-step-work' } },
          step('completed', 'completed', 'tw3'),
        ],
      },
      false,
    )
    const { container } = render(createElement(Harness))
    openPlanCards(container)

    const rows = await readRows(container)
    expect(rows).not.toBeNull()
    expect(rows!.join(' | ')).toContain('step 1')
    expect(rows!.join(' | ')).toContain('step 2')
    expect(rows).toHaveLength(2)
    // The reopened step's tool call is in the DOM (inside its collapsed row —
    // the row's Collapsible keeps the trigger mounted; expand it to check).
    const trigger = Array.from(container.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').includes('step 1'),
    )
    expect(trigger, 'the step 1 row must be rendered with a trigger').toBeDefined()
    fireEvent.click(trigger!)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="tool-row-Bash"]')).not.toBeNull()
    })
  })

  it('a spawn mid-plan splits the plan into a card per chunk, each listing only its own steps', async () => {
    // The reported session, in one assistant message: TodoWrite[c,i,p,p,p],
    // a question, a spawn, TodoWrite[c,c,c,i,p], the reply. Card 1 must show
    // steps 1–2 (the plan at the break), card 2 steps 3–4 — not every step
    // of the turn in both.
    const write = (
      statuses: Array<'pending' | 'in_progress' | 'completed'>,
      id: string,
    ) => ({
      type: 'tool-call' as const,
      toolCallId: id,
      toolName: 'TodoWrite',
      args: { todos: plan(statuses) },
      result: 'ok',
    })
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [
          write(['completed', 'in_progress', 'pending', 'pending', 'pending'], 'tw1'),
          BASH,
          question('React'),
          {
            type: 'tool-call' as const,
            toolCallId: 'spawn',
            toolName: 'Agent',
            args: { name: 'team-hide', prompt: 'hide it' },
            result: 'Spawned teammate "team-hide" (session teammate-1)',
          },
          write(['completed', 'completed', 'completed', 'in_progress', 'pending'], 'tw2'),
          { type: 'text', text: 'Spawned the teammate.' },
        ],
      },
      false,
    )
    const { container } = render(createElement(Harness))
    openPlanCards(container)

    const cards = await readAllRows(container)
    expect(cards, `expected two plan cards; got ${JSON.stringify(cards)}`).toHaveLength(2)
    expect(cards[0]!.join(' | ')).toContain('step 1')
    expect(cards[0]!.join(' | ')).toContain('step 2')
    expect(cards[0]).toHaveLength(2)
    expect(cards[1]!.join(' | ')).toContain('step 3')
    expect(cards[1]!.join(' | ')).toContain('step 4')
    expect(cards[1]!.join(' | ')).not.toContain('step 1')
    expect(cards[1]!.join(' | ')).not.toContain('step 2')
    expect(cards[1]).toHaveLength(2)
  })

  it('without a prior plan the first card shows every executed step', async () => {
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [todoWrite(['completed', 'completed', 'in_progress', 'pending']), BASH],
      },
      false,
    )
    const { container } = render(createElement(Harness))
    openPlanCards(container)

    const rows = await readRows(container)
    expect(rows).toHaveLength(3)
  })

  it('renders no plan card at all when every step was carried over (only the parts flow out)', async () => {
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        metadata: {
          custom: { priorTodos: JSON.stringify(plan(['completed', 'completed'])) },
        },
        content: [
          todoWrite(['completed', 'completed']),
          { type: 'text', text: 'all done already' },
        ],
      },
      false,
    )
    const { container } = render(createElement(Harness))
    openPlanCards(container)

    const rows = await readRows(container)
    expect(rows).toBeNull()
    expect(container.querySelector('[data-slot="todo-section-root"]')).toBeNull()
    expect(container.textContent).toContain('all done already')
  })
})

describe('AssistantMessageBody — a turn\'s closing reply renders top-level', () => {
  afterEach(cleanup)

  // A merged turn row can carry MORE tool calls after an `end_turn` reply (a
  // task-notification or hook wakes the agent again). The reply then sat
  // between two tool calls, the grouping pass absorbed it as a preamble, and
  // the collapsed group / plan step hid the one text the user needed to read.
  // The conversion marks it `endTurn`; the body must keep it out of both.
  const REPLY = 'All done — the build is green.'
  const reply = { type: 'text' as const, text: REPLY, endTurn: true }

  async function readReply(container: HTMLElement) {
    await waitFor(() => {
      expect(container.querySelector('[data-slot="assistant-message-body"]')).not.toBeNull()
    })
    const holder = Array.from(container.querySelectorAll<HTMLElement>('p, div, span'))
      .find((el) => el.children.length === 0 && el.textContent?.includes(REPLY))
    return {
      rendered: holder !== undefined,
      insideToolGroup: !!holder?.closest(
        '[data-slot="tool-plan-stream-root"], [data-slot="tool-group-root"]',
      ),
      insideTodoStep: !!holder?.closest('[data-slot="todo-section-root"]'),
    }
  }

  it('stays out of a collapsed tool run when more tool calls follow it', async () => {
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [BASH, reply, { ...BASH, toolCallId: 'b2' }, { ...BASH, toolCallId: 'b3' }],
      } as ThreadMessageLike,
      false,
    )
    const { container } = render(createElement(Harness))
    await waitFor(async () => {
      const placement = await readReply(container)
      expect(placement.rendered).toBe(true)
      expect(placement.insideToolGroup).toBe(false)
    })
  })

  it('is lifted out of the plan step it landed in', async () => {
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'running' },
        content: [TODO_WRITE, BASH, reply, { ...BASH, toolCallId: 'b2' }],
      } as ThreadMessageLike,
      true,
    )
    const { container } = render(createElement(Harness))
    await waitFor(async () => {
      const placement = await readReply(container)
      expect(placement.rendered).toBe(true)
      expect(placement.insideTodoStep).toBe(false)
      expect(placement.insideToolGroup).toBe(false)
    })
  })

  it('an unmarked preamble between two tool calls still folds into the run', async () => {
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [BASH, { type: 'text', text: REPLY }, { ...BASH, toolCallId: 'b2' }],
      },
      false,
    )
    const { container } = render(createElement(Harness))
    await waitFor(() => {
      expect(container.querySelector('[data-slot="tool-plan-stream-root"]')).not.toBeNull()
    })
    const placement = await readReply(container)
    // Absent (collapsed) or shown as the card's caption — never top-level.
    expect(!placement.rendered || placement.insideToolGroup).toBe(true)
  })
})

describe('AssistantMessageBody — reasoning is a row of the tool card, not a break in it', () => {
  afterEach(cleanup)

  // Reported: `reasoning1 tool2 tool3 reasoning4 tool5 tool6` rendered as FOUR
  // surfaces — a reasoning block, a two-tool card, a reasoning block, a
  // two-tool card. Each thought split the run. It is one card with six rows,
  // collapsed, its header following the latest thought.
  const thought = (text: string) => ({ type: 'reasoning' as const, text })
  const bash = (id: string, result?: unknown) => ({
    type: 'tool-call' as const,
    toolCallId: id,
    toolName: 'Bash',
    args: { command: `echo ${id}` },
    ...(result === undefined ? {} : { result }),
  })

  it('renders reasoning1 tool2 tool3 reasoning4 tool5 tool6 as ONE card holding six rows', async () => {
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [
          thought('Look at the build first.'),
          bash('t2', 'ok'),
          bash('t3', 'ok'),
          thought('The build passes; now the tests.'),
          bash('t5', 'ok'),
          bash('t6', 'ok'),
        ],
      } as ThreadMessageLike,
      false,
    )
    const { container } = render(createElement(Harness))
    await waitFor(() => {
      expect(container.querySelector('[data-slot="tool-plan-stream-root"]')).not.toBeNull()
    })
    expect(container.querySelectorAll('[data-slot="tool-plan-stream-root"]').length).toBe(1)
    // No standalone reasoning block survives beside the card.
    expect(container.querySelector('[data-slot="reasoning-root"]')).toBeNull()
    // Collapsed by default.
    const trigger = container.querySelector<HTMLElement>('[data-slot="tool-plan-stream-trigger"]')!
    expect(trigger.getAttribute('data-state')).toBe('closed')
    fireEvent.click(trigger)
    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="plan-list-item-trigger"]').length).toBe(6)
    })
    expect(container.querySelectorAll('[data-slot="plan-reasoning-row-label"]').length).toBe(2)
  })

  it('a live run whose tail is a thought shows that thought in the collapsed header', async () => {
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'running' },
        content: [
          thought('Look at the build first.'),
          bash('t2', 'ok'),
          bash('t3', 'ok'),
          thought('The build passes; now the tests.'),
        ],
      } as ThreadMessageLike,
      true,
    )
    const { container } = render(createElement(Harness))
    await waitFor(() => {
      expect(container.querySelector('[data-slot="tool-plan-stream-current-update"]')).not.toBeNull()
    })
    expect(container.querySelectorAll('[data-slot="tool-plan-stream-root"]').length).toBe(1)
    expect(container.querySelector('[data-slot="reasoning-root"]')).toBeNull()
    const update = container.querySelector('[data-slot="tool-plan-stream-current-update"]')!
    expect(update.textContent).toContain('The build passes; now the tests.')
    expect(update.textContent).not.toContain('Look at the build first.')
  })

  it('reasoning with no tool call beside it keeps its own reasoning block', async () => {
    const Harness = makeHarness(
      {
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [thought('Simple question.'), { type: 'text', text: 'Hello.' }],
      } as ThreadMessageLike,
      false,
    )
    const { container } = render(createElement(Harness))
    await waitFor(() => {
      expect(container.querySelector('[data-slot="reasoning-root"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-slot="tool-plan-stream-root"]')).toBeNull()
  })
})
