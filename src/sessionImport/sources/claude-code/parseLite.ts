/**
 * Quick list pass for the external JSONL session format: one dialog row per
 * file, computed from a head slice and a tail slice only. Record keys
 * (`cwd`, `customTitle`, `isSidechain`, ...) are the file format's own.
 */

import type { ImportLiteItem, ImportSessionLiteRow } from '../../protocol'
import { pickSessionTitle, promptToTitle } from '../../core/sessionTitle'
import {
  firstStringValue,
  lastStringValue,
  hasTrueFlag,
} from './jsonlFields'

const UUID_FILE_NAME =
  /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i

/** Lower-cased uuid when the path's base name is `<uuid>.jsonl`, else null. */
export function sessionUuidFromFileName(path: string): string | null {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const hit = UUID_FILE_NAME.exec(base)
  return hit ? hit[1]!.toLowerCase() : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The prompt strings in a user message body: the whole string, or each
 *  string-valued text block of an array. */
export function userTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  return texts
}

/** Message body of a real user-typed record, or undefined for anything else
 *  (other record kinds, meta lines, compact summaries, unparsable text). */
function typedUserContent(rawLine: string): unknown {
  let record: unknown
  try {
    record = JSON.parse(rawLine)
  } catch {
    return undefined
  }
  if (!isPlainObject(record) || record.type !== 'user') return undefined
  if (record.isMeta === true || record.isCompactSummary === true) return undefined
  return isPlainObject(record.message) ? record.message.content : undefined
}

/** Title-ready text of the first real user prompt in the head; when only
 *  slash commands appear, the first command name. Empty when neither. */
export function firstPromptInHead(head: string): string {
  let slashFallback = ''
  for (const rawLine of head.split('\n')) {
    // Tool output rows are user-typed records too; the raw key check keeps
    // them out without a structural walk.
    if (rawLine.trim() === '' || rawLine.includes('"tool_result"')) continue
    const content = typedUserContent(rawLine)
    if (content === undefined) continue
    for (const text of userTextBlocks(content)) {
      const verdict = promptToTitle(text)
      if (!verdict) continue
      if ('title' in verdict) return verdict.title
      slashFallback ||= verdict.command
    }
  }
  return slashFallback
}

function latestIn(slices: readonly string[], key: string): string | undefined {
  for (let i = slices.length - 1; i >= 0; i--) {
    const found = lastStringValue(slices[i]!, key)
    if (found !== undefined) return found
  }
  return undefined
}

/** Row title. Renames and generated titles may sit anywhere, so both slices
 *  are searched; the latest prompt / summary records only matter at the end. */
export function titleFromSlices(head: string, tail: string): string | null {
  return pickSessionTitle({
    customTitle: latestIn([head, tail], 'customTitle'),
    aiTitle: latestIn([head, tail], 'aiTitle'),
    lastPrompt: latestIn([tail], 'lastPrompt'),
    summary: latestIn([tail], 'summary'),
    firstPrompt: firstPromptInHead(head),
  })
}

function describeFile(file: ImportLiteItem): ImportSessionLiteRow {
  const { head, tail, path } = file
  const cwd = firstStringValue(head, 'cwd')
  const opening = head.split('\n', 1)[0]!
  // A side-agent transcript is flagged on its very first record.
  const sideAgent = hasTrueFlag(opening, 'isSidechain')
  return {
    source: 'claude-code',
    path,
    sessionId:
      sessionUuidFromFileName(path) ?? firstStringValue(head, 'sessionId') ?? path,
    title: titleFromSlices(head, tail),
    projectPath: cwd ?? null,
    createdAt: firstStringValue(head, 'timestamp') ?? null,
    mtimeMs: file.mtimeMs,
    size: file.size,
    importable: cwd !== undefined && !sideAgent,
  }
}

export function listSessionRows(
  files: readonly ImportLiteItem[],
): ImportSessionLiteRow[] {
  return files.map(describeFile)
}
