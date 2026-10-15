import type { NexusProviderModelConfig } from '../../types'
import { createExactModelPattern } from '../../patterns'

// Context windows come from the model catalog (F-28); output caps are unpublished,
// so every row keeps the conservative 16,384. Only M3 accepts images.
export const MINIMAX_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'minimax',
  filterMode: 'curated',
  defaultBaseUrl: 'https://api.minimax.io/v1',
  // Runs on a runtime ModelProvider: the Chat Completions codec every
  // OpenAI-compatible provider reuses (the host built this one as an
  // `OpenAiProvider` on chat/completions), over `model.rawStream*`. The host
  // class stays for discovery and the key check.
  wire: { format: 'openai-chat' },
  // PDF input: No document part on MiniMax's API; images on M3 only.
  documentInput: 'rasterize',
  // Figures a row leaves unset come from the catalog: the international
  // platform's records, then the China platform's.
  catalog: { keys: ['minimax', 'minimax-cn'] },
  // `fastModel` is deliberately not a `-highspeed` twin (unpriced), and fast and
  // balanced share M2.7.
  fastModel: 'MiniMax-M2.7',
  balancedModel: 'MiniMax-M2.7',
  // Best names the M FAMILY and follows its latest. Fast and balanced are a
  // version of that same family — fixed ids, or they would collapse into it.
  bestModel: 'MiniMax-M*',
  // FAMILY rows (`family`, ../../types.ts): each speaks for every version of
  // its line inside `minVersion`..`maxVersion`, so the version the vendor
  // ships next — the `latest` the picker follows — reads the same figures
  // and flags with no edit here. `model` names the version the figures were
  // verified against; a version that differs states only its difference
  // under `versions` (`undefined` takes a field away; `id` makes the
  // version a known one, offered without the provider listing it). A row without
  // `family` is FIXED: one model, offered as itself, followed by nothing.
  models: [
    {
      family: 'MiniMax-M*',
      // Verified: M3 — 1M context, the only multimodal row.
      model: createExactModelPattern('MiniMax-M3'),
      name: 'MiniMax M3',
      minVersion: '2',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultMaxOutputTokens: 8_192,
      maxOutputTokens: 16_384,
      versions: {
        // The M2.x line: 204,800 tokens, text + tool calls only — see the
        // M2.x note in the header. Before M2.7 they keep the todo tools.
        '2.7': { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', supportsImageInput: false },
        '2.5': { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', todoTools: undefined, supportsImageInput: false },
        '2.1': { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', todoTools: undefined, supportsImageInput: false },
        '2': { id: 'MiniMax-M2', name: 'MiniMax M2', todoTools: undefined, supportsImageInput: false },
      },
    },
    {
      family: 'MiniMax-M*-highspeed',
      // The `-highspeed` twins (every M2.x but M2; M3 has none).
      model: createExactModelPattern('MiniMax-M2\\.7-highspeed'),
      name: 'MiniMax M2.7 Highspeed',
      minVersion: '2.1',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultMaxOutputTokens: 8_192,
      maxOutputTokens: 16_384,
      supportsImageInput: false,
      versions: {
        '2.5': { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed', todoTools: undefined },
        // The catalog does not list the M2.1 twin: it reads the verified
        // M2.7 twin's record (204,800), as any unlisted version does.
        '2.1': { id: 'MiniMax-M2.1-highspeed', name: 'MiniMax M2.1 Highspeed', todoTools: undefined },
      },
    },
  ],
}
