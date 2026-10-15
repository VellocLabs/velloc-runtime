import { getProductName } from '../branding/productName'

/**
 * Product / agent name from `getProductName()` (the host's `?product=`, else
 * the default in src/branding/productName.ts). Public surface; unused in tree.
 */
export const AGENT_NAME = getProductName()

// The system prompt used to be assembled here via getStaticSystemPrompt().
// It now lives in `system_prompts/<variant>.md` (served from public/) and
// is loaded lazily by `systemPromptLoader.ts`.
//
// The `{{TOOL_CATALOG}}` / `{{system-prompt-tools}}` sections are rendered
// by `promptSections/promptSectionRenderer.ts` (moved back from the C++
// `catalog` capability). `getEnabledToolNames` remains in
// `systemPromptToolSection.ts` and is imported directly by the loader.
export {
  loadSystemPromptHolders,
  selectSystemPromptVariant,
  PromptUnavailableError,
  type SystemPromptVariant,
  type SelectSystemPromptParams,
} from './systemPromptLoader'
