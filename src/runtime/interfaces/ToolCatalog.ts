import type { PermissionRuleSet } from '../../toolkit/permissionVerdict'
import type { ToolContractList } from '../../toolkit/toolContract'

export interface ToolCatalog {
  readonly platform: 'browser'
  allBundledTools(): ToolContractList
  toolsForSession(permissionContext: PermissionRuleSet): ToolContractList
  composeToolPool(
    permissionContext: PermissionRuleSet,
    mcpTools: ToolContractList,
  ): ToolContractList
  withExternalTools(
    permissionContext: PermissionRuleSet,
    mcpTools: ToolContractList,
  ): ToolContractList
}
