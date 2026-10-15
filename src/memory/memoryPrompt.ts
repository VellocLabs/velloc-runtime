/**
 * The system-prompt block that explains the memory directory to the model,
 * plus the index file's name and the size clamp applied when it is loaded.
 *
 * The block carries instructions only; the index contents reach the model
 * through the instruction-file loader.
 */

import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import {
  PROJECT_NOTES_BULLETS,
  NOTE_HEADER_SAMPLE,
  RECALL_VERIFY_LINES,
  KIND_GUIDE_LINES,
  EXCLUSION_LINES,
  RECALL_TIMING_LINES,
} from './memoryKinds'
import {
  getMemoryDir,
  isMemoryEnabled,
  joinPath,
  resolveMemoryDir,
  type ResolvedMemorySettings,
} from './memoryPaths'

/** File name of the memory index. Stored on disk under this exact name. */
export const MEMORY_INDEX_FILE = 'MEMORY.md'
export const INDEX_MAX_LINES = 200
export const INDEX_MAX_BYTES = 25_000

export function directoryReadySentence(writeToolName?: string): string {
  const how = writeToolName
    ? `write notes into it directly with the ${writeToolName} tool`
    : 'write notes into it directly'
  return `The folder already exists: ${how}, without creating it or checking for it first.`
}

export function memoryIndexPath(
  cwd: string,
  rc: RuntimeConfig,
  opts: {
    projectRoot?: string
    homeDir?: string
    memorySettings?: ResolvedMemorySettings
  } = {},
): string {
  return joinPath(getMemoryDir(cwd, rc, opts), MEMORY_INDEX_FILE)
}

// ---------------------------------------------------------------------------
// Index clamp
// ---------------------------------------------------------------------------

export type ClampedIndex = {
  content: string
  lineCount: number
  byteCount: number
  cutByLines: boolean
  cutBySize: boolean
}

function overLimitReason(lines: number, bytes: number, tooLong: boolean, tooBig: boolean): string {
  if (tooLong && tooBig) return `${lines} lines and ${bytes} bytes`
  if (tooLong) return `${lines} lines (limit: ${INDEX_MAX_LINES})`
  return `${bytes} bytes (limit: ${INDEX_MAX_BYTES})`
}

/** Keeps the index within the line and size limits, noting any cut at the end. */
export function clampMemoryIndex(raw: string): ClampedIndex {
  const text = raw.trim()
  const lines = text.split('\n')
  const lineCount = lines.length
  const byteCount = text.length
  const cutByLines = lineCount > INDEX_MAX_LINES
  const cutBySize = byteCount > INDEX_MAX_BYTES
  if (!cutByLines && !cutBySize) {
    return { content: text, lineCount, byteCount, cutByLines, cutBySize }
  }

  let kept = cutByLines ? lines.slice(0, INDEX_MAX_LINES).join('\n') : text
  if (kept.length > INDEX_MAX_BYTES) {
    const lastBreak = kept.lastIndexOf('\n', INDEX_MAX_BYTES)
    kept = kept.slice(0, lastBreak > 0 ? lastBreak : INDEX_MAX_BYTES)
  }
  const reason = overLimitReason(lineCount, byteCount, cutByLines, cutBySize)
  return {
    content: `${kept}\n\n> WARNING: ${MEMORY_INDEX_FILE} exceeded ${reason}. Only part of it was loaded into memory context.`,
    lineCount,
    byteCount,
    cutByLines,
    cutBySize,
  }
}

// ---------------------------------------------------------------------------
// Prompt text (requirements: F-11)
// ---------------------------------------------------------------------------

const PURPOSE_PARAGRAPH =
  'Use it to carry forward what the next session should know: who the user is, how they want you to work, what to avoid and what to keep doing, and the project context the code does not show. Add to it as you learn, and keep it accurate.'

/** What to do on an explicit "remember" or "forget". */
export const EXPLICIT_REQUESTS =
  'When the user asks you to remember something, save it right away under the type that fits. When they ask you to forget something, remove that information from the note that holds it; if nothing else is left in the note, delete the file and its line in the index.'

/**
 * The filing steps: the note file, then (unless `withIndex` is false) its
 * line in the index. Shared by the system prompt and the extraction brief.
 */
export function noteFilingLines(withIndex = true): string[] {
  const index = `\`${MEMORY_INDEX_FILE}\``
  const noteStep = withIndex
    ? '1. Write the note to its own file, named after its topic (for example `release_process.md` or `prefers_tables.md`), starting with this frontmatter:'
    : 'Write each note to its own file, named after its topic (for example `release_process.md` or `prefers_tables.md`), starting with this frontmatter:'
  const indexStep = withIndex
    ? [
        `2. Add one line for it to ${index}: \`- [Title](file.md) — short hook\`, under ~150 characters. ${index} only lists notes: it has no frontmatter and never holds note content.`,
        '',
        `- ${index} is loaded into every session and cut off after ${INDEX_MAX_LINES} lines, so keep each line short.`,
      ]
    : []
  return [
    '## Saving a note',
    '',
    ...(withIndex ? ['Two steps, every time:', ''] : []),
    noteStep,
    '',
    ...NOTE_HEADER_SAMPLE,
    '',
    ...indexStep,
    ...(withIndex ? [] : ['']),
    '- When a note changes, keep its name, description and type in step with it.',
    '- Group notes by subject, not by date.',
    '- Before writing, check whether an existing note already covers the topic, and update that one instead.',
    '- Fix or delete notes that turn out to be wrong.',
  ]
}

