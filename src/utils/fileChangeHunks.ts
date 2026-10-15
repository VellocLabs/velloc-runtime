import { structuredPatch, type StructuredPatchHunk } from 'diff'

/**
 * Contract: hunks for an Edit / Write change and the per-call Diff summary.
 * 3 context lines; no hunks past 5 s. Leading tabs compare as two spaces;
 * `&` / `$` are placeholdered while diffing. A replacement is replayed on the
 * whole original (literal replacement), so line numbers are real; a created
 * file is one all-added hunk. Pure.
 */

const CONTEXT_ROWS = 3
const DIFF_BUDGET_MS = 5_000

// Placeholder words that stand in for `&` and `$` during diffing.
const PLACEHOLDER_FOR: Readonly<Record<string, string>> = {
  '&': '<<:AMPERSAND_TOKEN:>>',
  $: '<<:DOLLAR_TOKEN:>>',
}
const PLACEHOLDER_CHARS = /[&$]/g
const PLACEHOLDER_WORDS = /<<:AMPERSAND_TOKEN:>>|<<:DOLLAR_TOKEN:>>/g
const CHAR_FOR: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PLACEHOLDER_FOR).map(([ch, word]) => [word, ch]),
)

const INDENT_TABS = /^\t+/gm

/** Show every leading tab of each line as two spaces; other tabs stay. */
export function expandIndentTabs(text: string): string {
  if (!text.includes('\t')) return text
  return text.replace(INDENT_TABS, run => '  '.repeat(run.length))
}

/** Text as it enters the line diff: tabs expanded, then `&`/`$` hidden. */
function toDiffForm(text: string): string {
  return expandIndentTabs(text).replace(PLACEHOLDER_CHARS, ch => PLACEHOLDER_FOR[ch]!)
}

function fromDiffForm(line: string): string {
  return line.replace(PLACEHOLDER_WORDS, word => CHAR_FOR[word]!)
}

/** Line-diff two texts already in diff form and restore the emitted lines. */
function diffPrepared(label: string, before: string, after: string): StructuredPatchHunk[] {
  const patch = structuredPatch(label, label, before, after, undefined, undefined, {
    context: CONTEXT_ROWS,
    timeout: DIFF_BUDGET_MS,
  })
  if (!patch) return []
  return patch.hunks.map(h => Object.assign({}, h, { lines: h.lines.map(fromDiffForm) }))
}

/**
 * Hunks between two texts. Given whole files the line numbers are file
 * positions; given an edit's two snippets they count from 1.
 */
export function hunksBetween(label: string, before: string, after: string): StructuredPatchHunk[] {
  return diffPrepared(label, toDiffForm(before), toDiffForm(after))
}

/** A literal search-and-replace on a file's text. */
export type TextReplacement = {
  find: string
  put: string
  /** Replace every match instead of only the first. */
  everywhere: boolean
}

/** Hunks for `change` replayed on the whole `original` file. */
export function hunksForReplacement(
  label: string,
  original: string,
  change: TextReplacement,
): StructuredPatchHunk[] {
  const before = toDiffForm(original)
  const find = toDiffForm(change.find)
  const put = toDiffForm(change.put)
  const literal = () => put
  const after = change.everywhere ? before.replaceAll(find, literal) : before.replace(find, literal)
  return diffPrepared(label, before, after)
}

/** One all-added hunk for a file created with `text`. */
export function hunksForCreation(text: string): StructuredPatchHunk[] {
  const added = text.split('\n').map(line => `+${line}`)
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: added.length, lines: added }]
}

/** Number of `+` and `-` rows across the hunks (context and markers skipped). */
export function tallyHunkRows(hunks: readonly StructuredPatchHunk[]): {
  added: number
  removed: number
} {
  const tally = { added: 0, removed: 0 }
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const sign = line.charAt(0)
      if (sign === '+') tally.added += 1
      else if (sign === '-') tally.removed += 1
    }
  }
  return tally
}

/**
 * UI-only diff of one Edit / Write call, kept on the tool detail record's
 * `editDiff` field and never shown to the model. Field names are part of the
 * stored session format.
 */
export type FileChangeDiff = {
  filePath: string
  patchHunks: StructuredPatchHunk[]
  fileWasCreated: boolean
  plusLines: number
  minusLines: number
}

/**
 * What one Edit / Write call did. `before` is the file's text ahead of the
 * call as the host reported it; it is absent when the host did not send it
 * and, for a write, when the file did not exist.
 */
export type FileChange =
  | ({ op: 'replace'; path: string; before?: string } & TextReplacement)
  | { op: 'overwrite'; path: string; text: string; before?: string }

/**
 * Summarise a call for the Diff views. A write with no `before` is a created
 * file. A replacement with no `before` falls back to diffing the two snippets,
 * so its line numbers count from 1.
 */
export function summarizeFileChange(change: FileChange): FileChangeDiff {
  let hunks: StructuredPatchHunk[]
  const created = change.op === 'overwrite' && change.before === undefined
  if (change.op === 'overwrite') {
    hunks =
      change.before === undefined
        ? hunksForCreation(change.text)
        : hunksBetween(change.path, change.before, change.text)
  } else if (change.before === undefined) {
    hunks = hunksBetween(change.path, change.find, change.put)
  } else {
    hunks = hunksForReplacement(change.path, change.before, change)
  }
  const tally = tallyHunkRows(hunks)
  return {
    filePath: change.path,
    patchHunks: hunks,
    fileWasCreated: created,
    plusLines: tally.added,
    minusLines: tally.removed,
  }
}
