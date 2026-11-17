/**
 * The mod API declaration for the session's dev mods (F-25): built from the
 * tables this engine serves and the session's tools, and written into each
 * dev-folder plugin when the folder loads it or the session's tools change.
 * Contract: never rejects; each refusal or conflict is one `report` line.
 */

import { getPluginManifestDirName } from '../pluginHost/pluginPaths'
import type { ActivePlugin } from '../pluginHost/pluginModel'
import { RAISED_EVENTS } from './modAdmission'
import { buildModApiFiles, type DeclaredTool, type ModApiTables } from './modApiDeclaration'
import { MOD_API_SPECIFIER } from './modCompiler'
import { implementedNouns } from './modNouns'
import { DESKTOP_ELEMENTS, RENDER_SITES } from './modRender'
import { ENGINE_NOUNS, WORKER_SERVED_CALLS } from './modScan'
import { STREAMING_EVENTS } from './modTypes'
import { emitModTypes, type ModTypesFs } from './modTypesEmit'

/** A session tool as the declaration needs it. */
export type DevModTool = {
  name: string
  argsSchema?: unknown
  mcpInfo?: unknown
  fromMcpServer?: boolean
}

/** The tables of this engine, with `tools` as the session offers them. */
export function modApiTables(tools: readonly DevModTool[]): ModApiTables {
  return {
    specifier: MOD_API_SPECIFIER,
    events: RAISED_EVENTS,
    streaming: STREAMING_EVENTS,
    calls: [...implementedNouns(), ...WORKER_SERVED_CALLS],
    engineNouns: ENGINE_NOUNS,
    renderSites: RENDER_SITES,
    desktopElements: DESKTOP_ELEMENTS,
    tools: tools.map(
      (tool): DeclaredTool => ({
        name: tool.name,
        schema: tool.argsSchema,
        mcp: tool.mcpInfo !== undefined || tool.fromMcpServer === true,
      }),
    ),
  }
}

/** The name of a plugin's manifest directory, as the loader reads it. */
export function manifestDirName(): string {
  return getPluginManifestDirName()
}

export type DevModTypesWriter = {
  /** The folder loaded `plugins`: write their declarations beside the turns. */
  loaded(plugins: readonly Pick<ActivePlugin, 'name' | 'path'>[]): void
  /** Write again when the session's tools differ from the last write's. */
  refresh(): void
  /** Settles once every write started so far has. */
  idle(): Promise<void>
}

/** Contract: writes run one at a time, never hold the caller, and none
 *  starts once `signal` has aborted. */
export function createDevModTypesWriter(options: {
  fs: ModTypesFs
  folder: string
  tools(): readonly DevModTool[]
  join(base: string, ...segments: string[]): string
  report(line: string): void
  signal?: AbortSignal
}): DevModTypesWriter {
  let plugins: readonly Pick<ActivePlugin, 'name' | 'path'>[] = []
  let toolsKey: string | undefined
  let queue: Promise<void> = Promise.resolve()
  const keyOf = (tools: readonly DevModTool[]): string =>
    JSON.stringify(tools.map(tool => [tool.name, tool.mcpInfo !== undefined || tool.fromMcpServer === true, tool.argsSchema ?? null]))
  const write = (): void => {
    const target = plugins
    queue = queue.then(async () => {
      if (options.signal?.aborted) return
      const tools = options.tools()
      toolsKey = keyOf(tools)
      await writeDevModTypes({ fs: options.fs, folder: options.folder, plugins: target, tools, join: options.join, report: options.report })
    }).catch(error => {
      options.report(`dev mods: types not written: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return {
    loaded(next) {
      plugins = next
      write()
    },
    refresh() {
      if (plugins.length === 0 || options.signal?.aborted) return
      if (keyOf(options.tools()) !== toolsKey) write()
    },
    idle: () => queue,
  }
}

export async function writeDevModTypes(options: {
  fs: ModTypesFs
  folder: string
  plugins: readonly Pick<ActivePlugin, 'name' | 'path'>[]
  tools: readonly DevModTool[]
  join(base: string, ...segments: string[]): string
  report(line: string): void
}): Promise<void> {
  if (options.plugins.length === 0) return
  let files
  try {
    files = buildModApiFiles(modApiTables(options.tools))
  } catch (error) {
    options.report(`dev mods: the API declaration was not built: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const manifestDir = manifestDirName()
  for (const plugin of options.plugins) {
    try {
      const outcome = await emitModTypes(
        options.fs,
        { folder: options.folder, pluginDir: plugin.path, manifestDir, join: options.join },
        files,
      )
      if (outcome.refused) options.report(`dev mods: ${plugin.name}: types not written: ${outcome.refused}`)
      for (const path of outcome.conflicts) {
        options.report(`dev mods: ${plugin.name}: ${path} is not a generated file; left as it is`)
      }
    } catch (error) {
      options.report(`dev mods: ${plugin.name}: types not written: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
