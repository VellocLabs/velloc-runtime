import { describe, expect, it } from 'vitest'
import { PageReadTool } from '../toolkit/builtin/webFetch/webFetch'
import type { RulesByOrigin } from '../toolkit/permissionVerdict'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  evaluatePermissionRules,
  evaluateRuleGate,
  permissionRuleValueMatchesTool,
  suggestAllowRule,
} from '../permissions/ruleEngine'
import { webFetchRuleContent } from '../permissions/webFetchRuleMatching'

/**
 * `WebFetch(domain:<host>)` rules (F-13). Before the fix both layers ignored
 * them: the rule gate never evaluated a WebFetch content rule (passthrough),
 * and `PageReadTool.checkPermissions` looked rules up in a flat map while
 * the context groups them by source — so a deny never denied and an allow
 * never allowed (the call fell to `ask`). A rule matches exactly on
 * `domain:<hostname>`.
 */

const URL_ = 'https://example.com/page'
const input = { url: URL_, prompt: 'summarize' }
const webFetch = { name: 'WebFetch', readsOnly: () => true }

function contextWith(rules: {
  deny?: RulesByOrigin
  allow?: RulesByOrigin
  ask?: RulesByOrigin
}): ToolCallContext {
  return {
    getAppState: () => ({
      permissionRules: {
        mode: 'default',
        denyRuleBook: rules.deny ?? {},
        allowRuleBook: rules.allow ?? {},
        askRuleBook: rules.ask ?? {},
      },
    }),
  } as unknown as ToolCallContext
}

describe('WebFetch domain rules — rule gate', () => {
  it('a WebFetch(domain:example.com) deny rule denies a fetch of that host', () => {
    expect(
      evaluatePermissionRules({
        toolName: 'WebFetch',
        input,
        ruleLists: { deny: ['WebFetch(domain:example.com)'], ask: [], allow: [] },
      }),
    ).toEqual({ behavior: 'deny', ruleString: 'WebFetch(domain:example.com)' })
  })

  it('a WebFetch(domain:example.com) allow rule allows it (by-source map)', () => {
    const decision = evaluateRuleGate(webFetch, input, {
      allowRuleBook: { projectSettings: ['WebFetch(domain:example.com)'] },
    })
    expect(decision).toMatchObject({ behavior: 'allow', ruleSource: 'projectSettings' })
  })

  it('matches the hostname exactly — no subdomain, no other host', () => {
    const rule = { toolName: 'WebFetch', ruleContent: 'domain:example.com' }
    expect(permissionRuleValueMatchesTool(rule, 'WebFetch', { url: 'https://example.com:8443/x' })).toBe(true)
    expect(permissionRuleValueMatchesTool(rule, 'WebFetch', { url: 'https://www.example.com/' })).toBe(false)
    expect(permissionRuleValueMatchesTool(rule, 'WebFetch', { url: 'https://example.org/' })).toBe(false)
    expect(permissionRuleValueMatchesTool(rule, 'WebFetch', { url: 'not a url' })).toBe(false)
    expect(permissionRuleValueMatchesTool(rule, 'WebFetch', {})).toBe(false)
  })

  it('compares hosts as DNS names: a trailing dot does not slip past a deny, and a capitalised rule still matches', () => {
    const deny = { deny: ['WebFetch(domain:evil.com)'], ask: [], allow: [] }
    expect(
      evaluatePermissionRules({ toolName: 'WebFetch', input: { url: 'https://evil.com./x' }, ruleLists: deny }),
    ).toMatchObject({ behavior: 'deny' })
    expect(
      evaluatePermissionRules({
        toolName: 'WebFetch',
        input: { url: 'https://evil.com/x' },
        ruleLists: { deny: ['WebFetch(domain:Evil.COM)'], ask: [], allow: [] },
      }),
    ).toMatchObject({ behavior: 'deny' })
  })
})

describe('WebFetch — "Always allow" suggests the host, not the whole tool', () => {
  it('suggests WebFetch(domain:<host>)', () => {
    expect(suggestAllowRule('WebFetch', { url: 'https://docs.example.com/a?b=1', prompt: 'x' })).toEqual({
      suggestedRule: 'WebFetch(domain:docs.example.com)',
      summary: 'docs.example.com',
    })
  })
  it('a URL with no host falls back to the tool-wide rule', () => {
    expect(suggestAllowRule('WebFetch', { url: 'not a url' })).toEqual({ suggestedRule: 'WebFetch' })
  })
})

describe('WebFetch domain rules — the rule gate decides; checkPermissions only asks', () => {
  // Both callers of checkPermissions (toolExecution, ExecTool) run the rule
  // gate first and consult the tool only on passthrough, so the order of the
  // rule kinds is the gate's.
  const gate = (rules: Parameters<typeof contextWith>[0]) =>
    evaluateRuleGate(webFetch, input, {
      denyRuleBook: rules.deny ?? {},
      allowRuleBook: rules.allow ?? {},
      askRuleBook: rules.ask ?? {},
    }).behavior

  it('deny beats allow, ask beats allow; another host passes through', () => {
    expect(
      gate({
        deny: { policySettings: ['WebFetch(domain:example.com)'] },
        allow: { userSettings: ['WebFetch(domain:example.com)'] },
      }),
    ).toBe('deny')
    expect(
      gate({
        ask: { projectSettings: ['WebFetch(domain:example.com)'] },
        allow: { userSettings: ['WebFetch(domain:example.com)'] },
      }),
    ).toBe('ask')
    expect(gate({ allow: { userSettings: ['WebFetch(domain:example.org)'] } })).toBe('passthrough')
  })

  it('checkPermissions asks for a host that is not preapproved', async () => {
    const r = await PageReadTool.selfVerdict!(input, contextWith({}))
    expect(r.behavior).toBe('ask')
  })
})

describe('webFetchRuleMatching helpers', () => {
  it('webFetchRuleContent builds domain: / input: rule content', () => {
    expect(webFetchRuleContent(URL_)).toBe('domain:example.com')
    expect(webFetchRuleContent('nope')).toBe('input:nope')
  })
})
