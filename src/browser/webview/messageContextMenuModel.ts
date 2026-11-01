import type { Message } from '../../runtime/RuntimeTypes'
import {
  isAttachableSelection,
  isCopyableSelection,
  type CaptureRequest,
} from './capturedPassages'
import { resolveForkSendCutUuid } from './forkSend'

/**
 * The transcript message context menu (F-22): what a right-click (or the
 * keyboard's menu key) on a message offers, decided once when the menu opens
 * from a frozen snapshot of the selection and the target. Every choice carries
 * its own material, so a click never re-reads the selection.
 */

export type CopyMaterial =
  | { scope: 'range' | 'inline-code' | 'code-block' | 'path'; body: string }
  | { scope: 'entry'; body: string; output: 'plain' | 'rich' }

export type HistoryCut =
  | { side: 'before-entry'; entryKey: string }
  | { side: 'after-response'; responseKey: string; cutKey: string }

export type MenuOperation =
  | { command: 'clipboard.write'; material: CopyMaterial }
  | { command: 'context.capture'; material: CaptureRequest }
  | { command: 'thread.derive'; cut: HistoryCut }

export type MenuSection = 'target' | 'entry' | 'thread'

export type ActionChoice = {
  choiceKey: string
  section: MenuSection
  labelKey: string
  shortcut?: 'attachSelection'
} & (
  | { availability: 'enabled'; operation: MenuOperation }
  | { availability: 'disabled'; explanationKey: string }
)

/** The selection as the menu froze it. `outside`: some of it lies outside the message list. */
export type SelectionSnapshot =
  | { kind: 'none' }
  | { kind: 'outside' }
  | { kind: 'inside'; text: string }

export type CodeTarget = { scope: 'inline-code' | 'code-block' | 'path'; body: string }

export type MenuTargetFacts = {
  threadKey: string
  entryKey: string
  role: 'user' | 'assistant'
  selection: SelectionSnapshot
  code: CodeTarget | null
  /** The message's own text (Markdown source for a reply); empty when it has none. */
  entryText: string
  /** The composer takes passages (not read-only, not blocked). */
  canAttach: boolean
  /** How this message can be forked; null hides the item. */
  fork:
    | { kind: 'enabled'; cut: HistoryCut }
    | { kind: 'disabled'; explanationKey: string }
    | null
}

/** Elements whose own context menu is kept: text fields and embedded content. */
const NATIVE_MENU_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], iframe, embed, object, canvas, [data-native-context-menu]'

/** The message row an event target sits in, or null when the menu should not open there. */
export function messageRowOf(target: EventTarget | null, list: Element): HTMLElement | null {
  if (!(target instanceof Element) || !list.contains(target)) return null
  if (target.closest(NATIVE_MENU_SELECTOR)) return null
  const row = target.closest<HTMLElement>('[data-message-id]')
  return row && list.contains(row) ? row : null
}

/**
 * Where the menu opens: at the pointer for a mouse, pen or touch open (any
 * button, a macOS Control-click included), else on the row's visible top-left
 * (the menu key and Shift+F10 carry no position).
 */
export function contextMenuAnchor(
  event: { clientX: number; clientY: number },
  row: { left: number; top: number },
): { x: number; y: number } {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY }
  return { x: Math.max(row.left, 0) + 16, y: Math.max(row.top, 0) + 16 }
}

/**
 * The selection, frozen: `inside` only when every range lies in `list` and
 * outside any text field; `outside` when a non-empty selection reaches
 * anywhere else.
 */
export function snapshotSelection(selection: Selection | null, list: Element): SelectionSnapshot {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return { kind: 'none' }
  const text = selection.toString()
  if (text.length === 0) return { kind: 'none' }
  for (let i = 0; i < selection.rangeCount; i++) {
    const node = selection.getRangeAt(i).commonAncestorContainer
    const element = node instanceof Element ? node : node.parentElement
    if (!element || !list.contains(element)) return { kind: 'outside' }
    if (element.closest(NATIVE_MENU_SELECTOR)) return { kind: 'outside' }
  }
  return { kind: 'inside', text }
}

/**
 * The code or path under the pointer: a file path link, a fenced block's
 * `<pre>` (its code only — the header row is outside it), or inline `<code>`.
 */
export function codeTargetOf(target: EventTarget | null, row: Element): CodeTarget | null {
  if (!(target instanceof Element)) return null
  const pathLink = target.closest<HTMLElement>('[data-file-path]')
  if (pathLink && row.contains(pathLink)) {
    const path = pathLink.getAttribute('data-file-path') ?? ''
    return path ? { scope: 'path', body: path } : null
  }
  const pre = target.closest('pre')
  if (pre && row.contains(pre)) {
    const body = (pre.querySelector('code') ?? pre).textContent ?? ''
    return body ? { scope: 'code-block', body: body.replace(/\n$/, '') } : null
  }
  const code = target.closest('code')
  if (code && row.contains(code)) {
    const body = code.textContent ?? ''
    return body ? { scope: 'inline-code', body } : null
  }
  return null
}

const CODE_LABEL: Record<CodeTarget['scope'], string> = {
  'inline-code': 'messageMenu.copyCode',
  'code-block': 'messageMenu.copyCodeBlock',
  path: 'messageMenu.copyPath',
}

