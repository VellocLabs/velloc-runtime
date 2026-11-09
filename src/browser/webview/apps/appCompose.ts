/**
 * The reserved `compose` event of an app's own surfaces (F-40): its `text`
 * becomes the session's composer draft for the person to edit and send.
 * Nothing reaches the model or the app's background module.
 */
import { requestPane } from '../a2ui/a2uiPaneBus'
import { focusSessionComposer } from '@/components/assistant-ui/composer-passages'

export const APP_COMPOSE_EVENT = 'compose'
export const APP_COMPOSE_MAX_CHARS = 8000
const FOCUS_FRAMES = 10

/** The draft a compose event's context carries: `text` trimmed and capped; null when there is none. */
export function composeDraftOf(context: unknown): string | null {
  if (typeof context !== 'object' || context === null) return null
  const text = (context as { text?: unknown }).text
  if (typeof text !== 'string') return null
  let draft = text.trim()
  if (draft.length > APP_COMPOSE_MAX_CHARS) {
    draft = draft.slice(0, APP_COMPOSE_MAX_CHARS)
    // Do not leave half of a surrogate pair at the cut.
    const last = draft.charCodeAt(draft.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) draft = draft.slice(0, -1)
  }
  return draft === '' ? null : draft
}

/**
 * Puts `draft` in `sessionId`'s composer: the session's expanded pane is
 * restored so its chat shows, the text replaces the composer's, and that
 * thread's composer takes focus once it can (a few frames, while the layout
 * settles).
 */
export function composeIntoSession(sessionId: string, draft: string, setText: (text: string) => void): void {
  requestPane({ sessionId, restore: true })
  setText(draft)
  let frames = 0
  const focus = () => {
    if (focusSessionComposer(sessionId) || ++frames >= FOCUS_FRAMES) return
    requestAnimationFrame(focus)
  }
  requestAnimationFrame(focus)
}
