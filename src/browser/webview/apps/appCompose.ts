/**
 * The reserved `compose` event of an app's own surfaces (F-40): its `text`
 * becomes the session's composer draft for the person to edit and send, and
 * its `quote`, when present, the draft's one quote card above it. Nothing
 * reaches the model or the app's background module.
 */
import { requestPane } from '../a2ui/a2uiPaneBus'
import { focusSessionComposer, isSessionComposerDisabled } from '@/components/assistant-ui/composer-passages'

export const APP_COMPOSE_EVENT = 'compose'
export const APP_COMPOSE_MAX_CHARS = 8000
export const APP_COMPOSE_QUOTE_MAX_CHARS = 16000
const FOCUS_FRAMES = 10

/** `value` trimmed and capped at `max` UTF-16 units, never splitting a surrogate pair; null unless a non-blank string. */
function cappedField(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  let field = value.trim()
  if (field.length > max) {
    field = field.slice(0, max)
    const last = field.charCodeAt(field.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) field = field.slice(0, -1)
  }
  return field === '' ? null : field
}

function fieldOf(context: unknown, key: 'text' | 'quote'): unknown {
  if (typeof context !== 'object' || context === null) return undefined
  return (context as Record<string, unknown>)[key]
}

/** The draft a compose event's context carries: `text` trimmed and capped; null when there is none. */
export function composeDraftOf(context: unknown): string | null {
  return cappedField(fieldOf(context, 'text'), APP_COMPOSE_MAX_CHARS)
}

/** The quote card a compose event's context carries: `quote` trimmed and capped; null when there is none. */
export function composeQuoteOf(context: unknown): string | null {
  return cappedField(fieldOf(context, 'quote'), APP_COMPOSE_QUOTE_MAX_CHARS)
}

/**
 * Puts `draft` in `sessionId`'s composer: the session's expanded pane is
 * restored so its chat shows, `setText` replaces the whole draft, and that
 * thread's composer takes focus once it can (a few frames, while the layout
 * settles). Nothing happens while that composer is disabled.
 */
export function composeIntoSession(sessionId: string, draft: string, setText: (text: string) => void): void {
  if (isSessionComposerDisabled(sessionId)) return
  requestPane({ sessionId, restore: true })
  setText(draft)
  let frames = 0
  const focus = () => {
    if (focusSessionComposer(sessionId) || ++frames >= FOCUS_FRAMES) return
    requestAnimationFrame(focus)
  }
  requestAnimationFrame(focus)
}
