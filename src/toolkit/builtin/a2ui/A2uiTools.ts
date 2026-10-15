import type { ToolContract, ToolContractList, InputCheck } from '../../toolContract'
import { declareTool } from '../../toolContract'
import {
  A2UI_CREATE_SURFACE,
  A2UI_DELETE_SURFACE,
  A2UI_SKILL_NAME,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
} from './a2uiToolNames'

// ── input shapes (the internal A2UI dialect the guest reducer reads) ──────
//
// A surface is a flat adjacency list of components keyed by `id`, plus a
// separate `dataModel` addressed by JSON Pointer (RFC 6901). Exactly one
// component's id equals `root`. Component `props` carry literals, data
// bindings (`{"path":"/ptr"}`), `action`, and `checks`. These tools are
// COMMANDS: `call()` only acks; the surface is rendered guest-side by the
// reducer reading the tool-call args from the transcript (see F-1).

export type A2uiComponentNode = {
  id: string
  component: string
  children?: string[]
  props?: Record<string, unknown>
}

export type A2uiCreateSurfaceInput = {
  surfaceId?: string
  catalogId?: string
  root?: string
  components?: A2uiComponentNode[]
  dataModel?: Record<string, unknown>
  theme?: Record<string, unknown>
}

export type A2uiUpdateComponentsInput = {
  surfaceId?: string
  components?: A2uiComponentNode[]
  removeIds?: string[]
  root?: string
}

export type A2uiDataModelPatch = { pointer: string; value: unknown }

export type A2uiUpdateDataModelInput = {
  surfaceId?: string
  patches?: A2uiDataModelPatch[]
  merge?: Record<string, unknown>
}

export type A2uiDeleteSurfaceInput = {
  surfaceId?: string
}

// ── shared JSON Schema fragments ──────────────────────────────────────────
// Nested schema values are typed `unknown` by ToolInputJSONSchema (only the
// top-level `type:'object'` is required), so plain object fragments suffice.

// Canonical A2UI v0.9 component: `component` + `id`, with type-specific
// properties FLAT on the object (e.g. text, label, value, action, checks),
// `child` (single) or `children` (string[] or {componentId,path} template).
const COMPONENT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    component: {
      type: 'string',
      description:
        'Catalog component type: Text, Image, Icon, Row, Column, List, Card, Button, TextField, CheckBox, Divider, ChoicePicker, Slider, Tabs, Modal, DateTimeInput, Video, AudioPlayer.',
    },
    id: {
      type: 'string',
      description: 'Unique id within the surface. Use id "root" for the root component.',
    },
    children: {
      description:
        'Child ids: a string[] of component ids, OR a {"componentId":"<tmplId>","path":"/array"} template rendered once per array element.',
    },
    child: {
      type: 'string',
      description: 'A single child component id (single-child containers like Card).',
    },
  },
  required: ['component'],
  // Type-specific props are FLAT on the object (NOT nested under "props"):
  // text, label, value:{"path":"/p"}, action:{"event":{"name":"x"}},
  // checks:[{"condition":{"call":"required","args":{"value":{"path":"/p"}}},"message":"…"}].
  additionalProperties: true,
}

function requireSurfaceId(surfaceId: unknown): InputCheck | null {
  if (typeof surfaceId !== 'string' || surfaceId.trim().length === 0) {
    return {
      result: false,
      message: 'surfaceId must be a non-empty string.',
      errorCode: 1,
    }
  }
  return null
}

// ── a2ui_create_surface ───────────────────────────────────────────────────

export const A2uiCreateSurfaceTool: ToolContract<A2uiCreateSurfaceInput, string> =
  declareTool({
    name: A2UI_CREATE_SURFACE,
    skill: A2UI_SKILL_NAME,
    discoveryHint: 'render a rich interactive UI surface (A2UI)',
    argsSchema: {
      type: 'object',
      properties: {
        surfaceId: {
          type: 'string',
          description:
            'Stable surface id. Reuse the SAME id on later a2ui_update_* calls to evolve this surface in place; use a NEW id for a separate surface.',
        },
        catalogId: { type: 'string', description: 'Optional catalog id.' },
        root: {
          type: 'string',
          description: 'id of the root component (must equal one component id).',
        },
        components: {
          type: 'array',
          description:
            'Flat adjacency list; containers reference children by id. Exactly one component id equals `root`.',
          items: COMPONENT_ITEM_SCHEMA,
        },
        dataModel: {
          type: 'object',
          additionalProperties: true,
          description:
            'Initial data model, addressed by JSON Pointer (RFC 6901) from component bindings.',
        },
        theme: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional theme (e.g. primaryColor).',
        },
      },
      required: ['surfaceId', 'components'],
    },
    inputExamples: [
      {
        surfaceId: 'greeting',
        components: [
          { id: 'root', component: 'Card', child: 'col' },
          { id: 'col', component: 'Column', children: ['title', 'name', 'save'] },
          { id: 'title', component: 'Text', text: 'What is your name?' },
          { id: 'name', component: 'TextField', value: { path: '/form/name' }, label: 'Name' },
          {
            id: 'save',
            component: 'Button',
            // Button label is a CHILD Text component (the catalog Button has no
            // `label` prop), referenced by id — never defined inline.
            child: 'saveLabel',
            action: { event: { name: 'save_name' } },
          },
          { id: 'saveLabel', component: 'Text', text: 'Save' },
        ],
        dataModel: { form: { name: '' } },
      },
    ],
    description: async () =>
      'Create (or replace) an A2UI surface: a declarative component tree + data model rendered as native interactive UI in a pinned panel. Components are a flat adjacency list keyed by id with a single `root`. Reuse the same surfaceId on later updates to evolve it in place.',
    readsOnly: () => true,
    parallelSafe: () => true,
    async checkInput(input: A2uiCreateSurfaceInput): Promise<InputCheck> {
      const bad = requireSurfaceId(input.surfaceId)
      if (bad) return bad
      if (!Array.isArray(input.components) || input.components.length === 0) {
        return { result: false, message: 'components must be a non-empty array.', errorCode: 3 }
      }
      return { result: true }
    },
    call: async (input: A2uiCreateSurfaceInput) => ({
      data: `A2UI surface "${input.surfaceId}" created.`,
    }),
  })

