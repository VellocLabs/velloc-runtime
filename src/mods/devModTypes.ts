/**
 * The mod API declaration for the session's dev mods (F-25): built from the
 * tables this engine serves and the session's tools, and written into each
 * dev-folder plugin when the folder loads it.
 * Contract: never rejects; each refusal or conflict is one `report` line.
 */

import { getPluginManifestPath } from '../pluginHost/pluginPaths'
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
  const parts = getPluginManifestPath('plugin').split(/[\\/]/)
  return parts[parts.length - 2]!
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
