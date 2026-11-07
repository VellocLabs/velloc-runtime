// Translator: our transcript `a2ui_*` command tool-calls → canonical A2UI v1.0
// server-to-client messages, fed to the upstream `MessageProcessor`. Our tools
// now emit canonical component shapes (flat props, {path} bindings,
// children:string[]|{componentId,path}, action:{event}, checks:[{condition}]),
// so translation is just enveloping — no per-prop mapping.

import type { Message } from '../../../runtime/RuntimeTypes'
import { extractA2uiCommands } from './surfaceStore'
import {
  A2UI_CREATE_SURFACE,
  A2UI_DELETE_SURFACE,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
} from '../../../toolkit/builtin/a2ui/a2uiToolNames'

/** Canonical v1.0 message (shape validated by the upstream processor). */
export type A2uiMessage = Record<string, unknown>

/** The protocol version every emitted message carries. */
export const A2UI_PROTOCOL_VERSION = '1.0'

// Normalize ANY model dialect → valid canonical A2UI, so the upstream renderer
// is never fed malformed input (the cause of the render-loop → renderer crash).
// Handles the variations real models emit and the legacy custom-renderer
// dialect: bare-string pointer bindings → {path}; a `props` bag → flat props;
// {$fn,args} expressions → {call,args}; and old List `items`+`template` → a
// canonical `children:{componentId,path}` template.

/**
 * Recursively normalize a value to v1.0: a bare "/..." string or a `{path}`
 * object → `{"@path"}`; `{call}` / `{$fn}` → `{"@call"}`. v1.0 reads only the
 * `@`-prefixed forms as a binding or a function call.
 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.startsWith('/') ? { '@path': value } : value
  }
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record['@path'] === 'string') return record
    if (typeof record.path === 'string' && !('componentId' in record)) {
      return { '@path': record.path }
    }
    const call =
      typeof record['@call'] === 'string'
        ? record['@call']
        : typeof record.call === 'string'
          ? record.call
          : typeof record.$fn === 'string'
            ? record.$fn
            : null
    if (call !== null) {
      const out: Record<string, unknown> = { '@call': call }
      for (const [key, nested] of Object.entries(record)) {
        if (key === 'call' || key === '@call' || key === '$fn') continue
        out[key] = normalizeValue(nested)
      }
      if (!('args' in out)) out.args = {}
      return out
    }
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(record)) out[key] = normalizeValue(nested)
    return out
  }
  return value
}

// Props that carry human-readable display text or a URL — never a data binding.
// A bare string here is ALWAYS a literal, even one that starts with "/" (a file
// path mentioned in a label, or a relative image URL like "/assets/logo.png").
// Without this guard `normalizeValue` would mis-wrap such a string into a
// `{path}` binding, which the renderer resolves to undefined and shows blank.
// Binding props (`value`, `checked`, …) are deliberately NOT listed, so a
// bare-string binding still coerces to `{path}` (the render-loop fix).
const LITERAL_DISPLAY_KEYS = new Set([
  'text',
  'title',
  'header',
  'heading',
  'label',
  'placeholder',
  'alt',
  'description',
  'caption',
  'userMessage',
  'url',
  'src',
  'delta',
])

// Props that carry literal chart/table data. An inline array is data, never a
// binding, so strings inside its rows ("/pricing", "/src/a.ts") stay literal;
// a bare string or {path} still binds the whole prop.
const LITERAL_DATA_KEYS = new Set(['data', 'rows', 'columns', 'series'])

function normalizeComponent(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const record: Record<string, unknown> = { ...(node as Record<string, unknown>) }

  // 1. Flatten a legacy `props` bag onto the component (canonical is flat).
  const props = record.props
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      if (!(key in record)) record[key] = value
    }
    delete record.props
  }

  // 2. Legacy List template (items + string template) → canonical children.
  if (typeof record.template === 'string' && record.items != null) {
    const items = record.items
    const path =
      typeof items === 'string'
        ? items
        : items && typeof items === 'object' && typeof (items as Record<string, unknown>).path === 'string'
          ? ((items as Record<string, unknown>).path as string)
          : undefined
    if (path) {
      record.children = { componentId: record.template, path }
      delete record.template
      delete record.items
    }
  }

  // 3. Normalize each value prop (skip structural keys: ids/templates, not
  //    bindings — `template` may be an inline component object hoisted below).
  for (const key of Object.keys(record)) {
    if (
      key === 'id' ||
      key === 'component' ||
      key === 'child' ||
      key === 'children' ||
      key === 'template'
    ) {
      continue
    }
    const value = record[key]
    // A bare-string display/URL prop is a literal even when it starts with "/" —
    // don't coerce it to a {path} binding. Objects/arrays (e.g. text:{$fn,…} or
    // an explicit {path}) still normalize.
    if (LITERAL_DISPLAY_KEYS.has(key) && typeof value === 'string') continue
    if (LITERAL_DATA_KEYS.has(key) && Array.isArray(value)) continue
    record[key] = normalizeValue(value)
  }
  return mapEarlierProps(record)
}

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5 }

// Props the earlier basic catalog had and v1.0 renamed or dropped. The v1.0
// catalog validates strictly, so an unknown prop would drop the component.
function mapEarlierProps(record: Record<string, unknown>): Record<string, unknown> {
  if (record.component === 'Text' && typeof record.variant === 'string' && record.variant in HEADING_LEVEL) {
    // v1.0 Text has only caption/body; a heading is Markdown in the text.
    if (typeof record.text === 'string') {
      record.text = `${'#'.repeat(HEADING_LEVEL[record.variant])} ${record.text}`
    }
    delete record.variant
  }
  if (record.component === 'Image' && 'alt' in record) {
    if (!('description' in record)) record.description = record.alt
    delete record.alt
  }
  if (record.component === 'Slider' && 'step' in record) delete record.step
  // v1.0 Button requires an action; an inert earlier Button sends an event named after it.
  if (record.component === 'Button' && record.action == null) {
    record.action = { event: { name: typeof record.id === 'string' ? record.id : 'button' } }
  }
  if (record.component === 'CheckBox' && 'checked' in record) {
    if (!('value' in record)) record.value = record.checked
    delete record.checked
  }
  return record
}

/** Pull a JSON-pointer string out of an `items` binding (string or {path}). */
function itemsPath(items: unknown): string | undefined {
  if (typeof items === 'string') return items
  if (items && typeof items === 'object') {
    const record = items as Record<string, unknown>
    if (typeof record['@path'] === 'string') return record['@path']
    if (typeof record.path === 'string') return record.path
  }
  return undefined
}

