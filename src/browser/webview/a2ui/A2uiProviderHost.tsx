// Lazy host wrapping the conversation with the shared A2UI runtime: one per-session
// MessageProcessor, the transcript feeder, the action loop, the presentation context
// the streaming-block reader and the side pane portal. Loaded only when a
// conversation has an A2UI source.

import {
  Component,
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { A2uiSurface, type ReactCatalogComponent } from '@a2ui/react'
import { MessageProcessor, type ActionPayload } from '@a2ui/web_core/v1_0'
import { injectBasicCatalogStyles, setMarkdownRenderer } from '@a2ui/web_core/catalogs/basic/v1'
// The basic catalog's Icon relies on the Material Symbols font's ligatures;
// self-host it here (the lazy host) so the woff2 lands in the A2UI chunk.
import '@material-symbols/font-400/outlined.css'
// Maps the basic catalog's --a2ui-* variables onto the Velloc theme.
import './a2ui-surface.css'
import type { Message } from '../../../runtime/RuntimeTypes'
import { extractA2uiSources } from './surfaceStore'
import { A2UI_PROTOCOL_VERSION, commandsToA2uiMessages } from './toA2uiMessages'
import {
  createA2uiExpressCompiler,
  type A2uiExpressCompiler,
} from '../../../toolkit/builtin/a2ui/express/a2uiExpressCompiler'
import { a2uiBlockKey } from '../../../toolkit/builtin/a2ui/express/a2uiBlocks'
import { setA2uiBlockError } from './a2uiBlockErrors'
import { createA2uiLiveBlocks, type A2uiLiveBlocks } from './a2uiLiveBlock'
import { A2uiLiveContext } from './a2uiLiveContext'
import { vellocCatalog, vellocCatalogPropNames } from './catalog/vellocCatalog'
import {
  A2uiPresentationProvider,
  useA2uiPresentation,
} from './A2uiPresentationContext'
import { useT } from '../i18n'
import { getOwner, getSlot, setOwner, subscribeSlot } from './a2uiPaneBus'

type SurfaceActionHandler = (action: ActionPayload) => void
type VellocProcessor = MessageProcessor<ReactCatalogComponent>

const ProcessorContext = createContext<VellocProcessor | null>(null)

// Text renders simple Markdown. Security: the renderer sanitises its HTML
// (DOMPurify); it loads as its own chunk on the first Text drawn.
setMarkdownRenderer((value, options) =>
  import('@a2ui/markdown-it').then(module => module.renderMarkdown(value, options)),
)

const ACTION_PROMPT_PREFIX =
  'The user acted on an A2UI surface you drew (for example, clicked a button). ' +
  'Answer by writing an <a2ui> block that targets the same surface — ' +
  'surface("<surfaceId>") — to change it in place (assign data with ' +
  '$/path = value, or redefine components), or reply briefly in chat if that ' +
  'fits better. Do not narrate this event. The action and the surface’s ' +
  'current data model:'

export function buildActionTurn(action: ActionPayload, dataModel: unknown): string {
  const payload: Record<string, unknown> = {
    surfaceId: action.surfaceId ?? null,
    action: action.name ?? 'unknown',
    sourceComponentId: action.sourceComponentId ?? null,
    context: action.context ?? null,
    dataModel: dataModel ?? {},
  }
  if (typeof action.userMessage === 'string' && action.userMessage) {
    payload.userMessage = action.userMessage
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

// Feeds new transcript sources (blocks and older tool calls) into the session's processor and installs the
// surface-action handler (which snapshots the live data model).
function A2uiFeeder({
  messages,
  submitActionMessage,
  busy,
  actionHandlerRef,
  compiler,
  live,
}: {
  compiler: A2uiExpressCompiler
  live: A2uiLiveBlocks
  messages: readonly Message[]
  submitActionMessage?: (prompt: string) => Promise<void>
  busy: boolean
  actionHandlerRef: React.MutableRefObject<SurfaceActionHandler | null>
}) {
  const processor = useA2uiProcessor()
  const sources = useMemo(() => extractA2uiSources(messages), [messages])
  const state = useMemo(() => compiler.stateFor(processor), [compiler, processor])
  const processedRef = useRef(0)
  const busyRef = useRef(busy)
  busyRef.current = busy

  // Feed only NEW sources each time, one at a time, so one bad source cannot
  // abort the rest. A block that fails leaves the renderer as it was.
  useEffect(() => {
    if (sources.length <= processedRef.current) return
    const fresh = sources.slice(processedRef.current)
    processedRef.current = sources.length
    for (const source of fresh) {
      if (source.kind === 'block') {
        const { body, targets } = source.block
        const key = a2uiBlockKey(targets[0] ?? '', body)
        // A block that streamed is already drawn; the stored copy completes it.
        const streamed = targets[0] ? live.finish(targets[0], body) : { kind: 'not-streamed' as const }
        if (streamed.kind === 'drawn') {
          setA2uiBlockError(key, null)
          continue
        }
        if (streamed.kind === 'failed' && streamed.created && targets[0]) {
          // Compile it as if it had not streamed, so the error is the block's own.
          processor.processMessages({ version: A2UI_PROTOCOL_VERSION, deleteSurface: { surfaceId: targets[0] } } as never)
        }
        const result = compiler.compile(body, state)
        setA2uiBlockError(key, result.ok ? null : result.message)
        if (!result.ok) console.warn('[a2ui] block rejected', result.message)
        continue
      }
      for (const message of commandsToA2uiMessages([source.command], vellocCatalog.id, vellocCatalogPropNames)) {
        const id = (message as { createSurface?: { surfaceId?: unknown } }).createSurface?.surfaceId
        if (typeof id === 'string' && processor.getSurface(id)) continue
        try {
          processor.processMessages(message as Parameters<VellocProcessor['processMessages']>[0])
        } catch (error) {
          console.error('[a2ui] message rejected', error)
        }
      }
    }
  }, [sources, processor, compiler, state, live])

  // Forward surface actions to the model as a hidden isMeta turn (gated while a
  // turn is in flight — one action per turn).
  useEffect(() => {
    actionHandlerRef.current = (action: ActionPayload) => {
      try {
        if (!submitActionMessage || busyRef.current) return
        if (typeof action.surfaceId !== 'string') return
        const dataModel = processor.getSurface(action.surfaceId)?.dataModel.get('/') ?? {}
        void submitActionMessage(buildActionTurn(action, dataModel))
      } catch (error) {
        console.error('[a2ui] failed to forward surface action', error)
      }
    }
    return () => {
      actionHandlerRef.current = null
    }
  }, [processor, submitActionMessage, actionHandlerRef])

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
          <SelectedSurface surfaceId={selectedSurfaceId} />
        </SurfaceErrorBoundary>
      </div>
    </div>,
    shown,
  )
}

function useA2uiProcessor(): VellocProcessor {
  const processor = useContext(ProcessorContext)
  if (!processor) throw new Error('useA2uiProcessor must be used within A2uiProviderHost')
  return processor
}

// The surface model of `surfaceId`, kept current across create and delete.
function SelectedSurface({ surfaceId }: { surfaceId: string }) {
  const processor = useA2uiProcessor()
  const [, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    const created = processor.onSurfaceCreated(bump)
    const deleted = processor.onSurfaceDeleted(bump)
    return () => {
      created.unsubscribe()
      deleted.unsubscribe()
    }
  }, [processor])
  const surface = processor.getSurface(surfaceId)
  return surface ? <A2uiSurface key={surfaceId} surface={surface} /> : null
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
  // The processor's action listener is fixed at construction; the feeder
  // installs the real handler into this ref.
  const actionHandlerRef = useRef<SurfaceActionHandler | null>(null)
  const [processor] = useState<VellocProcessor>(
    () =>
      new MessageProcessor<ReactCatalogComponent>([vellocCatalog], action => {
        actionHandlerRef.current?.(action)
      }),
  )
  const [compiler] = useState(() => createA2uiExpressCompiler(vellocCatalog))
  const [live] = useState(() => {
    const state = compiler.stateFor(processor)
    return createA2uiLiveBlocks(() => compiler.stream(state))
  })
  useEffect(() => {
    injectBasicCatalogStyles()
    return () => processor.dispose()
  }, [processor])

  return (
    <ProcessorContext.Provider value={processor}>
      <A2uiLiveContext.Provider value={live}>
      <A2uiPresentationProvider sessionId={sessionId} messages={messages} busy={busy} live={live}>
        <A2uiFeeder
          compiler={compiler}
          live={live}
          messages={messages}
          submitActionMessage={submitActionMessage}
          busy={busy}
          actionHandlerRef={actionHandlerRef}
        />
        {children}
        <A2uiPanePortal sessionId={sessionId} />
      </A2uiPresentationProvider>
      </A2uiLiveContext.Provider>
    </ProcessorContext.Provider>
  )
})

export default A2uiProviderHost