// ── a2ui_update_components ──────────────────────────────────────────────────

export const A2uiUpdateComponentsTool: ToolContract<A2uiUpdateComponentsInput, string> =
  declareTool({
    name: A2UI_UPDATE_COMPONENTS,
    skill: A2UI_SKILL_NAME,
    discoveryHint: 'update components of an existing A2UI surface',
    argsSchema: {
      type: 'object',
      properties: {
        surfaceId: {
          type: 'string',
          description: 'id of the surface to update (must already exist).',
        },
        components: {
          type: 'array',
          description: 'Components to upsert (merged by id).',
          items: COMPONENT_ITEM_SCHEMA,
        },
        removeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Component ids to remove.',
        },
        root: { type: 'string', description: 'Optionally re-point the root id.' },
      },
      required: ['surfaceId'],
    },
    description: async () =>
      'Update an existing A2UI surface in place: upsert `components` (merged by id), `removeIds` to delete, optionally re-point `root`. Untouched components persist.',
    readsOnly: () => true,
    parallelSafe: () => true,
    async checkInput(
      input: A2uiUpdateComponentsInput,
    ): Promise<InputCheck> {
      return requireSurfaceId(input.surfaceId) ?? { result: true }
    },
    call: async (input: A2uiUpdateComponentsInput) => ({
      data: `A2UI surface "${input.surfaceId}" components updated.`,
    }),
  })

// ── a2ui_update_data_model ──────────────────────────────────────────────────

export const A2uiUpdateDataModelTool: ToolContract<A2uiUpdateDataModelInput, string> =
  declareTool({
    name: A2UI_UPDATE_DATA_MODEL,
    skill: A2UI_SKILL_NAME,
    discoveryHint: 'update the data model of an A2UI surface',
    argsSchema: {
      type: 'object',
      properties: {
        surfaceId: {
          type: 'string',
          description: 'id of the surface whose data model to update.',
        },
        patches: {
          type: 'array',
          description: 'JSON-Pointer patches applied in order (last-writer-wins per pointer).',
          items: {
            type: 'object',
            properties: {
              pointer: {
                type: 'string',
                description: 'RFC 6901 JSON Pointer, e.g. "/form/name".',
              },
              value: { description: 'Any JSON value to set at the pointer.' },
            },
            required: ['pointer', 'value'],
            additionalProperties: false,
          },
        },
        merge: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional shallow object to merge into the data-model root.',
        },
      },
      required: ['surfaceId'],
    },
    inputExamples: [
      {
        surfaceId: 'greeting',
        patches: [{ pointer: '/form/name', value: 'Ada' }],
      },
    ],
    description: async () =>
      'Update an A2UI surface data model: apply JSON-Pointer `patches` (and/or a shallow `merge`). Bound widgets re-render; component structure is unchanged.',
    readsOnly: () => true,
    parallelSafe: () => true,
    async checkInput(
      input: A2uiUpdateDataModelInput,
    ): Promise<InputCheck> {
      return requireSurfaceId(input.surfaceId) ?? { result: true }
    },
    call: async (input: A2uiUpdateDataModelInput) => ({
      data: `A2UI surface "${input.surfaceId}" data model updated.`,
    }),
  })

// ── a2ui_delete_surface ─────────────────────────────────────────────────────

export const A2uiDeleteSurfaceTool: ToolContract<A2uiDeleteSurfaceInput, string> =
  declareTool({
    name: A2UI_DELETE_SURFACE,
    skill: A2UI_SKILL_NAME,
    discoveryHint: 'remove an A2UI surface',
    argsSchema: {
      type: 'object',
      properties: {
        surfaceId: { type: 'string', description: 'id of the surface to remove.' },
      },
      required: ['surfaceId'],
    },
    description: async () =>
      'Remove an A2UI surface from the panel. Permanent for this conversation; later updates to the same id are ignored.',
    readsOnly: () => true,
    parallelSafe: () => true,
    async checkInput(
      input: A2uiDeleteSurfaceInput,
    ): Promise<InputCheck> {
      return requireSurfaceId(input.surfaceId) ?? { result: true }
    },
    call: async (input: A2uiDeleteSurfaceInput) => ({
      data: `A2UI surface "${input.surfaceId}" deleted.`,
    }),
  })

/** All four A2UI command tools, for registration in `src/toolkit/toolRegistry.ts`. */
export const A2UI_TOOLS: ToolContractList = [
  A2uiCreateSurfaceTool,
  A2uiUpdateComponentsTool,
  A2uiUpdateDataModelTool,
  A2uiDeleteSurfaceTool,
]

export {
  A2UI_CREATE_SURFACE,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
  A2UI_DELETE_SURFACE,
  A2UI_SKILL_NAME,
  A2UI_TOOL_NAMES,
} from './a2uiToolNames'
