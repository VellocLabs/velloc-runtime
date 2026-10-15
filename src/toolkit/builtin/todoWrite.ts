import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import type { TaskListEntry, TodoStatus } from '../../runtime/RuntimeTypes'

export const CHECKLIST_TOOL_ID = 'TodoWrite'

// The tool's description and prompt are module-level constants rather than
// inline async functions in the tool definition. The Edit-tool example in
// the prompt names "Edit" literally: nexus_web's Edit tool ships from the
// C++ FileTool category under that wire name.
//
// DESCRIPTION is the short tool description; the longer guidance lives in
// PROMPT below.
export const DESCRIPTION =
  'Replaces the session\'s task checklist, which the user watches as you work. Keep it current: write it when the work has several steps, mark the step you are on, and close steps as they finish. Each entry needs `content` (what to do) and `activeForm` (what is happening now).'

export const PROMPT = `Maintains the checklist the user sees beside the conversation. Each call replaces the whole list, so send every item you still want shown.

## Use it when
- the work has three or more distinct steps;
- the request needs planning or touches several places;
- the user asks for a task list, or hands you several tasks at once (a numbered list, a comma-separated list, a follow-up that adds work);
- new instructions arrive mid-task: capture them as items right away;
- you are about to start an item: mark it \`in_progress\` before the first tool call;
- you finish an item: mark it \`completed\` at once and add any follow-up work you discovered.

## Leave it alone when
- there is one straightforward task, or fewer than three trivial steps;
- the request is a question or a conversation rather than work;
- tracking would cost more than it shows: a one-line fix, a single command, one comment.

Doing a small thing directly beats announcing it.

## Entries
Every entry has three fields:
- \`content\`: the task as an instruction, for example "Add the retry flag to the CLI parser".
- \`activeForm\`: the same task as it reads while running, for example "Adding the retry flag to the CLI parser".
- \`status\`: \`pending\`, \`in_progress\` or \`completed\`.

Rules the user relies on:
- One item is \`in_progress\` at a time: the one you are working on. Finish it before starting another, unless it is blocked. While you wait on the user or on something outside your control, the list may have no \`in_progress\` item at all; do not invent one.
- Update status as it happens, not in a batch at the end.
- \`completed\` means done and working. A failing test, a partial change, an unresolved error or a missing dependency means the item is not complete.
- When an item is blocked, put it back to \`pending\` with the reason in its \`content\` ("Wire the retry flag: blocked until the parser accepts booleans"), add an item for clearing the block, and make that the \`in_progress\` one.
- Drop items that no longer apply instead of leaving them pending.
- Keep items concrete and small enough to finish in one stretch; split large ones.

## Worked cases
Use the list:
- "Migrate the config loader from INI to TOML and keep the old files working." Four items: write the TOML reader, add the fallback for INI, port the fixtures, run the suite. Mark the first \`in_progress\` and begin.
- "Rename \`fetchUser\` to \`loadAccount\` everywhere." After a search shows it in nine files, one item per file keeps every occurrence accounted for.
- "Set up login, a product page and checkout for the shop." One item per feature, broken down further as each is started.

Skip the list:
- "What does \`git rebase --onto\` do?" A question: answer it.
- "Add a docstring to \`parse_args\`." One change in one place: make it with Edit.
- "Run the linter and tell me what it says." One command: run it and report.

If the choice is unclear, use the list. A visible plan is cheap, and the user can correct it early.
`

const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set<TodoStatus>([
  'pending',
  'in_progress',
  'completed',
])

export type TodoWriteInput = {
  todos?: TaskListEntry[]
}

// The model-facing tool result is a prose string (see
// `call`). The old `{oldTodos, newTodos}` dict shape is no longer
// emitted — todo state flows to the UI via `setAppState`.
export type TodoWriteOutput = string

