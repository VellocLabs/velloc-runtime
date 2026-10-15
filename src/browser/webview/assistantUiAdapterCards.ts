import type { ThreadMessageLike } from '@assistant-ui/react'
import type { Message } from '../../runtime/RuntimeTypes'
import { compactCount } from '../../utils/humanize/compactCount'
import { asDate, backgroundResultKind } from './assistantUiAdapterParts'
import type { ParsedTeamMessage } from '../../team/parseTeamFrame'

/**
 * Synthetic thread messages with no runtime `Message` behind them, each builder kept beside the
 * predicate that recognises it: both encode the same card identity, so change them together.
 */

export function compactBoundaryThreadMessage(message: Message): ThreadMessageLike {
  const meta = (message as { compactMetadata?: { trigger?: unknown; preTokens?: unknown } })
    .compactMetadata
  const preTokens =
    typeof meta?.preTokens === 'number' ? meta.preTokens : undefined
  const trigger = typeof meta?.trigger === 'string' ? meta.trigger : undefined
  return {
    id: message.uuid ?? 'compact-boundary',
    createdAt: asDate(message.timestamp),
    role: 'assistant',
    content: [
      {
        type: 'text',
        text:
          preTokens !== undefined
            ? `Compacted conversation · saved ${compactCount(preTokens)} tokens`
            : 'Compacted conversation',
      },
    ],
    status: { type: 'complete', reason: 'stop' },
    metadata: {
      custom: {
        sourceType: 'compact_boundary',
        ...(trigger ? { trigger } : {}),
        ...(preTokens !== undefined ? { preTokens } : {}),
      },
    },
  }
}

export function memorySavedThreadMessage(message: Message): ThreadMessageLike {
  // The system message body is the pre-formatted label ("Saved memory:
  // user_role.md" — see engine/turnLoop.ts's `memory_saved` surfacing). Thread.tsx
  // dispatches on `sourceType: 'memory_saved'` and renders a
  // TranscriptDivider with this label (`memorySavedText`); the text content
  // below is the export / a11y fallback.
  const rawLabel = (message as { message?: unknown }).message
  const label = typeof rawLabel === 'string' ? rawLabel : 'Saved memory'
  return {
    id: message.uuid ?? 'memory-saved',
    createdAt: asDate(message.timestamp),
    role: 'assistant',
    content: [{ type: 'text', text: label }],
    status: { type: 'complete', reason: 'stop' },
    metadata: {
      custom: {
        sourceType: 'memory_saved',
        memorySavedText: label,
      },
    },
  }
}

export function compactProgressThreadMessage(stage: 'start' | 'end'): ThreadMessageLike {
  return {
    id: 'live-compact-progress',
    role: 'assistant',
    content: [{ type: 'text', text: 'Compacting conversation' }],
    status:
      stage === 'start'
        ? { type: 'running' }
        : { type: 'complete', reason: 'stop' },
    metadata: {
      custom: {
        sourceType: 'compact_progress',
        stage,
      },
    },
  }
}

export function backgroundResultsThreadMessage(params: {
  id?: string
  createdAt?: Date
  text: string
  kind: 'shell' | 'subagent'
}): ThreadMessageLike {
  return {
    id: params.id ?? 'background-results',
    createdAt: params.createdAt,
    role: 'assistant',
    content: [{ type: 'text', text: params.text }],
    status: { type: 'complete', reason: 'stop' },
    metadata: {
      custom: {
        sourceType: 'background_results',
        backgroundResultKind: params.kind,
        backgroundResultText: params.text,
      },
    },
  }
}

export function teamMessageThreadMessage(params: {
  id?: string
  createdAt?: Date
  parsed: ParsedTeamMessage
}): ThreadMessageLike {
  const { parsed } = params
  return {
    id: params.id ?? 'team-message',
    // A peer's message is not the user speaking and not this session
    // thinking, but assistant-ui has only the two roles. `assistant` is the
    // right one for the same reason the background-results card uses it: it
    // renders as a full-width card rather than a user bubble, which is what
    // a card that is neither is meant to look like.
    role: 'assistant',
    createdAt: params.createdAt,
    // The BODY, not the envelope: an export or a screen reader gets the
    // peer's text, not four lines of instructions addressed to a model.
    content: [{ type: 'text', text: parsed.body }],
    status: { type: 'complete', reason: 'stop' },
    metadata: {
      custom: {
        sourceType: 'team_message',
        teamMessageFrom: parsed.from,
        teamMessageFromDisplay: parsed.fromDisplay,
        teamMessageTrust: parsed.trust,
        teamMessageKind: parsed.kind,
        teamMessageBody: parsed.body,
      },
    },
  }
}

export function isCompactBoundaryThreadMessage(message: ThreadMessageLike): boolean {
  return (
    (message.metadata?.custom as { sourceType?: unknown } | undefined)
      ?.sourceType === 'compact_boundary'
  )
}

export function isCompactProgressThreadMessage(message: ThreadMessageLike): boolean {
  return (
    (message.metadata?.custom as { sourceType?: unknown } | undefined)
      ?.sourceType === 'compact_progress'
  )
}

export function isBackgroundResultsThreadMessage(message: ThreadMessageLike): boolean {
  return (
    (message.metadata?.custom as { sourceType?: unknown } | undefined)
      ?.sourceType === 'background_results'
  )
}

export function isProviderApiErrorThreadMessage(message: ThreadMessageLike): boolean {
  return (
    (message.metadata?.custom as { sourceType?: unknown } | undefined)
      ?.sourceType === 'provider_api_error'
  )
}

export function isTeamMessageThreadMessage(message: ThreadMessageLike): boolean {
  return (
    (message.metadata?.custom as { sourceType?: unknown } | undefined)
      ?.sourceType === 'team_message'
  )
}
