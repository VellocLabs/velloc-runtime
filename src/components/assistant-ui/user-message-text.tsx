import { useMemo, useState, type FC } from 'react'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useT } from '@/browser/webview/i18n'
import { TextWithFilePaths } from '@/components/assistant-ui/file-path-link'
import { usePartLineAttrs } from '@/components/assistant-ui/part-line-context'

// Both limits are in DISPLAY lines — the rows the bubble renders — not in
// newline-separated lines. A paste of a few long paragraphs has few newlines
// but wraps into dozens of rows; counting newlines alone let a 3,300-character
// message of 20 paragraphs render in full with no toggle.
export const USER_MESSAGE_MAX_DISPLAY_LINES = 12
export const USER_MESSAGE_COLLAPSED_PREVIEW_LINES = 10
// Columns one display line holds before it wraps. The rendered width depends
// on the window and the text-size setting (~90 columns at the widest), so
// this is an estimate, erring narrow: a narrower panel wraps sooner, and
// over-counting only collapses a borderline message a little early.
export const USER_MESSAGE_WRAP_COLUMNS = 80

export type CollapsedUserMessageText = {
  head: string
  /** Newline-separated lines of `text` not shown whole in `head` — a line
   *  the preview cuts inside counts as hidden. REAL lines, not display rows:
   *  the row counts above are an estimate, and the label says "lines". */
  hiddenLineCount: number
}

// `whitespace-pre-wrap` renders a tab up to the next tab stop, every 8
// columns (the default `tab-size`).
const TAB_SIZE = 8

// East Asian wide / fullwidth characters and emoji take two columns.
function charColumns(codePoint: number): number {
  return (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    ? 2
    : 1
}

// Columns `char` adds at column `at`: a tab runs to the next tab stop.
function advanceColumns(char: string, at: number): number {
  return char === '\t'
    ? TAB_SIZE - (at % TAB_SIZE)
    : charColumns(char.codePointAt(0) ?? 0)
}

function lineColumns(line: string): number {
  let columns = 0
  for (const char of line) columns += advanceColumns(char, columns)
  return columns
}

// Rows one newline-separated line occupies once wrapped (an empty line is one).
function lineDisplayLines(line: string): number {
  return Math.max(1, Math.ceil(lineColumns(line) / USER_MESSAGE_WRAP_COLUMNS))
}

function countDisplayLines(text: string): number {
  let count = 0
  for (const line of text.split('\n')) count += lineDisplayLines(line)
  return count
}

// The longest prefix of `line` that fits in `maxColumns`, pulled back to the
// last whitespace when that keeps most of it, so the preview does not stop
// mid-word. Code points are never split.
function cutLineToColumns(line: string, maxColumns: number): string {
  let columns = 0
  let end = 0
  let lastSpace = -1
  for (const char of line) {
    const width = advanceColumns(char, columns)
    if (columns + width > maxColumns) break
    columns += width
    if (/\s/.test(char)) lastSpace = end
    end += char.length
  }
  if (lastSpace > end * 0.8) end = lastSpace
  return line.slice(0, end).trimEnd()
}

export function buildCollapsedUserMessageText(
  text: string,
): CollapsedUserMessageText | null {
  const total = countDisplayLines(text)
  if (total <= USER_MESSAGE_MAX_DISPLAY_LINES) {
    return null
  }

  // Keep the first N display lines as the preview. Whole lines while they
  // fit; a line that would overflow the budget is cut inside it, and the
  // preview ends with an ellipsis so the cut reads as one.
  const lines = text.split('\n')
  const kept: string[] = []
  let wholeLines = 0
  let budget = USER_MESSAGE_COLLAPSED_PREVIEW_LINES
  for (const line of lines) {
    const rows = lineDisplayLines(line)
    if (rows <= budget) {
      kept.push(line)
      wholeLines++
      budget -= rows
      if (budget === 0) break
      continue
    }
    kept.push(`${cutLineToColumns(line, budget * USER_MESSAGE_WRAP_COLUMNS)}…`)
    break
  }

  return {
    head: kept.join('\n'),
    hiddenLineCount: lines.length - wholeLines,
  }
}

export function shouldCollapseUserMessageText(text: string): boolean {
  return countDisplayLines(text) > USER_MESSAGE_MAX_DISPLAY_LINES
}

export function getCollapsibleUserMessageText(content: unknown): string | null {
  // The adapter delivers user message content as a parts array
  // (`[{ type: 'text', text }]`), not a bare string — so the collapse feature
  // only engaged for the (rare) string form and long pastes never collapsed.
  // Accept both: a plain string, or a parts array that is exactly one text part
  // (multi-part / non-text messages keep the default renderer).
  const text = extractSingleUserMessageText(content)
  return text !== null && shouldCollapseUserMessageText(text) ? text : null
}

/**
 * The transcript line a user message was read from: `sourceLine` on its content parts
 * when they are an array, else `metadata.custom.lineFrom` (user rows never merge).
 * Null for a live message not yet persisted.
 */
export function userMessageTranscriptLine(
  content: unknown,
  metadata: unknown,
): number | null {
  const valid = (line: unknown): line is number =>
    typeof line === 'number' && Number.isFinite(line) && line >= 0
  const parts = Array.isArray(content) ? content : []
  for (const part of parts) {
    const line = (part as { sourceLine?: unknown } | null)?.sourceLine
    if (valid(line)) return line
  }
  const custom = (metadata as { custom?: unknown } | null)?.custom
  const from = (custom as { lineFrom?: unknown } | null)?.lineFrom
  return valid(from) ? from : null
}

function extractSingleUserMessageText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.length !== 1) return null
  const part = content[0]
  if (
    part !== null &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
  ) {
    return (part as { text: string }).text
  }
  return null
}

