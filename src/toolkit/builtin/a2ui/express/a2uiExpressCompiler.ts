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

export type A2uiCompileResult =
  | { ok: true; messages: AgentToRendererMessage[] }
  | { ok: false; message: string }

export type A2uiExpressCompiler = {
  /** A blank record of the surfaces earlier blocks made. */
  createState(): RendererState
  /** A record bound to a renderer: compiled messages are applied to it. */
  stateFor(renderer: MessageProcessor<ComponentApi>): RendererState
  /** Compile one block body against `state`; on failure nothing is applied. */
  compile(body: string, state: RendererState): A2uiCompileResult
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+-\s+Help: Please correct the syntax error in your Express DSL\.?$/, '')
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
        const parts = processor.parseResponse(body, { wrapped: false, state })
        const messages = parts.flatMap(part => (part.type === 'a2ui' ? part.a2ui : []))
        return { ok: true, messages }
      } catch (error) {
        return { ok: false, message: errorText(error) }
      }
    },
  }
}
