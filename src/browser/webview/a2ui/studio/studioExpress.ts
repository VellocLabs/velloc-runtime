// Compiles A2UI Express against the studio catalog's exported description
// (F-1). The description is plain JSON, so this needs no renderer and no DOM.

import {
  A2uiGenerator,
  CatalogConfig,
  ExpressFormatFactory,
  InMemoryCatalogProvider,
  type AgentToRendererMessage,
} from '@a2ui/agent'

export type StudioCompileResult =
  | { ok: true; messages: AgentToRendererMessage[] }
  | { ok: false; message: string }

export type StudioExpressCompiler = {
  /** Compile one Express body that names its surface with `surface("id")`. */
  compile(body: string): StudioCompileResult
}

export function createStudioExpressCompiler(catalogDescription: Record<string, unknown>): StudioExpressCompiler {
  const config = new CatalogConfig(new InMemoryCatalogProvider(catalogDescription).load())
  const generator = new A2uiGenerator([config], undefined, new ExpressFormatFactory())
  const processor = generator.createProcessor({
    '1.0': { supportedCatalogIds: [String(catalogDescription.catalogId)] },
  } as never)
  return {
    compile(body) {
      try {
        const parts = processor.parseResponse(body, { wrapped: false, state: processor.createState() })
        return {
          ok: true,
          messages: parts.flatMap(part => (part.type === 'a2ui' ? (part.a2ui as AgentToRendererMessage[]) : [])),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
