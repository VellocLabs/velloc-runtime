import type {
  AgentProfile,
  ServerLink,
  RuntimeCommandList,
  StreamRecord,
} from '../RuntimeTypes'
import type { ChromiumSkillSummary } from '../CommandTypes'
import type { ToolContractList } from '../../toolkit/toolContract'

/** Minimal plugin summary surfaced to the model in the system-init message. */
export type PluginInitSummary = {
  name: string
  description?: string
}

export type BuildSystemInitMessageParams = {
  tools: ToolContractList
  mcpClients: ServerLink[]
  model: string
  permissionMode: string
  commands: RuntimeCommandList
  agents: AgentProfile[]
  skills?: ChromiumSkillSummary[]
  plugins?: PluginInitSummary[]
  fastMode?: unknown
  sessionId: string
}

export interface SystemInitEmitter {
  buildSystemInitMessage(
    params: BuildSystemInitMessageParams,
  ): Promise<StreamRecord> | StreamRecord
}
