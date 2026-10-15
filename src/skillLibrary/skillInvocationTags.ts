import type { Message } from '../runtime/RuntimeTypes'

/**
 * The skill-invocation message: one isMeta user message of loading tags plus
 * the expanded body. The body is persisted as a lazy detail keyed
 * `skill:<message uuid>` (`toolName: 'Skill'`); the transcript keeps the tags
 * and a marker line, and the full text is hydrated before every turn.
 * Type-only imports.
 */

export const SKILL_BODY_DETAIL_ID_PREFIX = 'skill:'

/** Replaces the body in the persisted/UI copy. Never shown to the user (the
 *  card loads the real body); the model only sees it if the sidecar is lost. */
export const SKILL_BODY_STUB_MARKER =
  '[Skill instructions are stored in tool-details and loaded on demand.]'

const COMMAND_MESSAGE_OPEN = '<command-message>'

export type SkillInvocationTags = {
  /** Skill name as written in `<command-message>`. */
  name: string
  /** `<command-args>` payload (slash form), if any. */
  args?: string
  /** `<skill-format>true</skill-format>` — the model-only (non user-invocable) form. */
  skillFormat: boolean
}

export function skillBodyDetailId(messageUuid: string): string {
  return `${SKILL_BODY_DETAIL_ID_PREFIX}${messageUuid}`
}

export function isSkillBodyDetailId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(SKILL_BODY_DETAIL_ID_PREFIX)
}

function readTag(content: string, tag: string): string | undefined {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = content.indexOf(open)
  if (start < 0) return undefined
  const end = content.indexOf(close, start + open.length)
  if (end < 0) return undefined
  return content.slice(start + open.length, end)
}

/**
 * Parse the loading-metadata tags off a skill-invocation text. Returns null
 * for anything that does not START with `<command-message>` — the tags are
 * only ever emitted by `formatSkillInvocationMessage`, so that prefix is the
 * discriminator for "this isMeta message is a skill invocation".
 */
export function parseSkillInvocationTags(
  content: unknown,
): SkillInvocationTags | null {
  if (typeof content !== 'string' || !content.startsWith(COMMAND_MESSAGE_OPEN)) {
    return null
  }
  const name = readTag(content, 'command-message')
  if (!name) return null
  const args = readTag(content, 'command-args')
  return {
    name,
    ...(args !== undefined ? { args } : {}),
    skillFormat: readTag(content, 'skill-format') === 'true',
  }
}

/** The tag header of a skill-invocation text: everything before the first
 *  blank line (`formatSkillInvocationMessage` joins tags, '', body). */
function skillInvocationHeader(content: string): string {
  const at = content.indexOf('\n\n')
  return at < 0 ? content : content.slice(0, at)
}

/** The persisted/UI stand-in for a full skill-invocation text. */
export function skillInvocationStub(content: string): string {
  return `${skillInvocationHeader(content)}\n\n${SKILL_BODY_STUB_MARKER}`
}

/** True when `content` is a stub (body stripped) rather than the full text. */
export function isSkillInvocationStub(content: unknown): boolean {
  return (
    typeof content === 'string' &&
    content.startsWith(COMMAND_MESSAGE_OPEN) &&
    content.endsWith(SKILL_BODY_STUB_MARKER)
  )
}

/** The skill-body detail id a message carries, if it is a skill invocation
 *  persisted with a sidecar (messages from before this change have none). */
export function getSkillBodyDetailId(message: Message): string | null {
  const ref = (message as { toolCallDetailRef?: { toolCallId?: unknown } })
    .toolCallDetailRef
  return isSkillBodyDetailId(ref?.toolCallId) ? ref.toolCallId : null
}
