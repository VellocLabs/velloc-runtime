import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyEndpoint,
  isInsecureBaseUrl,
  publishProviderBaseUrls,
  publishProviderBaseUrlsFromConfigs,
  publishProviderTrustOverrides,
  __resetEndpointTrustForTest,
} from '../models/endpoints/endpointTrust'
import {
  OFFICIAL_ENDPOINT_DOMAINS,
  endpointHostname,
  isLoopbackHost,
  isOfficialEndpointHost,
  isOfficialEndpointUrl,
} from '../models/endpoints/officialEndpoints'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'

function resetAll(): void {
  __resetEndpointTrustForTest()
}

describe('officialEndpoints.isOfficialEndpointUrl', () => {
  // The point of the function: the DOMAIN is the whole answer. No provider
  // id and no model id is passed in, and none is consulted — every vendor's
  // hosts live in one flat list.
  it('accepts every first-party vendor host the product connects to', () => {
    for (const url of [
      'https://api.openai.com/v1',
      'https://auth.openai.com/oauth/token',
      'https://chatgpt.com/backend-api/codex',
      'https://api.anthropic.com',
      'https://api.githubcopilot.com',
      'https://api.github.com/copilot_internal/v2/token',
      'https://github.com/login/device/code',
      'https://chat.qwen.ai/api/v1/oauth2/token',
      'https://portal.qwen.ai/v1',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      // Alibaba Model Studio's other official hosts — regions, Coding Plan,
      // Token Plan and the trial endpoints.
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
      'https://coding.dashscope.aliyuncs.com/v1',
      'https://coding-intl.dashscope.aliyuncs.com/v1',
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      'https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      'https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      'https://trial.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1',
      'https://generativelanguage.googleapis.com/v1beta',
      'https://open.bigmodel.cn/api/paas/v4',
      // GLM international (Z.ai).
      'https://api.z.ai/api/paas/v4',
      'https://api.minimax.io/v1',
      // MiniMax mainland — `minimaxi`, one letter off the international one.
      'https://api.minimaxi.com/v1',
      'https://api.kimi.com/coding/v1',
      'https://api.moonshot.cn/v1',
      'https://api.deepseek.com',
    ]) {
      expect(isOfficialEndpointUrl(url), url).toBe(true)
    }
  })

  // Default base URLs live on the provider configs, so a default that moves
  // to a new domain must bring the domain here — otherwise every profile on
  // the default would read as a relay. Ollama's default is local.
  it("covers every provider's default base URL", () => {
    for (const provider of NEXUS_MODEL_CONFIG.providers) {
      const url = provider.defaultBaseUrl
      if (url === undefined) continue
      const host = endpointHostname(url)
      expect(
        isOfficialEndpointUrl(url) || (host !== undefined && isLoopbackHost(host)),
        `${provider.providerId}: ${url}`,
      ).toBe(true)
    }
  })

  it('rejects relays, look-alikes and suffix tricks', () => {
    // A relay in front of a vendor is the case the whole check exists for.
    expect(isOfficialEndpointUrl('https://relay.example.test/v1')).toBe(false)
    // The entry must sit at the END of the host — this is the attack the
    // dot-boundary match exists to stop.
    expect(isOfficialEndpointUrl('https://api.openai.com.evil.test/v1')).toBe(false)
    expect(isOfficialEndpointUrl('https://openai.com.evil.test/v1')).toBe(false)
    // …and on a dot boundary, so a glued prefix is not a subdomain.
    expect(isOfficialEndpointUrl('https://notopenai.com/v1')).toBe(false)
    expect(isOfficialEndpointUrl('https://myanthropic.com/v1')).toBe(false)
    // A different TLD is a different domain.
    expect(isOfficialEndpointUrl('https://openai.com.cn/v1')).toBe(false)
    // Shared cloud domains are listed at HOST depth, so a sibling tenant on
    // the same cloud is not first-party — and the cloud itself is not an
    // entry at all.
    expect(isOfficialEndpointUrl('https://evil.aliyuncs.com/v1')).toBe(false)
    expect(isOfficialEndpointUrl('https://evil.googleapis.com/v1beta')).toBe(false)
    expect(isOfficialEndpointUrl('https://aliyuncs.com/v1')).toBe(false)
    // Model Studio's maas hosts are pinned one by one: a per-tenant
    // workspace host is not blessed, nor is the region or maas domain.
    expect(isOfficialEndpointUrl('https://ws-abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')).toBe(false)
    expect(isOfficialEndpointUrl('https://cn-beijing.maas.aliyuncs.com/v1')).toBe(false)
    expect(isOfficialEndpointUrl('https://maas.aliyuncs.com/v1')).toBe(false)
    // One letter off a real vendor domain is still a different domain.
    expect(isOfficialEndpointUrl('https://api.minimaxii.com/v1')).toBe(false)
    expect(isOfficialEndpointUrl('https://api.zz.ai/v1')).toBe(false)
    expect(isOfficialEndpointUrl('https://googleapis.com/v1beta')).toBe(false)
  })

  it('accepts an entry and anything under it, at whatever depth it is listed', () => {
    // A vendor-owned domain is listed at registrable depth, so one entry
    // covers every subdomain it uses — including ones added after this was
    // written.
    expect(isOfficialEndpointUrl('https://openai.com/v1')).toBe(true)
    expect(isOfficialEndpointUrl('https://eu.api.anthropic.com/v1')).toBe(true)
    expect(isOfficialEndpointHost('eu.api.anthropic.com')).toBe(true)
    expect(isOfficialEndpointHost('some-new-host.openai.com')).toBe(true)
    // A shared-cloud endpoint is listed at host depth, and the same suffix
    // rule still lets it grow downwards.
    expect(isOfficialEndpointHost('dashscope.aliyuncs.com')).toBe(true)
    expect(isOfficialEndpointHost('eu.dashscope.aliyuncs.com')).toBe(true)
  })

  it('is scheme- and case-insensitive but rejects non-http(s) and junk', () => {
    expect(isOfficialEndpointUrl('http://API.OpenAI.Com/v1')).toBe(true)
    // A trailing root dot names the same host.
    expect(isOfficialEndpointUrl('https://api.anthropic.com./v1')).toBe(true)
    expect(isOfficialEndpointUrl('file:///api.openai.com')).toBe(false)
    expect(isOfficialEndpointUrl('api.openai.com/v1')).toBe(false)
    expect(isOfficialEndpointUrl('not a url')).toBe(false)
    expect(isOfficialEndpointUrl('')).toBe(false)
    expect(isOfficialEndpointUrl(undefined)).toBe(false)
  })

  it('does not treat local weights as an official vendor domain', () => {
    // Ollama has no vendor server; loopback is a separate question.
    expect(isOfficialEndpointUrl('http://localhost:11434')).toBe(false)
    expect(isLoopbackHost(endpointHostname('http://localhost:11434'))).toBe(true)
    expect(isLoopbackHost(endpointHostname('http://127.0.0.1:1234/v1'))).toBe(true)
    expect(isLoopbackHost(endpointHostname('http://[::1]:1234/v1'))).toBe(true)
    expect(isLoopbackHost(endpointHostname('https://api.openai.com'))).toBe(false)
  })

  it('keeps every entry a bare, matchable hostname', () => {
    for (const domain of OFFICIAL_ENDPOINT_DOMAINS) {
      // No scheme, port or path — lookups compare bare hostnames.
      expect(domain, domain).toBe(domain.toLowerCase())
      expect(domain, domain).not.toMatch(/[:/]/)
      // At least two labels, and no stray leading/trailing dot, which would
      // break the dot-boundary suffix match.
      expect(domain.split('.').length, domain).toBeGreaterThanOrEqual(2)
      expect(domain.startsWith('.') || domain.endsWith('.'), domain).toBe(false)
    }
    // Entry DEPTH is deliberate, not incidental: the two shared-cloud
    // endpoints are pinned to their host so sibling tenants stay out.
    expect(OFFICIAL_ENDPOINT_DOMAINS.has('aliyuncs.com')).toBe(false)
    expect(OFFICIAL_ENDPOINT_DOMAINS.has('googleapis.com')).toBe(false)
    expect(OFFICIAL_ENDPOINT_DOMAINS.has('dashscope.aliyuncs.com')).toBe(true)
    expect(OFFICIAL_ENDPOINT_DOMAINS.has('generativelanguage.googleapis.com')).toBe(true)
    // Every aliyuncs.com entry is a pinned host, never a region or product
    // domain that would take in per-tenant workspace hosts.
    for (const domain of OFFICIAL_ENDPOINT_DOMAINS) {
      if (!domain.endsWith('.aliyuncs.com')) continue
      expect(domain, domain).not.toMatch(/^(?:[a-z0-9-]+\.)?maas\.aliyuncs\.com$/)
    }
  })
})

