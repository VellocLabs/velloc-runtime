import type { NexusProviderModelConfig } from '../../types'

// Ollama windows are each base model's registry default `num_ctx` (user-editable),
// and `supportsImageInput` is static per registry page.
export const OLLAMA_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'ollama',
  filterMode: 'curated',
  defaultBaseUrl: 'http://localhost:11434',
  // Runs on a runtime ModelProvider: the `ollama-chat` codec (the JS twin of the
  // host's `OllamaProvider` — `/v1/chat/completions`, keyless) over
  // `model.rawStream*`. The host class stays for discovery (`/api/tags`).
  wire: { format: 'ollama-chat' },
  // PDF input: `/api/chat` carries `images` only — no document part.
  documentInput: 'rasterize',
  // No `catalog`: these rows describe a LOCAL Ollama's default `num_ctx` for
  // a tag; the catalog's `ollama-cloud` is a different service with other
  // tags and limits.
  models: [
    {
      model: 'gpt-oss',
      name: 'GPT-OSS',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 8_192,
      maxOutputTokens: 32_768,
      supportsImageInput: false,
    },
    {
      // Multimodal — registry card lists "Text, Image" input on all sizes
      // (ollama.com/library/qwen3.5). Default true.
      model: 'qwen3.5',
      name: 'Qwen 3.5',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 8_192,
      maxOutputTokens: 32_768,
    },
    {
      model: 'qwen3-coder',
      name: 'Qwen 3 Coder',
      contextWindow: 262_144,
      defaultMaxOutputTokens: 8_192,
      maxOutputTokens: 32_768,
      supportsImageInput: false,
    },
    {
      model: 'qwen2.5-coder',
      name: 'Qwen 2.5 Coder',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 8_192,
      supportsImageInput: false,
    },
    {
      model: 'qwen2.5',
      name: 'Qwen 2.5',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 8_192,
      supportsImageInput: false,
    },
    {
      // Multimodal — "Gemma 4 models are multimodal, handling text and
      // image input" (ollama.com/library/gemma4).
      // Default true.
      model: 'gemma4',
      name: 'Gemma 4',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 8_192,
    },
    {
      model: 'llama3.3',
      name: 'Llama 3.3',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 8_192,
      supportsImageInput: false,
    },
    {
      // Base `mistral-small` is text-only ("tools" badge only); the vision
      // variants are separately named mistral-small3.1/3.2.
      model: 'mistral-small',
      name: 'Mistral Small',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 8_192,
      supportsImageInput: false,
    },
    {
      model: 'mistral-nemo',
      name: 'Mistral Nemo',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 8_192,
      supportsImageInput: false,
    },
    {
      model: 'deepseek-v3',
      name: 'DeepSeek V3',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 8_192,
      supportsImageInput: false,
    },
    {
      model: 'deepseek-coder-v2',
      name: 'DeepSeek Coder V2',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 8_192,
      supportsImageInput: false,
    },
    {
      model: 'llama3',
      name: 'Llama 3',
      contextWindow: 8_192,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 4_096,
      supportsImageInput: false,
    },
    {
      model: 'mistral',
      name: 'Mistral',
      contextWindow: 32_768,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 8_192,
      supportsImageInput: false,
    },
    {
      model: 'codellama',
      name: 'Code Llama',
      contextWindow: 16_384,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 4_096,
      supportsImageInput: false,
    },
    {
      model: 'gemma2',
      name: 'Gemma 2',
      contextWindow: 8_192,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 4_096,
      supportsImageInput: false,
    },
    {
      model: 'phi4',
      name: 'Phi 4',
      contextWindow: 16_384,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 4_096,
      supportsImageInput: false,
    },
    {
      model: 'phi3',
      name: 'Phi 3',
      contextWindow: 128_000,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 4_096,
      supportsImageInput: false,
    },
  ],
}