function isTodoItem(value: unknown): value is TaskListEntry {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Partial<TaskListEntry>
  return (
    typeof item.content === 'string' &&
    item.content.length > 0 &&
    typeof item.activeForm === 'string' &&
    item.activeForm.length > 0 &&
    typeof item.status === 'string' &&
    VALID_STATUSES.has(item.status as TodoStatus)
  )
}

function getStateKey(context: ToolCallContext): string {
  return context.agentId ?? context.options.sessionId ?? 'default'
}

function readTodos(context: ToolCallContext): TaskListEntry[] {
  const state = context.readAppState()
  const bucket = state.todos?.[getStateKey(context)]
  return Array.isArray(bucket) ? bucket : []
}

export const ChecklistTool: ToolContract<TodoWriteInput, TodoWriteOutput> = declareTool({
  name: CHECKLIST_TOOL_ID,
  discoveryHint: 'manage the session task checklist',
  argsSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', minLength: 1 },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
            activeForm: { type: 'string', minLength: 1 },
          },
          required: ['content', 'status', 'activeForm'],
          additionalProperties: false,
        },
        description: 'The updated todo list',
      },
    },
    required: ['todos'],
  },
  // Strict-mode schema (no `minLength`/`format`/`pattern`); `validateInput` still
  // enforces non-empty content. `serializeToolsForModel` picks per request.
  inputJSONSchemaStrict: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
            activeForm: { type: 'string' },
          },
          required: ['content', 'status', 'activeForm'],
          additionalProperties: false,
        },
        description: 'The updated todo list',
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  strict: true,
  description: async () => DESCRIPTION,
  parallelSafe: () => false,
  readsOnly: () => false,
  async checkInput(
    input: TodoWriteInput,
    _context: ToolCallContext,
  ): Promise<InputCheck> {
    if (!Array.isArray(input.todos)) {
      return {
        result: false,
        message: 'todos must be an array.',
        errorCode: 1,
      }
    }
    for (let i = 0; i < input.todos.length; i++) {
      if (!isTodoItem(input.todos[i])) {
        return {
          result: false,
          message: `todos[${i}] must be { content: string, status: 'pending'|'in_progress'|'completed', activeForm: string }.`,
          errorCode: 2,
        }
      }
    }
    // "Exactly ONE in_progress" is PROMPT guidance only — validation does not
    // count in_progress items, so a transitional write with two in_progress
    // items (closing task A while
    // starting task B in one update) is ACCEPTED. nexus used to hard-reject it
    // here (errorCode 3), which orphaned lists: the rejected model would often
    // recover by writing a fresh minimal list, abandoning the old items. Same
    // soft-hint-promoted-to-rejection trap as the AskUserQuestion `header` bug.
    return { result: true }
  },
  call: async (input: TodoWriteInput, context: ToolCallContext) => {
    const todos = (input.todos ?? []) as TaskListEntry[]
    const oldTodos = readTodos(context)

    // When every todo is marked completed, treat the list
    // as fully consumed and clear it so the next planning step starts fresh.
    const allDone =
      todos.length > 0 && todos.every(item => item.status === 'completed')
    const persisted: TaskListEntry[] = allDone ? [] : todos
    const stateKey = getStateKey(context)

    context.writeAppState(prev => ({
      ...prev,
      todos: {
        ...(prev.todos ?? {}),
        [stateKey]: persisted,
      },
    }))

    // Verification nudge, ungated. It fires on the main thread when a list of
    // ≥3 items is all done and no item mentions verification (/verif/i).
    let nudge = ''
    if (
      !context.agentId &&
      allDone &&
      todos.length >= 3 &&
      !todos.some(t => /verif/i.test(t.content))
    ) {
      nudge =
        '\n\nNote: three or more items were just completed and none of them verified the result. Before summarising, check the work end to end: run the tests, re-read the changed files, or confirm what the user will see.'
    }

    return {
      data:
        'Checklist updated. Keep it current as you work, and carry on with the open items.' +
        nudge,
    }
  },
})
