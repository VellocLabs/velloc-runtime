// Lazy host wrapping the conversation with the shared A2UI runtime: one per-session
// MessageProcessor, the transcript feeder, the action loop, the presentation context
// and the side pane portal. Loaded only when a conversation has an `a2ui_*` tool call.

import {
  Component,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  A2UIProvider,
  A2UIRenderer,
  useA2UI,
  type A2UIClientEventMessage,
} from '@copilotkit/a2ui-renderer'
// The renderer's Icon relies on the Material Symbols font's ligatures; self-host
// it here (the lazy host) so the ~475 KB woff2 lands in the on-demand A2UI chunk.
import '@material-symbols/font-400/outlined.css'
// Scoped fix for the catalog's width:100%+margin right-overflow (uneven margins).
import './a2ui-surface.css'
import type { Message } from '../../../runtime/RuntimeTypes'
import { extractA2uiCommands } from './surfaceStore'
import { commandsToA2uiMessages } from './toA2uiMessages'
import { vellocCatalog } from './catalog/vellocCatalog'
import {
  A2uiPresentationProvider,
  useA2uiPresentation,
} from './A2uiPresentationContext'
import { useT } from '../i18n'
import { getOwner, getSlot, setOwner, subscribeSlot } from './a2uiPaneBus'

type SurfaceUserAction = {
  name?: string
  surfaceId?: string
  sourceComponentId?: string
  context?: unknown
}
type SurfaceActionHandler = (message: A2UIClientEventMessage) => void

const ACTION_PROMPT_PREFIX =
  'A user interacted with an A2UI surface you created (e.g. a button click). ' +
  'Respond by updating that surface IN PLACE — reuse the same surfaceId with ' +
  'a2ui_update_data_model and/or a2ui_update_components — or with a brief chat ' +
  'reply if that fits better. Do not narrate this event to the user. The ' +
  'action and the surface’s current data model:'

function buildActionTurn(action: SurfaceUserAction, dataModel: unknown): string {
  const payload = {
    surfaceId: action.surfaceId ?? null,
    action: action.name ?? 'unknown',
    sourceComponentId: action.sourceComponentId ?? null,
    context: action.context ?? null,
    dataModel: dataModel ?? {},
  }
  return `${ACTION_PROMPT_PREFIX}\n\n<a2ui_action>\n${JSON.stringify(payload)}\n</a2ui_action>`
}

class SurfaceErrorBoundary extends Component<
  { surfaceId: string; fallbackText: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(error: unknown): void {
    console.error('[a2ui] surface render error', this.props.surfaceId, error)
  }
  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-xs text-warning">
          {this.props.fallbackText}
        </div>
      )
    }
    return this.props.children
  }
}

// Lives INSIDE <A2UIProvider> so it can reach the processor. Feeds new
// transcript commands into the shared processor and installs the surface-action
// handler (which needs getSurface to snapshot the live data model).
function A2uiFeeder({
  messages,
  submitActionMessage,
  busy,
  actionHandlerRef,
}: {
  messages: readonly Message[]
  submitActionMessage?: (prompt: string) => Promise<void>
  busy: boolean
  actionHandlerRef: React.MutableRefObject<SurfaceActionHandler | null>
}) {
  const { processMessages, getSurface } = useA2UI()
  const commands = useMemo(() => extractA2uiCommands(messages), [messages])
  const processedRef = useRef(0)
  const busyRef = useRef(busy)
  busyRef.current = busy

  // Feed only NEW commands each turn; dedupe createSurface for existing ids and
  // feed one message at a time so one malformed message can't abort the batch.
  useEffect(() => {
    if (commands.length <= processedRef.current) return
    const fresh = commands.slice(processedRef.current)
    processedRef.current = commands.length
    const createdThisBatch = new Set<string>()
    for (const message of commandsToA2uiMessages(fresh, vellocCatalog.id)) {
      const create = (message as { createSurface?: { surfaceId?: unknown } })
        .createSurface
      const id = create?.surfaceId
      if (typeof id === 'string') {
        if (getSurface(id) || createdThisBatch.has(id)) continue
        createdThisBatch.add(id)
      }
      processMessages([message as Record<string, unknown>])
    }
  }, [commands, processMessages, getSurface])

  // Forward surface actions to the model as a hidden isMeta turn (gated while a
  // turn is in flight — one action per turn).
  useEffect(() => {
    actionHandlerRef.current = (message: A2UIClientEventMessage) => {
      try {
        if (!submitActionMessage || busyRef.current) return
        const action = (message as { userAction?: SurfaceUserAction }).userAction
        if (!action || typeof action.surfaceId !== 'string') return
        const surface = getSurface(action.surfaceId)
        const dataModel =
          (surface as { dataModel?: { data?: unknown } } | undefined)?.dataModel
            ?.data ?? {}
        void submitActionMessage(buildActionTurn(action, dataModel))
      } catch (error) {
        console.error('[a2ui] failed to forward surface action', error)
      }
    }
    return () => {
      actionHandlerRef.current = null
    }
  }, [getSurface, submitActionMessage, actionHandlerRef])

  return null
}

