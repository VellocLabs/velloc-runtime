// Compiles A2UI Express blocks into v1.0 messages and checks them against a
// catalog (F-1). Heavy (the Express grammar): import it lazily.

import {
  A2uiGenerator,
  CatalogConfig,
  ExpressFormatFactory,
  RendererState,
  type A2uiRequestProcessor,
  type AgentToRendererMessage,
} from '@a2ui/agent'
import type { CatalogApi, ComponentApi } from '@a2ui/web_core/catalog'
import type { MessageProcessor } from '@a2ui/web_core/v1_0'
import { continueReusedSurfaces, createSurfaceLineFilter, type SurfaceExists } from './a2uiSurfaceLines'

export type A2uiCompileResult =
  | { ok: true; messages: AgentToRendererMessage[] }
  | { ok: false; message: string }

export type A2uiExpressCompiler = {
  /** A blank record of the surfaces earlier blocks made. */
  createState(): RendererState
  /** A record bound to a renderer: compiled messages are applied to it. */
  stateFor(renderer: MessageProcessor<ComponentApi>): RendererState
  /**
   * Compile one block body against `state`; on failure nothing is applied. A
   * bare `surface()` line for an existing surface updates it in place.
   */
  compile(body: string, state: RendererState): A2uiCompileResult
  /** Read one block body as it streams; each message is applied to `state` as it is read. */
  stream(state: RendererState): A2uiBlockStream
}

/** A block read chunk by chunk. After a failure it reads nothing more. */
export type A2uiBlockStream = {
  feed(chunk: string): A2uiStreamResult
  /** The block ended: checks what is left, as a whole block is checked. */
  close(): A2uiStreamResult
}

export type A2uiStreamResult =
  | { ok: true; messages: AgentToRendererMessage[] }
  | { ok: false; messages: AgentToRendererMessage[]; message: string }

function partMessages(parts: readonly { type: string; a2ui?: unknown }[]): AgentToRendererMessage[] {
  return parts.flatMap(part => (part.type === 'a2ui' ? (part.a2ui as AgentToRendererMessage[]) : []))
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+-\s+Help: Please correct the syntax error in your Express DSL\.?$/, '')
}

function existsIn(state: RendererState): SurfaceExists {
  return surfaceId => state.getSurface(surfaceId) !== undefined
}

export function createA2uiExpressCompiler(catalog: CatalogApi): A2uiExpressCompiler {
  const generator = new A2uiGenerator([new CatalogConfig(catalog)], undefined, new ExpressFormatFactory())
  const processor: A2uiRequestProcessor = generator.createProcessor({
    '1.0': { supportedCatalogIds: [catalog.id] },
  } as never)
  return {
    createState: () => processor.createState(),
    stateFor: renderer => RendererState.of(renderer),
    compile(body, state) {
      try {
        const source = continueReusedSurfaces(body, existsIn(state))
        const parts = processor.parseResponse(source, { wrapped: false, state })
        return { ok: true, messages: partMessages(parts) }
      } catch (error) {
        return { ok: false, message: errorText(error) }
      }
    },
    stream(state) {
      const stream = processor.openStream({ wrapped: false, state } as never)
      const lines = createSurfaceLineFilter(existsIn(state))
      let failed = false
      const read = (step: () => { type: string; a2ui?: unknown }[]): A2uiStreamResult => {
        if (failed) return { ok: false, messages: [], message: 'stopped' }
        try {
          return { ok: true, messages: partMessages(step()) }
        } catch (error) {
          failed = true
          const partial = (error as { partialResults?: { type: string; a2ui?: unknown }[] }).partialResults ?? []
          return { ok: false, messages: partMessages(partial), message: errorText(error) }
        }
      }
      return {
        feed: chunk => read(() => {
          const text = lines.push(chunk)
          return text ? stream.feed(text) : []
        }),
        close: () => read(() => {
          const rest = lines.flush()
          return [...(rest ? stream.feed(rest) : []), ...stream.close()]
        }),
      }
    },
  }
}
