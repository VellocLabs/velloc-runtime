import type {
  BuildSystemInitMessageParams,
  SystemInitEmitter,
} from '../../runtime/interfaces/SystemInitEmitter'
import type { StreamRecord } from '../../runtime/RuntimeTypes'
import { BROWSER_SLASH_COMMANDS } from '../../input/slashCommandCatalog'
import { BrowserHostBridge } from '../bridge/BrowserHostBridge'

export type BrowserSystemInitEmitterOptions = {
  hostBridge: BrowserHostBridge
  supportedSlashCommands?: readonly string[]
}

export class BrowserSystemInitEmitter implements SystemInitEmitter {
  private readonly hostBridge: BrowserHostBridge
  private readonly supportedSlashCommands: readonly string[]

  constructor(options: BrowserSystemInitEmitterOptions) {
    this.hostBridge = options.hostBridge
    this.supportedSlashCommands =
      options.supportedSlashCommands ?? BROWSER_SLASH_COMMANDS
  }

  async buildSystemInitMessage(
    params: BuildSystemInitMessageParams,
  ): Promise<StreamRecord> {
    const snapshot = await this.hostBridge.getBrowserContextSnapshot({
      includeDomSnapshot: false,
      includeAccessibilitySnapshot: false,
    })

    return {
      type: 'system',
      subtype: 'init',
      session_id: params.sessionId,
      uuid: params.sessionId,
      model: params.model,
      permissionMode: params.permissionMode,
      tools: params.tools.map(tool => tool.name),
      mcpClients: params.mcpClients.map(client => client.name ?? 'unknown'),
      slashCommands: this.supportedSlashCommands.map(command => `/${command}`),
      skills: params.skills?.map(skill => ({
        name: skill.name,
        description: skill.description,
        shortId: skill.shortId,
      })) ?? [],
      plugins: params.plugins?.map(plugin => ({
        name: plugin.name,
        description: plugin.description,
      })) ?? [],
      host: {
        platform: 'browser',
        bridge: 'BrowserHostBridge',
      },
      activeTab: snapshot.activeTab,
      session: snapshot.session,
      workspace: snapshot.workspace,
      fastMode: params.fastMode,
    }
  }
}