export const CollapsibleUserMessageText: FC<{
  text: string
  defaultExpanded?: boolean
  /** Controlled: the row that owns the toggle (a mod's `UserMessage` site
   *  reads it as `isExpanded`). */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}> = ({ text, defaultExpanded = false, expanded: controlled, onExpandedChange }) => {
  const t = useT()
  // Scans every character of `text`; a re-render with the same text (hover,
  // the toggle itself) must not repeat it.
  const collapsed = useMemo(() => buildCollapsedUserMessageText(text), [text])
  const [uncontrolled, setUncontrolled] = useState(defaultExpanded)
  const expanded = controlled ?? uncontrolled
  const setExpanded = (next: boolean) => {
    setUncontrolled(next)
    onExpandedChange?.(next)
  }
  // The transcript line this text came from (`data-line-ordinal`), when the
  // message provides one. Stamped on the TEXT — the collapsed preview and
  // the full body alike — not only on the bubble around it, so a search
  // reveal that walks down to the innermost element carrying the line stops
  // here, on what is visible, and never has to open the "show full" toggle
  // to look for something deeper.
  const lineAttrs = usePartLineAttrs()

  if (!collapsed) {
    return (
      <div
        className="aui-user-message-text min-w-0 max-w-full whitespace-pre-wrap wrap-break-word"
        data-role="user-message-text"
        {...lineAttrs}
      >
        <TextWithFilePaths text={text} />
      </div>
    )
  }

  const toggleLabel = expanded
    ? t('message.showLess')
    : collapsed.hiddenLineCount === 1
      ? t('message.showFullCountOne')
      : t('message.showFullCount', { count: collapsed.hiddenLineCount })

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="aui-user-message-collapsible min-w-0 max-w-full space-y-2"
      data-role="user-message-collapsible"
    >
      {!expanded && (
        <div
          className="aui-user-message-preview min-w-0 max-w-full whitespace-pre-wrap wrap-break-word"
          data-role="user-message-preview"
          {...lineAttrs}
        >
          <TextWithFilePaths text={collapsed.head} />
        </div>
      )}
      <CollapsibleContent
        className="aui-user-message-full min-w-0 max-w-full whitespace-pre-wrap wrap-break-word"
        data-role="user-message-full"
        // Only while OPEN. Radix keeps this element mounted (hidden, empty)
        // while collapsed, and a line-carrying hidden element is the worst
        // possible target: it is the innermost match, so the reveal would
        // stop on it, flash nothing visible and park the arrow on a
        // zero-size rect.
        {...(expanded ? lineAttrs : {})}
      >
        <TextWithFilePaths text={text} />
      </CollapsibleContent>
      {/* Single right-aligned toggle: collapsed it merges the hidden-line
          count into the action ("Show full (N more lines)"); expanded it
          collapses again. */}
      <div className="flex justify-end">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="aui-user-message-toggle text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label={toggleLabel}
          >
            {toggleLabel}
          </button>
        </CollapsibleTrigger>
      </div>
    </Collapsible>
  )
}
