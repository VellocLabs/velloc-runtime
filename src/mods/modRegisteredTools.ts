/**
 * `$.tool.register` (F-25): an ordinary engine tool `mcp__<plugin>__<name>`,
 * permission-checked as an MCP tool and raised as `tool.call`; core fails ("a call
 * no hook answers fails"). Unloading the plugin takes its tools with it.
 */

import { declareTool, type ToolContract, type ToolArgsJsonShape } from '../toolkit/toolContract'

export const MOD_TOOL_NAME_PREFIX = 'mcp__'
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** What `$.tool.register` takes, checked: `inputSchema` filled in. */
export type ModToolSpec = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The checked spec: each refusal names the field. */
export function modToolSpecOf(value: unknown): ModToolSpec {
  if (!isRecord(value)) throw new TypeError('$.tool.register(tool): tool must be { name, description, inputSchema? }')
  const { name, description, inputSchema } = value
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new TypeError('$.tool.register: name must be letters, digits, "_" or "-", up to 64')
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new TypeError('$.tool.register: description must be a non-empty string')
  }
  if (inputSchema !== undefined && (!isRecord(inputSchema) || (inputSchema.type !== undefined && inputSchema.type !== 'object'))) {
    throw new TypeError('$.tool.register: inputSchema must be a JSON schema object of type "object"')
  }
  return {
    name,
    description: description.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, (half, lead: string) =>
      half.length === 1 ? '�' : `${lead}�`,
    ),
    inputSchema: inputSchema !== undefined ? { ...inputSchema, type: 'object' } : { type: 'object' },
  }
}

/** The name the model calls: `mcp__<plugin>__<name>`. */
export function modToolFullName(plugin: string, name: string): string {
  return `${MOD_TOOL_NAME_PREFIX}${plugin}__${name}`
}

/** A tool the engine lists for a plugin: the spec's description and schema,
 *  a core that fails ("a call no hook answers fails"). `modPlugin` marks it
 *  for `forget`. */
export type ModRegisteredTool = ToolContract & { readonly modPlugin: string }

export function isModRegisteredTool(tool: ToolContract): tool is ModRegisteredTool {
  return typeof (tool as { modPlugin?: unknown }).modPlugin === 'string'
}

export function noHookAnsweredText(plugin: string, fullName: string): string {
  return `${fullName} was called but no tool.call hook of ${plugin} answered it: the plugin registered the tool and must serve it with a hook on { tool: "${fullName}" }`
}

export function buildModTool(plugin: string, spec: ModToolSpec): ModRegisteredTool {
  const fullName = modToolFullName(plugin, spec.name)
  const tool = declareTool({
    name: fullName,
    // Named and permission-matched as an MCP tool is (`mcp__<plugin>` rules);
    // no `skill`, so never deferred, and no `mcpInfo`: there is no server.
    fromMcpServer: true,
    argsSchema: spec.inputSchema as ToolArgsJsonShape,
    description: async () => spec.description,
    parallelSafe: () => true,
    readsOnly: () => false,
    async call() {
      // Core: the plugin's hook answered above, or nothing did. An error
      // result, as a tool that failed, so the model reads why.
      return { data: { error: noHookAnsweredText(plugin, fullName), isError: true } }
    },
  }) as unknown as ToolContract
  return Object.assign(tool, { modPlugin: plugin })
}

/** The engine's registry: by full name, replaced on a second registration. */
export class ModRegisteredTools {
  private readonly tools = new Map<string, ModRegisteredTool>()

  constructor(private readonly onChanged: (tools: readonly ModRegisteredTool[]) => void) {}

  /** Registers `spec` for `plugin`; the full name. A name registered again
   *  is replaced. */
  register(spec: ModToolSpec, plugin: string): string {
    const tool = buildModTool(plugin, spec)
    this.tools.set(tool.name, tool)
    this.onChanged(this.list())
    return tool.name
  }

  /** Drops every tool `plugin` registered. */
  forget(plugin: string): void {
    let changed = false
    for (const [name, tool] of this.tools) {
      if (tool.modPlugin !== plugin) continue
      this.tools.delete(name)
      changed = true
    }
    if (changed) this.onChanged(this.list())
  }

  list(): ModRegisteredTool[] {
    return [...this.tools.values()]
  }
}