// The upstream renderer treats the component with id "root" as the surface
// root. Models often name the root differently and pass it via the tool's
// `root` field (which the upstream ignores) — rename that component, and
// references to it, to "root".
function remapRootId(components: unknown[], rootId: string | undefined): unknown[] {
  if (!rootId || rootId === 'root') return components
  const rename = (id: unknown) => (id === rootId ? 'root' : id)
  return components.map(component => {
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      return component
    }
    const record = { ...(component as Record<string, unknown>) }
    if (record.id === rootId) record.id = 'root'
    if (record.child === rootId) record.child = 'root'
    if (Array.isArray(record.children)) record.children = record.children.map(rename)
    return record
  })
}

function normalizeComponents(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  const out: unknown[] = []
  for (const raw of value) {
    const node = normalizeComponent(raw)
    // Legacy List dialect: `items` + an INLINE-OBJECT `template`. The upstream
    // renderer expects a child-template `children:{componentId,path}` that
    // references a component by id (so per-item RELATIVE bindings like
    // {"path":"title"} resolve within each element). Hoist the inline template
    // into its own component and rewrite the container's children.
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const record = node as Record<string, unknown>
      const template = record.template
      const path = itemsPath(record.items)
      if (template && typeof template === 'object' && !Array.isArray(template) && path) {
        const templateRecord = template as Record<string, unknown>
        const templateId =
          typeof templateRecord.id === 'string' && templateRecord.id
            ? templateRecord.id
            : `${typeof record.id === 'string' ? record.id : 'list'}__tmpl`
        record.children = { componentId: templateId, path }
        delete record.template
        delete record.items
        out.push(node)
        out.push(normalizeComponent({ ...templateRecord, id: templateId }))
        continue
      }
      // v1.0 Button draws a child component; an inline `label` becomes a Text child.
      if (record.component === 'Button' && record.child == null && record.label != null) {
        const labelId = `${typeof record.id === 'string' ? record.id : 'button'}__label`
        out.push(node)
        out.push({ id: labelId, component: 'Text', text: record.label })
        record.child = labelId
        delete record.label
        continue
      }
    }
    out.push(node)
  }
  return out
}

/** The props each catalog component accepts, by component name. */
export type CatalogPropNames = ReadonlyMap<string, ReadonlySet<string>>

const STRUCTURAL_KEYS = new Set(['id', 'component', 'accessibility', 'weight'])