function otherPersistenceSection(): string[] {
  return [
    '## Memory versus other places to keep things',
    'Memory is for what a later conversation will need. Information that only matters inside this conversation belongs elsewhere:',
    '- Before a non-trivial change where you want the user to agree on the approach, use a plan, not memory. If the approach changes, update the plan.',
    '- To track the steps of the current task and your progress through them, use tasks, not memory.',
    ...PROJECT_NOTES_BULLETS,
  ]
}

function optionalNoteRules(rc: RuntimeConfig): string[] {
  const extra = rc.getEnv('VELLOC_MEMORY_PROMPT_ADDENDUM')?.trim()
  return extra ? [extra] : []
}

function standardPrompt(
  dir: string,
  title: string,
  writeToolName: string | undefined,
  rc: RuntimeConfig,
): string {
  const sections: string[][] = [
    [`# ${title}`, ''],
    [
      `Your memory is a folder of notes at \`${dir}\` that persists between sessions. ${directoryReadySentence(writeToolName)}`,
      '',
    ],
    [PURPOSE_PARAGRAPH, '', EXPLICIT_REQUESTS, ''],
    [...KIND_GUIDE_LINES],
    [...EXCLUSION_LINES, ''],
    [...noteFilingLines(), ''],
    [...RECALL_TIMING_LINES, ''],
    [...RECALL_VERIFY_LINES, ''],
    otherPersistenceSection(),
    ['', ...optionalNoteRules(rc)],
  ]
  return sections.flat().join('\n')
}

/** Daily-log mode: append to a dated log; a nightly pass rebuilds the index. */
function dailyLogPrompt(dir: string): string {
  const logPattern = joinPath(dir, 'logs', 'YYYY', 'MM', 'YYYY-MM-DD.md')
  return [
    '# Memory',
    '',
    `Your memory is a folder of notes at \`${dir}\` that persists between sessions.`,
    '',
    "This memory works as a running journal. Whenever something comes up that is worth keeping for future conversations, add it to today's daily log file:",
    '',
    `\`${logPattern}\``,
    '',
    "Substitute today's date into the pattern above. If the file or its folders do not exist yet, create them; otherwise add your entry at the end. The log is a record, so it is append-only — never rewrite, reorder, or delete earlier entries. Keep each entry to a short bullet.",
    '',
    '## What to log',
    '- Who the user is: their role, goals, expertise, and how they like to work with you.',
    '- Guidance the user gives about your approach — corrections and confirmations alike — with the reason when they give one.',
    '- Decisions, deadlines, and context about ongoing work that the code and its history do not show (write dates as absolute dates).',
    '- Where to find things in outside systems, such as trackers, dashboards, or channels.',
    '- Anything the user explicitly asks you to remember.',
    '',
    ...EXCLUSION_LINES,
    '',
    `## ${MEMORY_INDEX_FILE}`,
    `\`${MEMORY_INDEX_FILE}\` is the index of distilled memories. A nightly pass rebuilds it from these logs, so do not edit it directly — put new information in today's log instead.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type MemoryPromptOptions = {
  cwd: string
  fs?: RuntimeFs
  projectRoot?: string
  homeDir?: string
  memorySettings?: ResolvedMemorySettings
  runtimeConfig: RuntimeConfig
  /** Heading for the block; `Memory` by default. */
  displayName?: string
  /** The tool this session writes files with, named in the instructions. */
  writeToolName?: string
}

/** The memory block for the system prompt, or `null` when memory is off. */
export async function buildMemorySystemPrompt(
  options: MemoryPromptOptions,
): Promise<string | null> {
  const rc = options.runtimeConfig
  if (!isMemoryEnabled(rc, options.memorySettings)) return null

  const fs = options.fs ?? processFs()
  const dir = await resolveMemoryDir(options.cwd, rc, fs, {
    projectRoot: options.projectRoot,
    homeDir: options.homeDir,
    memorySettings: options.memorySettings,
  })
  try {
    await fs.mkdir(dir.replace(/[\\/]+$/, ''))
  } catch {
    // Already there, or the host cannot create it; the prompt still applies.
  }

  if (options.memorySettings?.memoryMaintenance === 'dailyLog') return dailyLogPrompt(dir)
  return standardPrompt(dir, options.displayName ?? 'Memory', options.writeToolName, rc)
}
