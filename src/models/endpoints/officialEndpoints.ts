/**
 * Security: "is this URL a first-party vendor server?", answered from the DOMAIN
 * alone (provider id and model say nothing about where the bytes go). One flat list,
 * suffix-matched on a dot boundary; resident and dependency-free. Ollama is absent:
 * loopback is `isLoopbackHost`'s.
 */

/**
 * Security: every first-party domain the product connects to. An entry's depth sets
 * its reach: the registrable domain for a domain the vendor owns outright, the full
 * host under a SHARED cloud domain (`dashscope.aliyuncs.com`, never `aliyuncs.com`,
 * which would bless every tenant). Every `defaultBaseUrl` must be covered
 * (`endpoint-trust.test.ts`); adding a provider adds its domain here.
 */
export const OFFICIAL_ENDPOINT_DOMAINS: ReadonlySet<string> = new Set([
  // OpenAI — the `openai` API base and the `chatgpt-pro` OAuth endpoints.
  'openai.com',
  // ChatGPT Pro's Codex backend.
  'chatgpt.com',
  'anthropic.com',
  // GitHub Copilot — the model backend, plus the device-flow OAuth and token
  // exchange that run on github.com / api.github.com.
  'githubcopilot.com',
  'github.com',
  // Qwen — the `qwen-code` OAuth flow and backend.
  'qwen.ai',
  // Qwen (API key) — Alibaba Model Studio. Every entry is pinned to its host:
  // aliyuncs.com is Alibaba Cloud at large, not this endpoint. Sourced from
  // https://www.alibabacloud.com/help/en/model-studio/base-url and its
  // help.aliyun.com twin — verified.
  //
  // DashScope, per region. The Beijing entry also covers the hosts under it:
  // `cn-hongkong.` (Hong Kong) and the Coding Plan's `coding.` / `coding-intl.`.
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com',
  // Token Plan and the shared trial endpoints — fixed hosts Alibaba runs for
  // every customer. The per-tenant `{WorkspaceId}.<region>.maas.aliyuncs.com`
  // workspace hosts are deliberately NOT listed: blessing them takes an entry
  // at `<region>.maas.aliyuncs.com`, which accepts ANY label under it, and a
  // workspace id says nothing about whose workspace the user was handed. A
  // user on their own workspace marks the provider trusted instead
  // (`classifyEndpoint` honours the per-provider trust setting first).
  'token-plan.cn-beijing.maas.aliyuncs.com',
  'token-plan.ap-southeast-1.maas.aliyuncs.com',
  'trial.cn-beijing.maas.aliyuncs.com',
  'trial.ap-southeast-1.maas.aliyuncs.com',
  'trial.cn-hongkong.maas.aliyuncs.com',
  // Google — Gemini via the Generative Language API. Pinned to the host for
  // the same reason: googleapis.com carries every Google API, most of which
  // are nothing to do with a model vendor.
  'generativelanguage.googleapis.com',
  // GLM (Zhipu) — mainland `bigmodel.cn`, international Z.ai (`api.z.ai`).
  'bigmodel.cn',
  'z.ai',
  // MiniMax — international `minimax.io`, mainland `minimaxi.com` (the extra
  // `i` is the real domain, not a typo).
  'minimax.io',
  'minimaxi.com',
  // Kimi (Moonshot): the Kimi Code endpoint (the default), and the Moonshot
  // open platform users still point an override at.
  'kimi.com',
  'moonshot.cn',
  'deepseek.com',
  // Gateways (user decision: trusted by default). OpenRouter's
  // API lives on its own domain; the Vercel AI Gateway is pinned to its host
  // — vercel.sh serves every Vercel deployment, not this endpoint.
  'openrouter.ai',
  'ai-gateway.vercel.sh',
])

/**
 * Hostname of `url`, lowercased and normalized, or `undefined` unless an absolute
 * http(s) URL (other schemes are rejected, not parsed). A trailing root dot is
 * stripped; IPv6 literals keep their brackets off.
 */
export function endpointHostname(url: string | undefined | null): string | undefined {
  if (!url) return undefined
  const trimmed = url.trim()
  if (trimmed.length === 0) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  let host = parsed.hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  while (host.endsWith('.')) host = host.slice(0, -1)
  return host.length > 0 ? host : undefined
}

/** Loopback host — no network to sniff, and the normal local-model shape. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  return (
    host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.localhost')
  )
}

/**
 * Security: true when `host` is an official domain or a subdomain of one. The dot
 * boundary is the whole defence: `openai.com.evil.test` and `notopenai.com` do not
 * match, and a deep entry stays narrow.
 */
export function isOfficialEndpointHost(host: string | undefined): boolean {
  if (!host) return false
  if (OFFICIAL_ENDPOINT_DOMAINS.has(host)) return true
  for (const domain of OFFICIAL_ENDPOINT_DOMAINS) {
    if (host.endsWith(`.${domain}`)) return true
  }
  return false
}

/**
 * True when `url` points at an official vendor domain; `undefined` / unparseable /
 * non-http(s) → `false`. A caller treating "no URL" as official must say so itself.
 */
export function isOfficialEndpointUrl(url: string | undefined | null): boolean {
  return isOfficialEndpointHost(endpointHostname(url))
}
