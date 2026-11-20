import type { RetiredModel } from '../../providerDefinition'

/** Shut-down google previews and the model a stored pick of each moves to. */
export const GOOGLE_RETIRED_MODELS: readonly RetiredModel[] = [
  {
    ids: /^gemini-3-pro-preview(?:-[\w-]+)?$/,
    entries: ['gemini-*-pro@3-preview'],
    successor: { id: 'gemini-4-carbon', family: 'gemini-*-carbon', version: '4' },
  },
  {
    ids: /^gemini-3(?:\.1)?-flash-lite-preview(?:-[\w-]+)?$/,
    entries: ['gemini-*-flash-lite@3.1-preview', 'gemini-*-flash-lite@3-preview'],
    successor: { id: 'gemini-3.1-flash-lite', family: 'gemini-*-flash-lite', version: '3.1' },
  },
]
