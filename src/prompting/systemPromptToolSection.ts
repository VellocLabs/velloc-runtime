import type { ToolContractList } from '../toolkit/toolContract'

// `getEnabledToolNames`: a `Tools[]` as a name set, for the substitution
// path in `systemPromptLoader.ts`.

export function getEnabledToolNames(tools: ToolContractList): Set<string> {
  return new Set(tools.map(t => t.name))
}
