/**
 * Lists the topic files in a memory directory with their frontmatter summary,
 * and renders that list as the one-line-per-file manifest models read.
 */

import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { toMemoryKind, type MemoryKind } from './memoryKinds'
import { MEMORY_INDEX_FILE } from './memoryPrompt'

export type MemoryFileEntry = {
  /** Path relative to the scanned directory. */
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryKind | undefined
}

const DEEPEST_LEVEL = 5
const HEADER_CHARS = 4_000
const LIST_CAP = 200

function unquote(value: string): string {
  const first = value[0]
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1)
  }
  return value
}

/** `key: value` pairs between a leading `---` line and the next `---` line. */
function frontmatterFields(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  if (!text.startsWith('---\n')) return fields
  const close = text.indexOf('\n---\n', 3)
  if (close < 0) return fields
  for (const line of text.slice(4, close).split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    fields.set(line.slice(0, colon).trim(), unquote(line.slice(colon + 1).trim()))
  }
  return fields
}

type Candidate = { relative: string; absolute: string }

async function listNoteFiles(
  fs: RuntimeFs,
  root: string,
  signal: AbortSignal,
): Promise<Candidate[]> {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '')
  const found: Candidate[] = []
  const queue: Array<{ dir: string; relative: string; level: number }> = [
    { dir: base, relative: '', level: 0 },
  ]
  while (queue.length > 0) {
    if (signal.aborted) break
    const { dir, relative, level } = queue.shift()!
    let entries
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = `${dir}${sep}${entry.name}`
      const rel = relative === '' ? entry.name : `${relative}${sep}${entry.name}`
      if (entry.isDirectory()) {
        if (level < DEEPEST_LEVEL) queue.push({ dir: absolute, relative: rel, level: level + 1 })
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        entry.name !== MEMORY_INDEX_FILE
      ) {
        found.push({ relative: rel, absolute })
      }
    }
  }
  return found
}

async function describe(
  fs: RuntimeFs,
  file: Candidate,
): Promise<MemoryFileEntry | undefined> {
  try {
    const info = await fs.stat(file.absolute)
    const text = await fs.readFile(file.absolute, { encoding: 'utf8' })
    const fields = frontmatterFields(String(text).slice(0, HEADER_CHARS))
    return {
      filename: file.relative,
      filePath: file.absolute,
      mtimeMs: info.mtimeMs ?? 0,
      description: fields.get('description') ?? null,
      type: toMemoryKind(fields.get('type')),
    }
  } catch {
    return undefined
  }
}

/** Newest first, at most 200 entries; `MEMORY.md` is never listed. */
export async function listMemoryFiles(
  dir: string,
  signal: AbortSignal,
  fs: RuntimeFs = processFs(),
): Promise<MemoryFileEntry[]> {
  const candidates = await listNoteFiles(fs, dir, signal)
  const described = await Promise.all(candidates.map(c => describe(fs, c)))
  return described
    .filter((e): e is MemoryFileEntry => e !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, LIST_CAP)
}

export function renderMemoryManifest(entries: MemoryFileEntry[]): string {
  return entries
    .map(entry => {
      const tag = entry.type ? `[${entry.type}] ` : ''
      const stamp = new Date(entry.mtimeMs).toISOString()
      const about = entry.description ? `: ${entry.description}` : ''
      return `- ${tag}${entry.filename} (${stamp})${about}`
    })
    .join('\n')
}
