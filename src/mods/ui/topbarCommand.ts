/**
 * What a topbar press types into the composer (F-25): a slash command of the
 * plugin that offers the item, and nothing of another plugin's. Pure.
 */

export type TopbarCommandRequest = { plugin: string; command: string; args?: string }

export type TopbarCommandSources = {
  /** The session's mod-registered commands (bare names). */
  modCommands: ReadonlyArray<{ name: string; plugin: string }>
  /** The session's prompt commands; a plugin's are named `<plugin>:<name>`. */
  promptCommands: ReadonlyArray<{ name: string; pluginName?: string }>
}

/** The prompt to submit, or undefined when the plugin has no such command. */
export function topbarCommandPrompt(request: TopbarCommandRequest, sources: TopbarCommandSources): string | undefined {
  const tail = request.args ? ` ${request.args}` : ''
  if (sources.modCommands.some(entry => entry.name === request.command && entry.plugin === request.plugin)) {
    return `/${request.command}${tail}`
  }
  const namespaced = `${request.plugin}:${request.command}`
  if (sources.promptCommands.some(entry => entry.name === namespaced && entry.pluginName === request.plugin)) {
    return `/${namespaced}${tail}`
  }
  return undefined
}
