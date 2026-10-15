/**
 * Providers the bundle snapshot keeps (a first-start fallback only). A lookup
 * for a key the snapshot lacks does not count it as current (`partial`). Add a
 * key when a shipped provider or bundled mod looks it up, or lookups borrow
 * from it (`alsoTry`).
 */
export const SNAPSHOT_PROVIDER_KEYS: readonly string[] = [
  // Gateways Velloc ships a provider or a bundled mod for.
  'opencode',
  'opencode-go',
  'openrouter',
  'vercel',
  'github-copilot',
  'ollama-cloud',
  // Model makers: Velloc's own providers, and the sources borrowed from.
  'anthropic',
  'openai',
  'google',
  'xai',
  'mistral',
  'deepseek',
  'zai',
  'zai-coding-plan',
  'zhipuai',
  'zhipuai-coding-plan',
  'moonshotai',
  'moonshotai-cn',
  'kimi-code-plan-global',
  'kimi-code-plan-cn',
  'minimax',
  'minimax-cn',
  'alibaba',
  'alibaba-cn',
  'xiaomi',
  'nvidia',
  'stepfun',
  'longcat',
]
