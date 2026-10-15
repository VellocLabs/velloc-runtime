/**
 * The system-prompt events (F-25): `prompt.section` (`{ name, text }` → `{ text }`,
 * `null` omits it), `prompt.compose` (the whole section list, `shared` before
 * `session`) and `prompt.context` (the first user message's context). Pure.
 */

import type { SystemPromptNamedPart } from '../runtime/interfaces/PromptContextProvider'

export type PromptComposeScope = 'shared' | 'session'

export type PromptComposeSection = {
  id: string
  text: string
  scope: PromptComposeScope
}

export type PromptComposeTrait = 'bare' | 'lean' | 'sdk-preset' | 'teammate' | 'analysis' | 'print' | 'skills' | 'send-user-message'

export type PromptComposeInput = {
  model: string
  promptModel: string
  surfaces: readonly string[]
  tools: readonly string[]
  outputStyle: { name: string; isKeepingCodingInstructions: boolean } | null
  traits: readonly PromptComposeTrait[]
}

export type PromptContextBlock = { name: string; text: string }

export type InstructionFileKind = 'managed' | 'user' | 'project' | 'local' | 'memory'

export type InstructionFile = {
  path: string
  kind: InstructionFileKind
  content: string
  parent?: string
}

export type PromptContextInput = {
  blocks: readonly PromptContextBlock[]
  instructionFiles?: readonly InstructionFile[]
}

/**
 * The sections of Velloc's prompt whose text varies per session — the cache
 * boundary's `session` side; every other named part (the template's holders,
 * the tool catalog) reads the same for everyone on this build and model.
 */
export const SESSION_SECTION_NAMES: readonly string[] = Object.freeze([
  'custom_system_prompt',
  'append_system_prompt',
  'env_info',
  'memory',
  'instruction_persistence',
  'scratchpad',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Velloc's named parts as `prompt.compose` lists them: an id that is never
 * empty and unique in the list (an unnamed literal line is `line_<n>`, a
 * repeated name takes `#2`, `#3`, …), and the side of the boundary.
 */
export function composeSectionsOf(parts: ReadonlyArray<SystemPromptNamedPart>): PromptComposeSection[] {
  const taken = new Map<string, number>()
  return parts.map((part, index) => {
    const base = part.name !== undefined && part.name !== '' ? part.name : `line_${index + 1}`
    const seen = taken.get(base) ?? 0
    taken.set(base, seen + 1)
    const id = seen === 0 ? base : `${base}#${seen + 1}`
    return {
      id,
      text: part.text,
      scope: SESSION_SECTION_NAMES.includes(base) ? 'session' : 'shared',
    }
  })
}

/** `{ text }` with a string or null. */
export function isPromptSectionResult(value: unknown): boolean {
  return isRecord(value) && (typeof value.text === 'string' || value.text === null)
}

/**
 * `{ sections }`: each `{ id, text, scope? }` with a non-empty id unique in
 * the list and a string text; every `shared` one ahead of every `session`
 * one ("a list with a shared section after a session one skips the hook").
 * A section without a scope counts as `session` ("a section added at the
 * end of what next(e) answered is session") — so it must come last.
 */
export function isPromptComposeResult(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.sections)) return false
  const ids = new Set<string>()
  let sawSession = false
  for (const section of value.sections) {
    if (!isRecord(section)) return false
    if (typeof section.id !== 'string' || section.id === '' || ids.has(section.id)) return false
    if (typeof section.text !== 'string') return false
    if (section.scope !== undefined && section.scope !== 'shared' && section.scope !== 'session') return false
    ids.add(section.id)
    const scope = section.scope ?? 'session'
    if (scope === 'session') sawSession = true
    else if (sawSession) return false
  }
  return true
}

/** The list a `prompt.compose` answer holds, each scope made explicit. */
export function composeSectionsFrom(result: unknown): PromptComposeSection[] {
  const sections = (result as { sections: Array<{ id: string; text: string; scope?: PromptComposeScope }> }).sections
  return sections.map(section => ({ id: section.id, text: section.text, scope: section.scope ?? 'session' }))
}

const INSTRUCTION_FILE_KINDS: readonly string[] = ['managed', 'user', 'project', 'local', 'memory']

function isInstructionFile(value: unknown): value is InstructionFile {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.kind === 'string' &&
    INSTRUCTION_FILE_KINDS.includes(value.kind) &&
    typeof value.content === 'string' &&
    (value.parent === undefined || typeof value.parent === 'string')
  )
}

/** `{ blocks, instructionFiles? }`: each block `{ name, text }` with a
 *  non-empty name unique in the list. */
export function isPromptContextResult(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.blocks)) return false
  const names = new Set<string>()
  for (const block of value.blocks) {
    if (!isRecord(block) || typeof block.name !== 'string' || block.name === '' || typeof block.text !== 'string') return false
    if (names.has(block.name)) return false
    names.add(block.name)
  }
  return value.instructionFiles === undefined || (Array.isArray(value.instructionFiles) && value.instructionFiles.every(isInstructionFile))
}

/** Velloc's instruction-file tier as the declaration spells it. */
export function instructionKindOf(type: string): InstructionFileKind {
  switch (type) {
    case 'User':
      return 'user'
    case 'Project':
      return 'project'
    case 'Local':
      return 'local'
    case 'Managed':
      return 'managed'
    default:
      return 'memory'
  }
}

/** The declaration's tier back to Velloc's, for a file a hook added. */
export function memoryTypeOf(kind: InstructionFileKind): 'User' | 'Project' | 'Local' | 'AutoMem' {
  switch (kind) {
    case 'user':
    case 'managed':
      return 'User'
    case 'project':
      return 'Project'
    case 'local':
      return 'Local'
    default:
      return 'AutoMem'
  }
}