describe('endpointTrust.classifyEndpoint', () => {
  beforeEach(resetAll)

  it('treats a vendor provider with no base-url override as official', () => {
    const trust = classifyEndpoint('anthropic')
    expect(trust.unofficial).toBe(false)
    expect(trust.reasons).toEqual([])
  })

  it('treats an absent providerId as official (never guess)', () => {
    expect(classifyEndpoint(undefined).unofficial).toBe(false)
  })

  it('flags passthrough custom endpoints and local providers', () => {
    expect(classifyEndpoint('custom-openai').reasons).toContain('custom-endpoint-provider')
    expect(classifyEndpoint('custom-anthropic').unofficial).toBe(true)
    expect(classifyEndpoint('ollama').reasons).toContain('local-provider')
  })

  it('flags a vendor provider pointed at an overridden base URL', () => {
    publishProviderBaseUrls({ anthropic: 'https://relay.example.test/v1' })
    const trust = classifyEndpoint('anthropic')
    expect(trust.unofficial).toBe(true)
    expect(trust.reasons).toEqual(['base-url-override'])
    expect(trust.insecure).toBe(false)
  })

  it('leaves an override that still lands on an official domain official', () => {
    // Regional / pinned-version hosts reach the vendor exactly as the
    // built-in default does — the override is not a relay.
    publishProviderBaseUrls({ anthropic: 'https://api.anthropic.com/v1' })
    expect(classifyEndpoint('anthropic').unofficial).toBe(false)
    publishProviderBaseUrls({ openai: 'https://api.openai.com/v1' })
    expect(classifyEndpoint('openai').reasons).toEqual([])
  })

  it('lets an explicit UNTRUSTED marking override an official domain', () => {
    // One trust value: the user's declaration reaches request classification
    // too, so a vendor domain no longer buys a pass on inspection. A domain
    // says where the bytes go, not who answers.
    publishProviderTrustOverrides({ anthropic: 'untrusted' })
    const trust = classifyEndpoint('anthropic')
    expect(trust.unofficial).toBe(true)
    expect(trust.reasons).toEqual(['user-marked-untrusted'])
  })

  it('lets an explicit TRUSTED marking override an off-domain relay', () => {
    // The escape hatch, and it is deliberate: someone running a gateway they
    // operate should not be probed forever. It is the same one value the
    // settings toggle writes.
    publishProviderBaseUrls({ anthropic: 'https://gateway.example.test/v1' })
    publishProviderTrustOverrides({ anthropic: 'trusted' })
    const trust = classifyEndpoint('anthropic')
    expect(trust.unofficial).toBe(false)
    expect(trust.reasons).toEqual([])
  })

  it('reports a plaintext endpoint as insecure even when marked trusted', () => {
    // The override decides inspection, not the facts: the key really is on
    // the wire in clear, and the settings UI still says so.
    publishProviderBaseUrls({ gw: 'http://gw.example.test/v1' })
    publishProviderTrustOverrides({ gw: 'trusted' })
    expect(classifyEndpoint('gw').insecure).toBe(true)
  })

  it('publishes the trust overrides from the same configs as the base URLs', () => {
    publishProviderBaseUrlsFromConfigs({
      anthropic: { trust: 'untrusted' },
      openai: { baseUrl: 'https://api.openai.com/v1' },
    })
    expect(classifyEndpoint('anthropic').unofficial).toBe(true)
    expect(classifyEndpoint('openai').unofficial).toBe(false)
    // Replace-wholesale: a cleared marker reverts to the domain answer.
    publishProviderBaseUrlsFromConfigs({ anthropic: {} })
    expect(classifyEndpoint('anthropic').unofficial).toBe(false)
  })

  it('flags plaintext http endpoints but exempts loopback', () => {
    expect(isInsecureBaseUrl('http://relay.example.test/v1')).toBe(true)
    expect(isInsecureBaseUrl('http://localhost:11434')).toBe(false)
    expect(isInsecureBaseUrl('http://127.0.0.1:1234/v1')).toBe(false)
    expect(isInsecureBaseUrl('https://relay.example.test/v1')).toBe(false)
    expect(isInsecureBaseUrl(undefined)).toBe(false)
  })
})
