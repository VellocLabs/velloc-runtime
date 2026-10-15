import type { TaskListEntry } from '../runtime/RuntimeTypes'
import { CHECKLIST_TOOL_ID } from '../toolkit/builtin/todoWrite'

export type TodoSectionFileOperation = 'read' | 'edited' | 'deleted'

export type TodoSectionFileOperationCounts = Record<TodoSectionFileOperation, number>

export type TodoSectionPartLike = {
  type?: string
  toolName?: string
  toolCallId?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  status?: { type?: string; reason?: string }
  toolTarget?: string
}

export type TodoSectionToolSummary = {
  callTotal: number
  fileOperations: TodoSectionFileOperationCounts
  currentOrLastTarget?: string
}

const FILE_READ_TOOL_NAMES = new Set(['Read'])
const FILE_EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit'])
const FILE_DELETE_TOOL_NAMES = new Set(['Delete', 'Remove', 'Rm', 'Unlink'])

function emptyFileOperations(): TodoSectionFileOperationCounts {
  return { read: 0, edited: 0, deleted: 0 }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function firstStringField(
  record: Record<string, unknown> | null,
  fields: readonly string[],
): string | undefined {
  if (!record) return undefined
  for (const field of fields) {
    const value = record[field]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

export function classifyTodoSectionFileOperation(
  toolName: string | undefined,
): TodoSectionFileOperation | undefined {
  if (!toolName) return undefined
  if (FILE_READ_TOOL_NAMES.has(toolName)) return 'read'
  if (FILE_EDIT_TOOL_NAMES.has(toolName)) return 'edited'
  if (FILE_DELETE_TOOL_NAMES.has(toolName)) return 'deleted'
  return undefined
}

export function getTodoSectionToolTarget(
  toolName: string | undefined,
  args: unknown,
): string | undefined {
  if (!toolName) return undefined
  const fileOperation = classifyTodoSectionFileOperation(toolName)
  if (fileOperation) {
    const filePath = firstStringField(asRecord(args), [
      'file_path',
      'notebook_path',
      'path',
    ])
    if (filePath) return basename(filePath)
  }
  if (toolName === 'Grep') return 'grep'
  if (toolName === 'Glob') return 'glob'
  return toolName
}

export function countSectionToolCalls(
  types: readonly string[],
  segment: TodoSectionSegment,
  isToolCallType: (type: string | undefined) => boolean,
): number {
  if (segment.kind !== 'todo-section') return 0
  return [
    ...segment.prelude,
    ...Object.values(segment.itemParts).flat(),
    ...segment.trailing,
  ].reduce(
    (count, index) => (isToolCallType(types[index]) ? count + 1 : count),
    0,
  )
}

export function summarizeTodoSectionTools(
  parts: readonly TodoSectionPartLike[],
  segment: TodoSectionSegment,
): TodoSectionToolSummary {
  const fileOperations = emptyFileOperations()
  if (segment.kind !== 'todo-section') {
    return { callTotal: 0, fileOperations }
  }

  let callTotal = 0
  let runningTarget: string | undefined
  let lastTarget: string | undefined
  const indices = [
    ...segment.prelude,
    ...Object.values(segment.itemParts).flat(),
    ...segment.trailing,
  ]

  for (const index of indices) {
    const part = parts[index]
    if (part?.type !== 'tool-call') continue
    callTotal++

    const operation = classifyTodoSectionFileOperation(part.toolName)
    if (operation) fileOperations[operation]++

    const target = part.toolTarget ?? getTodoSectionToolTarget(part.toolName, part.args)
    if (target) {
      lastTarget = target
      if (part.status?.type === 'running') runningTarget = target
    }
  }

  return {
    callTotal,
    fileOperations,
    currentOrLastTarget: runningTarget ?? lastTarget,
  }
}

export type TodoSectionSegment =
  | {
      kind: 'plain'
      /** Inclusive part indices handled as individual, ungrouped parts. */
      indices: number[]
    }
  | {
      /**
       * A standalone top-level part (an interactive surface, or the `Agent` call that
       * spawns a teammate), decided from which tool it is, never from lifecycle state.
       * An enclosing section closes at it (pending steps kept); the next TodoWrite
       * opens a continuation card. Emitted only for `hoistedIndices`.
       */
      kind: 'hoisted'
      /** Part index of the hoisted part. */
      index: number
    }
  | {
      kind: 'todo-section'
      /** Stable id to persist expand/collapse state across re-mounts. */
      persistKey: string
      /** Stable todo list view rendered for this section. */
      todos: TaskListEntry[]
      /** Part indices of TodoWrite tool-calls that belong to this section. */
      todoWriteIndices: number[]
      /**
       * Parts that appeared inside the section before any item was
       * `in_progress` (e.g. right after an initial all-pending TodoWrite).
       */
      prelude: number[]
      /**
       * Parts attributed to each item of the rendered todo view, keyed by the
       * item's index in `todos`. Items that never had anything run under them
       * simply have no entry.
       */
      itemParts: Record<number, number[]>
      /**
       * Parts that happened after the last todo item exited `in_progress` but
       * before the section closed (e.g. follow-up calls after the final
       * TodoWrite in the section). Also receives the trailing `end_turn` reply
       * peeled out of a still-`in_progress` item when the turn settled without
       * a closing TodoWrite — see `buildTodoSections`' `settled` option.
       */
      trailing: number[]
      /**
       * Identities (`todoIdentity`) of steps this section continues rather than
       * performs: executed in `priorTodos` and `completed` in the opening TodoWrite.
       * Hidden by `executedTodoEntries` unless the step later leaves `completed` or
       * owns a non-empty `itemParts` bucket.
       */
      carriedOver: string[]
    }

export type BuildTodoSectionsOptions = {
  /**
   * Whether the parent turn has settled. When true, a trailing `end_turn` reply
   * left under an `in_progress` item moves to `trailing`. Default `false`: mid-
   * stream, trailing text may be a preamble whose `tool-call` has not arrived.
   */
  settled?: boolean
  /**
   * Part indices to lift into standalone `{kind:'hoisted'}` segments. Must be
   * derived from what each part IS (its tool name), never from its state —
   * see the segment's doc for why. Inside an open section the section stays
   * open across the part; in a plain run the buffered parts before it flush
   * first. Empty/omitted → nothing is hoisted.
   */
  hoistedIndices?: ReadonlySet<number>
  /**
   * The plan state that preceded this message (todos of the last earlier
   * TodoWrite). Steps already shown and merely marked `completed` here go into
   * `carriedOver`. Applies to the first section; later sections carry over from
   * the plan state at their break.
   */
  priorTodos?: readonly PriorTodoStatus[]
}

/** One step of a preceding plan state: identity + where it stood. */
export type PriorTodoStatus = {
  content: string
  status: TaskListEntry['status']
}

/**
 * `metadata.custom` key under which the conversion stamps an assistant
 * message with the plan state that preceded it: a JSON array of
 * `PriorTodoStatus`. Guest-internal (webview only) — not a wire contract.
 */
export const PRIOR_TODOS_KEY = 'priorTodos'

/** Parses a `PRIOR_TODOS_KEY` value; anything malformed reads as "no prior". */
export function parsePriorTodos(
  raw: unknown,
): readonly PriorTodoStatus[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    const out: PriorTodoStatus[] = []
    for (const step of parsed) {
      if (!step || typeof step !== 'object') return undefined
      const { content, status } = step as Partial<PriorTodoStatus>
      if (
        typeof content !== 'string' ||
        (status !== 'pending' &&
          status !== 'in_progress' &&
          status !== 'completed')
      ) {
        return undefined
      }
      out.push({ content, status })
    }
    return out
  } catch {
    return undefined
  }
}

const isTodoWrite = (part: TodoSectionPartLike): boolean =>
  part?.type === 'tool-call' && part.toolName === CHECKLIST_TOOL_ID

function readTodos(part: TodoSectionPartLike): TaskListEntry[] | null {
  return readTodoWriteTodos(part?.args)
}

/**
 * The validated `todos` of a TodoWrite call's args, or null when malformed.
 * Shared with the conversion layer, which records the last plan state of
 * each turn for `BuildTodoSectionsOptions.priorTodos`.
 */
export function readTodoWriteTodos(args: unknown): TaskListEntry[] | null {
  if (!args || typeof args !== 'object') return null
  const todos = (args as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return null
  const validated: TaskListEntry[] = []
  for (const raw of todos) {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Partial<TaskListEntry>
    if (
      typeof item.content !== 'string' ||
      typeof item.activeForm !== 'string' ||
      (item.status !== 'pending' &&
        item.status !== 'in_progress' &&
        item.status !== 'completed')
    ) {
      return null
    }
    validated.push({
      content: item.content,
      activeForm: item.activeForm,
      status: item.status,
    })
  }
  return validated
}

/**
 * Finds the `in_progress` item index in a todo view, or null if there isn't
 * one. Returns the FIRST such item (ChecklistTool enforces at most one).
 */
function findInProgressIndex(todos: TaskListEntry[]): number | null {
  for (let i = 0; i < todos.length; i++) {
    if (todos[i]!.status === 'in_progress') return i
  }
  return null
}

/** How two writes of the same step are matched: by its (normalized) text. */
export function todoIdentity(item: { content: string }): string {
  return item.content.trim().toLowerCase()
}

/**
 * Steps a section continues rather than performs — see the segment field of
 * the same name. Shown by the earlier card (executed there: `completed` or
 * `in_progress`) and `completed` at this card's open; anything else (a new
 * step, one still pending before, one still in progress here, one moved
 * back to in_progress) is this card's own.
 */
export function carriedOverTodoIdentities(
  opening: readonly TaskListEntry[],
  prior: readonly PriorTodoStatus[] | undefined,
): string[] {
  if (!prior || prior.length === 0) return []
  const shownBefore = new Set<string>()
  for (const step of prior) {
    if (step.status !== 'pending') shownBefore.add(todoIdentity(step))
  }
  const out: string[] = []
  for (const step of opening) {
    const id = todoIdentity(step)
    if (step.status === 'completed' && shownBefore.has(id)) out.push(id)
  }
  return out
}

function countTodoOverlap(a: readonly TaskListEntry[], b: readonly TaskListEntry[]): number {
  const seen = new Set(a.map(todoIdentity))
  let overlap = 0
  for (const item of b) {
    if (seen.has(todoIdentity(item))) overlap++
  }
  return overlap
}

/**
 * Keep an already-started plan visually stable even when the model sends a
 * shortened "remaining work" TodoWrite. Nexus renders TodoWrite in the
 * transcript, so disappearing rows are a UI regression even if the raw tool
 * input is technically a full replacement.
 */
function mergeStableTodoView(
  previous: readonly TaskListEntry[],
  incoming: readonly TaskListEntry[],
): TaskListEntry[] {
  if (previous.length === 0) return [...incoming]
  if (incoming.length === 0) return []

  const incomingById = new Map<string, TaskListEntry>()
  for (const item of incoming) {
    incomingById.set(todoIdentity(item), item)
  }

  const incomingHasProgress = incoming.some(
    item => item.status === 'in_progress' || item.status === 'completed',
  )
  const merged: TaskListEntry[] = []
  const consumed = new Set<string>()

  for (const oldItem of previous) {
    const id = todoIdentity(oldItem)
    const nextItem = incomingById.get(id)
    if (nextItem) {
      merged.push(nextItem)
      consumed.add(id)
      continue
    }

    // If the active row disappeared while a later row advanced, treat the
    // omitted active row as completed. This preserves "3/5 -> 4/5" instead of
    // rebasing the section to "1/3" when the model only sends remaining work.
    if (oldItem.status === 'in_progress' && incomingHasProgress) {
      merged.push({ ...oldItem, status: 'completed' })
    } else {
      merged.push(oldItem)
    }
  }

  for (const item of incoming) {
    const id = todoIdentity(item)
    if (!consumed.has(id)) {
      merged.push(item)
    }
  }

  return merged
}

function startsIndependentTodoSection(
  currentTodos: readonly TaskListEntry[],
  incomingTodos: readonly TaskListEntry[],
  hasStartedWork: boolean,
): boolean {
  if (!hasStartedWork) return false
  if (currentTodos.length === 0 || incomingTodos.length === 0) return false
  return countTodoOverlap(currentTodos, incomingTodos) === 0
}

/**
 * Groups a message's flat parts into segments. A TodoWrite opens a section;
 * parts are attributed to the item `in_progress` when they arrived; an
 * overlapping TodoWrite updates it, a disjoint one after work began starts a new
 * section. Parts before the first TodoWrite are plain; `hoistedIndices` parts
 * are standalone. With `settled`, a trailing reply moves to `trailing`.
 */
export function buildTodoSections(
  parts: readonly TodoSectionPartLike[],
  options: BuildTodoSectionsOptions = {},
): TodoSectionSegment[] {
  const settled = options.settled ?? false
  const hoisted = options.hoistedIndices
  const segments: TodoSectionSegment[] = []

  type OpenSection = {
    /** The segment itself — already in `segments` (pushed at open). */
    segment: Extract<TodoSectionSegment, { kind: 'todo-section' }>
    /** null means "no item in_progress right now; accumulate into prelude or
     *  trailing depending on whether we've already seen a non-pending state". */
    currentItemIndex: number | null
    /** Becomes true once any item has been in_progress. Used to decide
     *  between prelude (before any activity) and trailing (after activity). */
    hasStartedWork: boolean
  }
  // `null as …`, not `: … | null = null`: the section is opened inside a
  // closure, and a plain typed initializer lets TypeScript narrow the
  // variable to `null` for the whole loop below.
  let activeSection = null as OpenSection | null

  let plainBuffer: number[] = []

  const flushPlain = () => {
    if (plainBuffer.length > 0) {
      segments.push({ kind: 'plain', indices: plainBuffer })
      plainBuffer = []
    }
  }

  // The plan state of the section a hoisted part closed earlier in THIS
  // message. The next TodoWrite continues that plan, so its card carries over
  // from here rather than from the message-level `priorTodos` (which is the
  // state before the message began — stale by then).
  let breakState: readonly TaskListEntry[] | undefined

  const openSection = (part: TodoSectionPartLike, index: number, todos: TaskListEntry[]) => {
    const segment: Extract<TodoSectionSegment, { kind: 'todo-section' }> = {
      kind: 'todo-section',
      persistKey: part.toolCallId ?? `todo-section-${index}`,
      todos,
      todoWriteIndices: [index],
      prelude: [],
      itemParts: {},
      trailing: [],
      carriedOver: carriedOverTodoIdentities(
        todos,
        breakState ?? options.priorTodos,
      ),
    }
    breakState = undefined
    segments.push(segment)
    const currentItemIndex = findInProgressIndex(todos)
    activeSection = {
      segment,
      currentItemIndex,
      hasStartedWork: currentItemIndex !== null,
    }
  }

  // Peel a trailing `end_turn` reply (the `text`/`reasoning` tail of the
  // `in_progress` item's bucket) to `trailing` when settled. A tail leading into a
  // hoisted part, or before a gap in the bucket's indices (a TodoWrite), is a
  // preamble and stays.
  const peelTrailingReply = () => {
    if (!settled || !activeSection) return
    const idx = activeSection.currentItemIndex
    // null → closing content already routed to `trailing` by the loop.
    if (idx === null) return
    const bucket = activeSection.segment.itemParts[idx]
    if (!bucket || bucket.length === 0) return
    if (hoisted?.has(bucket[bucket.length - 1]! + 1)) return
    let cut = bucket.length
    while (cut > 0) {
      const partType = parts[bucket[cut - 1]!]?.type
      if (partType !== 'text' && partType !== 'reasoning') break
      if (cut < bucket.length && bucket[cut - 1]! + 1 !== bucket[cut]!) break
      cut--
    }
    if (cut === bucket.length) return
    const peeled = bucket.slice(cut)
    const remaining = bucket.slice(0, cut)
    if (remaining.length > 0) {
      activeSection.segment.itemParts[idx] = remaining
    } else {
      delete activeSection.segment.itemParts[idx]
    }
    // Peeled indices are the message's final parts, so they sort after any
    // parts already in `trailing` (from an earlier all-completed window).
    activeSection.segment.trailing.push(...peeled)
  }

  const closeSection = () => {
    if (activeSection) {
      peelTrailingReply()
      activeSection = null
    }
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!

    // Hoist break-out: the part renders at the top level, and an open section
    // CLOSES before it (pending steps kept — the plan is still the plan; it
    // has an event in the middle of it). Its plan state is remembered so the
    // next TodoWrite opens a continuation card that lists only the steps
    // worked on after the break. Parts between the break and that TodoWrite
    // are plain. In a plain run the buffered parts before it flush first.
    if (hoisted?.has(i)) {
      if (activeSection) {
        breakState = activeSection.segment.todos
        closeSection()
      } else {
        flushPlain()
      }
      segments.push({ kind: 'hoisted', index: i })
      continue
    }

    if (isTodoWrite(part)) {
      const todos = readTodos(part)
      // Malformed TodoWrite args — render it as a plain part so it still
      // shows up instead of vanishing into a broken section.
      if (!todos) {
        if (activeSection) {
          // Still record it under the current item so it's visible near
          // where the agent used it.
          if (activeSection.currentItemIndex !== null) {
            ;(activeSection.segment.itemParts[activeSection.currentItemIndex] ??=
              []).push(i)
          } else if (activeSection.hasStartedWork) {
            activeSection.segment.trailing.push(i)
          } else {
            activeSection.segment.prelude.push(i)
          }
        } else {
          plainBuffer.push(i)
        }
        continue
      }

      if (!activeSection) {
        flushPlain()
        openSection(part, i, todos)
      } else {
        if (
          startsIndependentTodoSection(
            activeSection.segment.todos,
            todos,
            activeSection.hasStartedWork,
          )
        ) {
          closeSection()
          openSection(part, i, todos)
          continue
        }

        activeSection.segment.todos = mergeStableTodoView(
          activeSection.segment.todos,
          todos,
        )
        activeSection.segment.todoWriteIndices.push(i)
        const next = findInProgressIndex(activeSection.segment.todos)
        activeSection.currentItemIndex = next
        if (next !== null) activeSection.hasStartedWork = true
      }
      continue
    }

    if (activeSection) {
      if (activeSection.currentItemIndex !== null) {
        ;(activeSection.segment.itemParts[activeSection.currentItemIndex] ??= []).push(i)
      } else if (activeSection.hasStartedWork) {
        activeSection.segment.trailing.push(i)
      } else {
        activeSection.segment.prelude.push(i)
      }
    } else {
      plainBuffer.push(i)
    }
  }

  closeSection()
  flushPlain()

  return segments
}

/**
 * Resolve the (at most one) `in_progress` step to `completed` when `resolveDone`:
 * the turn completed, or a later disjoint TodoWrite superseded the section.
 * Otherwise the step keeps its working/paused rendering. Returns the same array
 * when nothing changes.
 */
export function applyFinishedTurnStatus(
  todos: readonly TaskListEntry[],
  resolveDone: boolean,
): readonly TaskListEntry[] {
  if (!resolveDone) return todos
  let changed = false
  const next = todos.map(item => {
    if (item.status === 'in_progress') {
      changed = true
      return { ...item, status: 'completed' as const }
    }
    return item
  })
  return changed ? next : todos
}

/**
 * The executed (non-pending, not carried-over) items of a todo list with their
 * ORIGINAL index: `itemParts` is keyed by position in the full list.
 */
export function executedTodoEntries(
  todos: readonly TaskListEntry[],
  /**
   * `todoIdentity`s of steps finished in an EARLIER card (the section's
   * `carriedOver`). Hidden while still `completed` AND while the step owns
   * no parts in this section; a step the model moved back to `in_progress`
   * is this card's work again and shows — and stays shown once it is
   * completed a second time, because by then its bucket holds the parts
   * that ran under it (see `itemParts`).
   */
  carriedOver?: ReadonlySet<string>,
  /**
   * The section's `itemParts` (buckets keyed by ORIGINAL index). A
   * carried-over step with a non-empty bucket was reopened and worked on in
   * this card; hiding it would drop those parts from the transcript
   * entirely — nothing else renders a hidden step's bucket.
   */
  itemParts?: Readonly<Record<number, readonly number[]>>,
): ReadonlyArray<{ item: TaskListEntry; originalIndex: number }> {
  const out: Array<{ item: TaskListEntry; originalIndex: number }> = []
  for (let i = 0; i < todos.length; i++) {
    const item = todos[i]!
    if (item.status === 'pending') continue
    if (
      item.status === 'completed' &&
      carriedOver !== undefined &&
      carriedOver.has(todoIdentity(item)) &&
      (itemParts?.[i]?.length ?? 0) === 0
    ) {
      continue
    }
    out.push({ item, originalIndex: i })
  }
  return out
}
