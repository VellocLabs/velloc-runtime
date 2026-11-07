// Stands in for @a2ui/agent's single web_core import module (F-1). The same
// names, but the v0.9 and v1.0 schemas come from their own files rather than
// the version entry points, which also load the Lit renderer and need a DOM.
// The SharedWorker compiles Express blocks and has no DOM.

export { Catalog } from '@a2ui/web_core/catalog'
export { Schemas as V08Schemas } from '@a2ui/web_core/v0_8'
export {
  CreateSurfaceMessageSchema as V09CreateSurfaceMessageSchema,
  UpdateComponentsMessageSchema as V09UpdateComponentsMessageSchema,
  UpdateDataModelMessageSchema as V09UpdateDataModelMessageSchema,
  DeleteSurfaceMessageSchema as V09DeleteSurfaceMessageSchema,
} from '../node_modules/@a2ui/web_core/src/v0_9/schema/index.js'
export { V09_STANDARD_DEFS } from '../node_modules/@a2ui/web_core/src/v0_9/standard_defs.js'
export {
  CreateSurfaceMessageSchema as V10CreateSurfaceMessageSchema,
  UpdateComponentsMessageSchema as V10UpdateComponentsMessageSchema,
  UpdateDataModelMessageSchema as V10UpdateDataModelMessageSchema,
  DeleteSurfaceMessageSchema as V10DeleteSurfaceMessageSchema,
  CallRendererFunctionMessageSchema as V10CallRendererFunctionMessageSchema,
  AgentFunctionResponseMessageSchema as V10AgentFunctionResponseMessageSchema,
  AgentToRendererMessageSchema,
  RendererToAgentMessageSchema,
  V10RendererCapabilitiesSchema,
} from '../node_modules/@a2ui/web_core/src/v1_0/schema/index.js'
export { V10_STANDARD_DEFS } from '../node_modules/@a2ui/web_core/src/v1_0/standard_defs.js'
export {
  validateRecursionAndPaths,
  STRICT_VALIDATION,
  getComponentReferences,
  buildComponentRefMap,
  isValidUax31Identifier,
  V10_CHILD_REF_OPTIONS,
} from '@a2ui/web_core/validating'
export { ComponentModel, DataModel, SurfaceModel } from '@a2ui/web_core/state'
export { MessageProcessor } from '@a2ui/web_core/processing'
export {
  A2uiCatalogError,
  A2uiError,
  A2uiValidationError,
  A2uiDataError,
  A2uiExpressionError,
  A2uiStateError,
  A2uiIntegrityError,
  A2uiRecursionError,
} from '@a2ui/web_core/errors'
export { compareSemVer, isAtLeastVersion, normalizeVersionString } from '@a2ui/web_core/semver'

import V09MessageSchemaRaw from '../node_modules/@a2ui/web_core/src/v0_9/schemas/server_to_client.json' with { type: 'json' }
import V10MessageSchemaRaw from '../node_modules/@a2ui/web_core/src/v1_0/schemas/agent_to_renderer.json' with { type: 'json' }

export const V09Schemas = { A2uiMessageSchemaRaw: V09MessageSchemaRaw }
export const V10Schemas = { A2uiMessageSchemaRaw: V10MessageSchemaRaw }
