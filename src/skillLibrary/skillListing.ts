import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'

// The listing gets about 1% of the context window, at roughly four
// characters per token. Without a known window it falls back to a flat size.
const FALLBACK_BUDGET_CHARS = 8000
const WINDOW_SHARE = 0.01
const APPROX_CHARS_IN_TOKEN = 4

// Longest details text any one line may carry, whatever the budget.
const DETAILS_CAP = 250
// Below this many characters per line, a trimmed description is noise;
// such listings show names only.
const SHORTEST_USEFUL_DETAILS = 20

const ELLIPSIS = '…'

export function skillListingBudgetChars(windowTokens?: number): number {
  if (!windowTokens || windowTokens <= 0) return FALLBACK_BUDGET_CHARS
  return Math.floor(windowTokens * APPROX_CHARS_IN_TOKEN * WINDOW_SHARE)
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 1)) + ELLIPSIS
}

interface ListingRow {
  readonly name: string
  readonly details: string
  // Bundled skills always keep their full line.
  readonly pinned: boolean
}

function toRow(command: ChromiumCommandMetadata): ListingRow {
  const details = command.useWhen
    ? `${command.description} When to use: ${command.useWhen}`
    : command.description
  return {
    name: command.name,
    details: clip(details, DETAILS_CAP),
    pinned: command.source === 'bundled',
  }
}

const fullLine = (row: ListingRow): string => `- ${row.name}: ${row.details}`
const nameLine = (row: ListingRow): string => `- ${row.name}`

// Size of `lines` once joined with newlines.
function joinedSize(lines: readonly string[]): number {
  return lines.reduce((size, line, i) => size + line.length + (i > 0 ? 1 : 0), 0)
}

/**
 * Renders one line per command, in input order, fitted to the budget.
 *
 * Fitting happens in up to three modes: everything in full; bundled lines
 * full with the rest trimmed to an equal share of what bundled lines leave;
 * or, when that share is too small, the rest reduced to bare names.
 */
export function renderSkillListing(
  commands: readonly ChromiumCommandMetadata[],
  windowTokens?: number,
): string {
  if (commands.length === 0) return ''
  const budget = skillListingBudgetChars(windowTokens)
  const rows = commands.map(toRow)

  const full = rows.map(fullLine)
  const flexible = rows.filter(row => !row.pinned)
  if (joinedSize(full) <= budget || flexible.length === 0) return full.join('\n')

  // Each pinned line costs its text plus one separator.
  const pinnedCost = rows
    .filter(row => row.pinned)
    .reduce((size, row) => size + fullLine(row).length + 1, 0)
  // Fixed part of each flexible line ("- " + name + ": ") plus separators between them.
  const flexibleFrame = joinedSize(flexible.map(row => `- ${row.name}: `))
  const share = Math.floor((budget - pinnedCost - flexibleFrame) / flexible.length)

  const flexibleLine =
    share < SHORTEST_USEFUL_DETAILS
      ? nameLine
      : (row: ListingRow) => `- ${row.name}: ${clip(row.details, share)}`
  return rows.map(row => (row.pinned ? fullLine(row) : flexibleLine(row))).join('\n')
}