// The v1.0 catalog validates strictly: a component with a prop its schema does
// not define is rejected, and a rejected root blanks the whole surface. Drop
// such props; components of unknown type pass through for the processor to report.
function stripUnknownProps(components: unknown[], propNames?: CatalogPropNames): unknown[] {
  if (!propNames) return components
  return components.map(component => {
    if (!component || typeof component !== 'object' || Array.isArray(component)) return component
    const record = component as Record<string, unknown>
    const allowed = typeof record.component === 'string' ? propNames.get(record.component) : undefined
    if (!allowed) return component
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (STRUCTURAL_KEYS.has(key) || allowed.has(key)) out[key] = value
    }
    return out
  })
}

export function commandsToA2uiMessages(
  commands: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
  catalogId: string,
  propNames?: CatalogPropNames,
): A2uiMessage[] {
  const out: A2uiMessage[] = []
  for (const { name, args } of commands) {
    const surfaceId = typeof args.surfaceId === 'string' ? args.surfaceId : null
    if (!surfaceId) continue

    if (name === A2UI_CREATE_SURFACE) {
      // Always use the registered catalog's id — a mismatched catalogId makes
      // the upstream processor throw "Catalog not found".
      out.push({
        version: A2UI_PROTOCOL_VERSION,
        createSurface: { surfaceId, catalogId, sendDataModel: true },
      })
      if (Array.isArray(args.components)) {
        out.push({
          version: A2UI_PROTOCOL_VERSION,
          updateComponents: {
            surfaceId,
            components: stripUnknownProps(
              remapRootId(
                normalizeComponents(args.components),
                typeof args.root === 'string' ? args.root : undefined,
              ),
              propNames,
            ),
          },
        })
      }
      if (args.dataModel && typeof args.dataModel === 'object') {
        out.push({
          version: A2UI_PROTOCOL_VERSION,
          updateDataModel: { surfaceId, value: args.dataModel },
        })
      }
    } else if (name === A2UI_UPDATE_COMPONENTS) {
      out.push({
        version: A2UI_PROTOCOL_VERSION,
        updateComponents: {
          surfaceId,
          components: stripUnknownProps(normalizeComponents(args.components), propNames),
        },
      })
    } else if (name === A2UI_UPDATE_DATA_MODEL) {
      // Batch form: the tool advertises `patches: [{pointer, value}]`. Each
      // patch becomes a canonical single-pointer updateDataModel message (the
      // shape web_core applies). Without this, a model that followed the tool
      // schema and sent `patches` would no-op.
      if (Array.isArray(args.patches)) {
        for (const patch of args.patches) {
          if (!patch || typeof patch !== 'object') continue
          const record = patch as { pointer?: unknown; value?: unknown }
          if (typeof record.pointer === 'string' && 'value' in record) {
            out.push({
              version: A2UI_PROTOCOL_VERSION,
              updateDataModel: {
                surfaceId,
                path: record.pointer,
                value: record.value ?? null,
              },
            })
          }
        }
      }
      // Single path/value (canonical). Emitted only when present so an empty
      // call is a no-op.
      // A write always carries `value` (v1.0); `null` removes the key.
      if ('value' in args) {
        const updateDataModel: Record<string, unknown> = { surfaceId, value: args.value ?? null }
        if (typeof args.path === 'string') updateDataModel.path = args.path
        out.push({ version: A2UI_PROTOCOL_VERSION, updateDataModel })
      }
      // Shallow `merge` (back-compat): expand into one single-pointer write per
      // top-level key so untouched fields survive. A PATHLESS updateDataModel
      // REPLACES the entire data-model root in web_core (`set('/', value)`), so
      // emitting `{value: merge}` would wipe every other field — the bug this
      // avoids. Keys are RFC-6901 escaped so a "/" or "~" in a key stays a
      // single top-level field instead of a nested path.
      const merge =
        args.merge && typeof args.merge === 'object' && !Array.isArray(args.merge)
          ? (args.merge as Record<string, unknown>)
          : null
      if (merge) {
        for (const [key, value] of Object.entries(merge)) {
          if (key === '') continue // path "/" would replace the whole root
          const pointer = `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
          out.push({
            version: A2UI_PROTOCOL_VERSION,
            updateDataModel: { surfaceId, path: pointer, value: value ?? null },
          })
        }
      }
    } else if (name === A2UI_DELETE_SURFACE) {
      out.push({ version: A2UI_PROTOCOL_VERSION, deleteSurface: { surfaceId } })
    }
  }
  return out
}

export function messagesToA2ui(
  messages: readonly Message[],
  catalogId: string,
  propNames?: CatalogPropNames,
): A2uiMessage[] {
  return commandsToA2uiMessages(extractA2uiCommands(messages), catalogId, propNames)
}
