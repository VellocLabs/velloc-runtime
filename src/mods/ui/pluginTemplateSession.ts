/**
 * A session of a plugin's template type (F-25): the type's files are read and
 * registered before the engine is built, and the install that offers the type
 * is checked against the one the session recorded when it was created.
 * Security: a session never runs on another install's prompt and tools. Each
 * refusal is a `PluginTemplateUnavailableError` whose `code` the page shows in
 * the person's language; the engine is not built.
 */

import { registerPluginType } from '../../prompting/templateRegistry'
import { getModUiContributionsHost, type ModUiContributionsHost } from './contributionsHost'

export type PluginTemplateErrorCode =
  | 'plugin_template_absent'
  | 'plugin_template_waiting'
  | 'plugin_template_owner'

export class PluginTemplateUnavailableError extends Error {
  constructor(
    readonly code: PluginTemplateErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PluginTemplateUnavailableError'
  }
}

/** Register `type` from the plugin in effect that offers it; its owner. */
export async function openPluginTemplate(
  type: string,
  host: ModUiContributionsHost = getModUiContributionsHost(),
): Promise<{ owner: string }> {
  await host.whenSynced()
  const status = host.templateStatus(type)
  if (status.state === 'absent') {
    throw new PluginTemplateUnavailableError(
      'plugin_template_absent',
      `The plugin ${status.plugin} that provides the template ${type} is turned off or not installed.`,
    )
  }
  if (status.state === 'waiting') {
    throw new PluginTemplateUnavailableError(
      'plugin_template_waiting',
      `The plugin ${status.plugin} waits for its provider to be set up on the Models page.`,
    )
  }
  await registerPluginType(type, await host.readTemplateFiles(status.source))
  return { owner: status.source.owner }
}

/** Refuse a session whose recorded owner is not the install offering its type now. */
export function checkTemplateOwner(type: string, recorded: unknown, owner: string): void {
  if (typeof recorded === 'string' && recorded !== owner) {
    throw new PluginTemplateUnavailableError(
      'plugin_template_owner',
      `This session's template ${type} comes from ${recorded}, which is not installed.`,
    )
  }
}