/** The menu's choices, in display order; empty when nothing applies (the native menu is kept). */
export function buildMenuChoices(facts: MenuTargetFacts): ActionChoice[] {
  const choices: ActionChoice[] = []
  const selection = facts.selection.kind === 'inside' ? facts.selection.text : null
  if (selection !== null && isCopyableSelection(selection)) {
    choices.push({
      choiceKey: 'copy-selection',
      section: 'target',
      labelKey: 'messageMenu.copy',
      availability: 'enabled',
      operation: { command: 'clipboard.write', material: { scope: 'range', body: selection } },
    })
  }
  if (facts.code) {
    choices.push({
      choiceKey: `copy-${facts.code.scope}`,
      section: 'target',
      labelKey: CODE_LABEL[facts.code.scope],
      availability: 'enabled',
      operation: { command: 'clipboard.write', material: { ...facts.code } },
    })
  }
  if (facts.entryText.trim().length > 0) {
    // A prompt is shown as typed, not as Markdown: it copies as plain text only.
    const prompt = facts.role === 'user'
    choices.push({
      choiceKey: 'copy-message',
      section: 'entry',
      labelKey: 'messageMenu.copyMessage',
      availability: 'enabled',
      operation: {
        command: 'clipboard.write',
        material: { scope: 'entry', body: facts.entryText, output: prompt ? 'plain' : 'rich' },
      },
    })
  }
  if (facts.entryText.trim().length > 0 && facts.role !== 'user') {
    choices.push(
      {
        choiceKey: 'copy-message-markdown',
        section: 'entry',
        labelKey: 'messageMenu.copyMarkdown',
        availability: 'enabled',
        operation: {
          command: 'clipboard.write',
          material: { scope: 'entry', body: facts.entryText, output: 'plain' },
        },
      },
    )
  }
  if (facts.canAttach) {
    const anchors = [{ threadKey: facts.threadKey, entryKey: facts.entryKey }]
    if (selection !== null && isAttachableSelection(selection)) {
      choices.push({
        choiceKey: 'attach-selection',
        section: 'thread',
        labelKey: 'messageMenu.attachSelection',
        shortcut: 'attachSelection',
        availability: 'enabled',
        operation: {
          command: 'context.capture',
          material: { body: selection.trim(), method: 'range', anchors },
        },
      })
    } else if (facts.entryText.trim().length > 0) {
      choices.push({
        choiceKey: 'attach-message',
        section: 'thread',
        labelKey: 'messageMenu.attachMessage',
        availability: 'enabled',
        operation: {
          command: 'context.capture',
          material: { body: facts.entryText.trim(), method: 'entry-content', anchors },
        },
      })
    }
  }
  if (facts.fork) {
    choices.push(
      facts.fork.kind === 'enabled'
        ? {
            choiceKey: 'fork',
            section: 'thread',
            labelKey: 'action.fork',
            availability: 'enabled',
            operation: { command: 'thread.derive', cut: facts.fork.cut },
          }
        : {
            choiceKey: 'fork',
            section: 'thread',
            labelKey: 'action.fork',
            availability: 'disabled',
            explanationKey: facts.fork.explanationKey,
          },
    )
  }
  return choices
}

/** The choices split into their sections, empty sections dropped, in display order. */
export function groupMenuChoices(choices: readonly ActionChoice[]): ActionChoice[][] {
  const order: MenuSection[] = ['target', 'entry', 'thread']
  return order
    .map(section => choices.filter(choice => choice.section === section))
    .filter(group => group.length > 0)
}

/**
 * A menu's one-shot ledger: `${token}:${choiceKey}` runs at most once, so a
 * double click or a key repeat cannot add the same passage twice.
 */
export function createChoiceLedger() {
  const consumed = new Set<string>()
  return {
    claim(token: string, choiceKey: string): boolean {
      const key = `${token}:${choiceKey}`
      if (consumed.has(key)) return false
      consumed.add(key)
      return true
    },
  }
}

/** A thread row as the fork-after cut reads it; `sourceType` is the row's `metadata.custom.sourceType`. */
export type ForkCutRow = { id: string; role: string; sourceType?: string }

/** Rows drawn as replies that still open a new turn: a teammate's message, background results. */
const TURN_OPENING_SOURCES = new Set(['team_message', 'background_results'])

/**
 * The stored entry a row was read from: its own uuid, a landed mid-turn
 * message's `queued_command` entry (the row carries the bubble's uuid), or the
 * original of a `:duplicate-N` row. -1 when the row is not stored yet.
 */
function transcriptIndexOfRow(transcriptMessages: readonly Message[], rowId: string): number {
  const id = rowId.replace(/:duplicate-\d+$/, '')
  return transcriptMessages.findIndex(
    message =>
      message.uuid === id ||
      (message as { attachment?: { source_uuid?: unknown } }).attachment?.source_uuid === id,
  )
}

/**
 * The cut for forking after the reply in `responseRowId`: the transcript entry
 * just before the next turn (a prompt, a teammate's message or background
 * results), so the copy keeps the whole turn (its tool calls and results) and
 * nothing after it. With no later turn, the whole conversation. Null when the
 * next turn is not stored yet, so the menu can say so instead of doing nothing.
 */
export function resolveAfterResponseCut(
  rows: readonly ForkCutRow[],
  transcriptMessages: readonly Message[],
  responseRowId: string,
): string | null {
  const rowIndex = rows.findIndex(row => row.id === responseRowId)
  if (rowIndex < 0) return null
  const nextTurn = rows
    .slice(rowIndex + 1)
    .find(row => row.role === 'user' || (row.sourceType !== undefined && TURN_OPENING_SOURCES.has(row.sourceType)))
  if (!nextTurn) return resolveForkSendCutUuid(transcriptMessages)
  const turnIndex = transcriptIndexOfRow(transcriptMessages, nextTurn.id)
  if (turnIndex <= 0) return null
  return resolveForkSendCutUuid(transcriptMessages.slice(0, turnIndex))
}
