import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type {
  ContextRow,
  AttachmentPayload,
  ContentBlockParam,
  Message,
  NoticeRow,
  SystemMessagePart,
  UserRow,
} from '../runtime/RuntimeTypes'
import { renderPartsEnglish } from '../input/systemMessageParts'
import {
  MSG_TYPE_SYSTEM,
  MSG_TYPE_ATTACHMENT,
  MSG_TYPE_USER,
  ROLE_USER,
  SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
} from '../runtime/VercelModelConstants'

// Canonical user-visible markers that a turn was interrupted, written into
// the transcript as-is. They are fixed strings so downstream tooling
// (session storage, insights) can pattern-match on a single well-known
// string.
export const STOPPED_BY_USER_TEXT = '[Request interrupted by user]'
export const STOPPED_DURING_TOOL_TEXT =
  '[Request interrupted by user for tool use]'

function createFallbackUUID(): string {
  return `msg-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

export function createGeneratedUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? createFallbackUUID()
}

export function createGeneratedTimestamp(): string {
  return new Date().toISOString()
}

export function makeNoticeRow(
  runtimeConfig: RuntimeConfig,
  message: string,
  // `informational` — the generic bucket. The former default, `browser_input`, was a
  // leftover from the browse-agent era and described neither the sender
  // nor the content of what it labelled (plan-approval notices, slash
  // output, …). Nothing has ever branched on it — the subtypes that
  // carry behaviour are `compact_boundary`, `memory_saved`, `init` and
  // `api_error` — so transcripts already on disk keep rendering exactly
  // as before.
  subtype = 'informational',
  /**
   * Translatable parts of the same content. When present the webview renders
   * these in the user's language; `message` stays English for the model (it
   * rides into the next request as a `role:"system"` turn) and as the copy /
   * a11y fallback. See input/systemMessageParts.ts.
   */
  i18nContent?: SystemMessagePart[],
): NoticeRow {
  return {
    type: MSG_TYPE_SYSTEM,
    subtype,
    uuid: runtimeConfig.createUUID(),
    timestamp: runtimeConfig.createTimestamp(),
    message,
    ...(i18nContent ? { i18nContent } : {}),
  }
}

/**
 * Compose a system message from translatable parts: renders the English the
 * model will read, and carries the parts for the webview to translate.
 */
export function createLocalizedSystemMessage(
  runtimeConfig: RuntimeConfig,
  parts: SystemMessagePart[],
  subtype = 'informational',
): NoticeRow {
  return makeNoticeRow(
    runtimeConfig,
    renderPartsEnglish(parts),
    subtype,
    parts,
  )
}

export function makeContextRow(
  runtimeConfig: RuntimeConfig,
  attachment: AttachmentPayload,
): ContextRow {
  return {
    type: MSG_TYPE_ATTACHMENT,
    uuid: runtimeConfig.createUUID(),
    timestamp: runtimeConfig.createTimestamp(),
    attachment,
  }
}

export function makeUserRow(
  runtimeConfig: RuntimeConfig,
  input: string | Array<ContentBlockParam>,
  uuid?: string,
  isMeta = false,
  origin?: UserRow['origin'],
): UserRow {
  return {
    type: MSG_TYPE_USER,
    uuid: uuid ?? runtimeConfig.createUUID(),
    timestamp: runtimeConfig.createTimestamp(),
    message: {
      role: ROLE_USER,
      content: input,
    },
    isMeta,
    ...(origin ? { origin } : {}),
  }
}

export function createGeneratedUserMessage(
  input: string | Array<ContentBlockParam>,
  options: { isMeta?: boolean } = {},
): UserRow {
  return {
    type: MSG_TYPE_USER,
    uuid: createGeneratedUuid(),
    timestamp: createGeneratedTimestamp(),
    message: {
      role: ROLE_USER,
      content: input,
    },
    isMeta: options.isMeta ?? true,
  }
}

// Synthetic `[Request interrupted by user]` marker yielded on a user abort, so
// the transcript stays well-formed and the model sees the interrupt next turn.
export function makeStopRow(
  uuid: string,
  options: { toolUse?: boolean; timestamp?: string } = {},
): UserRow {
  const text = options.toolUse
    ? STOPPED_DURING_TOOL_TEXT
    : STOPPED_BY_USER_TEXT
  return {
    type: MSG_TYPE_USER,
    uuid,
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    message: {
      role: ROLE_USER,
      content: [
        {
          type: 'text',
          text,
        },
      ],
    },
  }
}

export function cloneMessage<T extends Message>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T
}

/**
 * Mints a `compact_boundary` system message that marks the point where the
 * conversation was compacted. Its `compact_boundary` subtype is what the
 * slicing helpers in `context/compaction/boundary.ts` look for, so the API
 * submission path skips everything before the most recent boundary.
 */
export function makeFoldLine(
  trigger: 'manual' | 'auto',
  preTokens: number,
  lastFoldedRowId?: string,
): NoticeRow {
  return {
    type: MSG_TYPE_SYSTEM,
    subtype: SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
    uuid: createGeneratedUuid(),
    timestamp: createGeneratedTimestamp(),
    message: 'Conversation compacted',
    compactMetadata: {
      trigger,
      preTokens,
      ...(lastFoldedRowId
        ? { lastPreCompactMessageUuid: lastFoldedRowId }
        : {}),
    },
  } as NoticeRow
}

