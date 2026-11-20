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

/** Properties holding a list of objects whose fields name child components. */
const CHILD_LISTS: ReadonlyArray<readonly [component: string, property: string]> = [
  ['Tabs', 'tabs'],
  ['Accordion', 'items'],
]

type Schema = { type?: string; items?: Schema; anyOf?: Schema[]; description?: string }

/**
 * The description with each child list offered as a plain list of objects.
 * The compiler finds child ids only in that shape; offered as a list, a
 * binding or a function, a Tabs panel or Accordion body counts as orphaned.
 */
export function narrowChildLists(catalogDescription: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(catalogDescription) as { components?: Record<string, { properties?: Record<string, Schema> }> }
  for (const [component, property] of CHILD_LISTS) {
    const properties = copy.components?.[component]?.properties
    const schema = properties?.[property]
    const list = schema?.type === 'array' ? schema : schema?.anyOf?.find(alt => alt.type === 'array')
    const item = list?.items?.type === 'object' ? list.items : list?.items?.anyOf?.find(alt => alt.type === 'object')
    if (!properties || !schema || !item) continue
    properties[property] = { type: 'array', items: item, ...(schema.description ? { description: schema.description } : {}) }
  }
  return copy as Record<string, unknown>
}

export function createStudioExpressCompiler(catalogDescription: Record<string, unknown>): StudioExpressCompiler {
  const config = new CatalogConfig(new InMemoryCatalogProvider(narrowChildLists(catalogDescription)).load())
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
