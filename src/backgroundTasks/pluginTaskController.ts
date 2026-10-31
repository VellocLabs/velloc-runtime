/**
 * The leaf through which a session's mods reach plugin tasks (F-25 `$.task`):
 * the session manager registers the controller, the mod runtime calls it. A
 * leaf so the mod side never imports the manager.
 */

import type {
  PluginTaskListing,
  PluginTaskOutcome,
  PluginTaskStart,
  PluginTaskUpdate,
} from '../browser/worker/PluginTaskCoordinator'

export type PluginTaskController = {
  start(start: PluginTaskStart): string
  progress(spawnerSessionId: string, plugin: string, taskId: string, update: PluginTaskUpdate): void
  finish(spawnerSessionId: string, plugin: string, taskId: string, outcome: PluginTaskOutcome): void
  adoptChild(spawnerSessionId: string, plugin: string, taskId: string, agentId: string): void
  /** The plugin's tasks of the session, including those restored from a
   *  previous run of the app; resolves once that restore has been read. */
  list(spawnerSessionId: string, plugin: string): Promise<PluginTaskListing[]>
}

let controller: PluginTaskController | null = null

export function setPluginTaskController(next: PluginTaskController | null): void {
  controller = next
}

export function getPluginTaskController(): PluginTaskController | null {
  return controller
}
