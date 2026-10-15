export type SystemPromptVariant =
  | 'system_prompt'
  | 'system_prompt_flash'
  | 'system_prompt_anthropic_flash'

export const SYSTEM_PROMPT_VARIANTS: readonly SystemPromptVariant[] = [
  'system_prompt',
  'system_prompt_flash',
  'system_prompt_anthropic_flash',
] as const