// The selected surface, portalled into the side pane's slot while the slot
// belongs to this session (F-1). The portal keeps the surface inside this
// session's providers, so its data model and actions stay where they are.
function A2uiPanePortal({ sessionId }: { sessionId: string }) {
  const slot = useSyncExternalStore(subscribeSlot, getSlot, () => null)
  const { paneSurfaceIds, selectedSurfaceId, openSurface, busy } =
    useA2uiPresentation()
  const t = useT()
  const shown = slot !== null && slot.sessionId === sessionId ? slot.element : null

  const filled = shown !== null && selectedSurfaceId !== null
  useEffect(() => {
    if (!filled) return
    setOwner(sessionId)
    return () => {
      if (getOwner() === sessionId) setOwner(null)
    }
  }, [filled, sessionId])

  if (!shown || !selectedSurfaceId) return null
  return createPortal(
    <div data-slot="a2ui-pane-content" className="flex h-full min-h-0 flex-col">
      {paneSurfaceIds.length > 1 && (
        <div
          role="tablist"
          aria-label={t('a2ui.surfaceTabs')}
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1"
        >
          {paneSurfaceIds.map(id => (
            <button
              key={id}
              type="button"
              role="tab"
              data-slot="a2ui-pane-tab"
              data-surface-id={id}
              aria-selected={id === selectedSurfaceId}
              onClick={() => openSurface(id)}
              className={
                'max-w-48 shrink-0 truncate rounded-md px-2 py-1 text-xs ' +
                (id === selectedSurfaceId
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')
              }
            >
              {id}
            </button>
          ))}
        </div>
      )}
      <div
        data-slot="a2ui-surface"
        data-surface-id={selectedSurfaceId}
        aria-busy={busy || undefined}
        className={
          'min-h-0 flex-1 overflow-auto p-3 transition-opacity' +
          (busy ? ' pointer-events-none select-none opacity-60' : '')
        }
      >
        <SurfaceErrorBoundary
          key={selectedSurfaceId}
          surfaceId={selectedSurfaceId}
          fallbackText={t('a2ui.renderFailed')}
        >
          <A2UIRenderer surfaceId={selectedSurfaceId} fallback={null} />
        </SurfaceErrorBoundary>
      </div>
    </div>,
    shown,
  )
}

export const A2uiProviderHost = memo(function A2uiProviderHost({
  sessionId,
  messages,
  submitActionMessage,
  busy,
  children,
}: {
  sessionId: string
  messages: readonly Message[]
  submitActionMessage?: (prompt: string) => Promise<void>
  busy: boolean
  children: ReactNode
}) {
  // Bridge: <A2UIProvider onAction> is fixed at mount (before getSurface
  // exists); the feeder installs the real handler into this ref.
  const actionHandlerRef = useRef<SurfaceActionHandler | null>(null)
  const onAction = useCallback((message: A2UIClientEventMessage) => {
    actionHandlerRef.current?.(message)
  }, [])

  return (
    <A2UIProvider onAction={onAction} catalog={vellocCatalog}>
      <A2uiPresentationProvider sessionId={sessionId} messages={messages} busy={busy}>
        <A2uiFeeder
          messages={messages}
          submitActionMessage={submitActionMessage}
          busy={busy}
          actionHandlerRef={actionHandlerRef}
        />
        {children}
        <A2uiPanePortal sessionId={sessionId} />
      </A2uiPresentationProvider>
    </A2UIProvider>
  )
})

export default A2uiProviderHost
