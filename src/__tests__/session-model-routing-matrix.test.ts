import { afterEach, describe, expect, it } from 'vitest'

import type { NexusModelConfig } from '../config/nexusModelConfig'
import { resolveModelTier } from '../toolkit/builtin/subagentLaunch'
import type { TierResolution } from '../toolkit/builtin/subagentLaunch'
import { getModelForSessionType } from '../engine/contextWindow'
import type { TierModelSessionType } from '../engine/contextWindow'
import {
  resetSessionModelSettingsSnapshot,
  setSessionModelSettingsSnapshot,
} from '../models/tierSettingsSnapshot'
import type {
  ModelTierSlot,
  NexusModelTiersSettings,
  SessionModelPolicy,
  SessionModelPolicyType,
} from '../settings/settingsTypes'

/**
 * The full routing matrix for child-session models (F-12): every kind × policy × dictionary state × provider with
 * and without a tier ladder, against an oracle written from the documented rules. The parent is always the last
 * candidate, never twice, never a third model. The census is spelled out here: changing a kind's default tier must
 * change this table. `resolveModelTier` (the Agent tool) gets its own matrix with the call-time tier axis.
 */

afterEach(() => resetSessionModelSettingsSnapshot())

type Candidate = { providerId: string; modelId: string; thinkingTier?: string }

const KINDS: SessionModelPolicyType[] = [
  'agent_tool',
  'session_title',
  'memory_recall',
  'web_fetch',
  'prompt_hook',
  'compact',
  'memory_extract',
  'memory_consolidate',
  'skill_fork',
  'hook_agent',
]

/** The census, restated independently of SESSION_TYPE_TIER. */
const CENSUS: Record<SessionModelPolicyType, ModelTierSlot | 'inherit'> = {
  agent_tool: 'inherit',
  session_title: 'fast',
  memory_recall: 'balanced',
  web_fetch: 'fast',
  prompt_hook: 'fast',
  compact: 'inherit',
  memory_extract: 'inherit',
  memory_consolidate: 'inherit',
  skill_fork: 'inherit',
  hook_agent: 'inherit',
}

const TIERS: ModelTierSlot[] = ['fast', 'balanced', 'best']

// ── Resolver matrix (custom config) ────────────────────────────────────────

/** `acme` has a full ladder whose `balanced` rung IS the parent model (so
 *  the "resolves to the parent" branch is exercised by a ladder, not only by
 *  a pin); `bare` declares no ladder at all. */
const CONFIG: NexusModelConfig = {
  providers: [
    {
      providerId: 'acme',
      models: [],
      fastModel: 'acme-mini',
      balancedModel: 'acme-parent',
      bestModel: 'acme-ultra',
    },
    { providerId: 'bare', models: [] },
  ],
}
const LADDER: Record<string, Partial<Record<ModelTierSlot, string>>> = {
  acme: { fast: 'acme-mini', balanced: 'acme-parent', best: 'acme-ultra' },
  bare: {},
}
const PARENTS = [
  { providerId: 'acme', modelId: 'acme-parent', label: 'laddered provider' },
  { providerId: 'bare', modelId: 'bare-parent', label: 'ladderless provider' },
]

const POLICIES: Array<{ label: string; policy: SessionModelPolicy | undefined }> = [
  { label: 'absent', policy: undefined },
  { label: 'explicit default', policy: { mode: 'default' } },
  { label: 'same-as-parent', policy: { mode: 'same-as-parent' } },
  {
    label: 'specific cross-provider',
    policy: {
      mode: 'specific',
      providerId: 'other',
      modelId: 'other-pin',
      thinkingTier: 'low',
    },
  },
  // Equal to the ACME parent (a different model when the parent is bare).
  {
    label: 'specific = acme parent',
    policy: { mode: 'specific', providerId: 'acme', modelId: 'acme-parent' },
  },
  ...TIERS.map(tier => ({
    label: `tier ${tier}`,
    policy: { mode: 'tier', tier } as SessionModelPolicy,
  })),
]

const DICTIONARIES: Array<{ label: string; tiers: NexusModelTiersSettings }> = [
  { label: 'no pins', tiers: {} },
  {
    label: 'fast pinned cross-provider',
    tiers: { fast: { providerId: 'dict', modelId: 'dict-fast' } },
  },
  {
    label: 'all pinned, with thinking tiers',
    tiers: {
      fast: { providerId: 'dict', modelId: 'dict-fast', thinkingTier: 'low' },
      balanced: { providerId: 'dict', modelId: 'dict-mid', thinkingTier: 'medium' },
      best: { providerId: 'dict', modelId: 'dict-best', thinkingTier: 'high' },
    },
  },
  // A pin that names the acme parent itself.
  {
    label: 'best pinned = acme parent',
    tiers: { best: { providerId: 'acme', modelId: 'acme-parent' } },
  },
]

const same = (a: Candidate, b: Candidate) =>
  a.providerId === b.providerId && a.modelId === b.modelId

/** Oracle: a tier through the dictionary. */
function expectTier(
  tier: ModelTierSlot,
  parent: Candidate,
  dict: NexusModelTiersSettings,
): Candidate[] {
  const pin = dict[tier]
  const ladder = LADDER[parent.providerId]?.[tier]
  const head: Candidate | undefined = pin
    ? {
        providerId: pin.providerId,
        modelId: pin.modelId,
        ...(pin.thinkingTier ? { thinkingTier: pin.thinkingTier } : {}),
      }
    : ladder
      ? { providerId: parent.providerId, modelId: ladder }
      : undefined
  if (!head || same(head, parent)) return [parent]
  return [head, parent]
}

/** Oracle: one kind under one policy. */
function expectRoute(
  kind: SessionModelPolicyType,
  policy: SessionModelPolicy | undefined,
  parent: Candidate,
  dict: NexusModelTiersSettings,
): Candidate[] {
  switch (policy?.mode) {
    case 'same-as-parent':
      return [parent]
    case 'specific': {
      const pin: Candidate = {
        providerId: policy.providerId,
        modelId: policy.modelId,
        ...(policy.thinkingTier ? { thinkingTier: policy.thinkingTier } : {}),
      }
      return same(pin, parent) ? [parent] : [pin, parent]
    }
    case 'tier':
      return expectTier(policy.tier, parent, dict)
    default: {
      const census = CENSUS[kind]
      return census === 'inherit' ? [parent] : expectTier(census, parent, dict)
    }
  }
}

function assertInvariants(got: Candidate[], parent: Candidate) {
  expect(got.length === 1 || got.length === 2).toBe(true)
  const last = got[got.length - 1]!
  expect(last).toEqual({ providerId: parent.providerId, modelId: parent.modelId })
  if (got.length === 2) expect(same(got[0]!, parent)).toBe(false)
}

const CASES = KINDS.flatMap(kind =>
  POLICIES.flatMap(p =>
    DICTIONARIES.flatMap(d =>
      PARENTS.map(parent => ({
        name: `${kind} | policy ${p.label} | ${d.label} | ${parent.label}`,
        kind,
        policy: p.policy,
        dict: d.tiers,
        parent: { providerId: parent.providerId, modelId: parent.modelId },
      })),
    ),
  ),
)

describe('getModelForSessionType — full matrix (kind × policy × dictionary × provider)', () => {
  it('covers the whole cartesian product', () => {
    expect(CASES).toHaveLength(
      KINDS.length * POLICIES.length * DICTIONARIES.length * PARENTS.length,
    )
  })

  it.each(CASES)('$name', ({ kind, policy, dict, parent }) => {
    setSessionModelSettingsSnapshot({
      modelTiers: dict,
      sessionModelPolicy: policy ? { [kind]: policy } : {},
    })
    const got = getModelForSessionType(
      kind as TierModelSessionType,
      parent.providerId,
      parent.modelId,
      CONFIG,
    )
    expect(got).toEqual(expectRoute(kind, policy, parent, dict))
    assertInvariants(got, parent)
  })
})

describe('getModelForSessionType — kinds are isolated from each other', () => {
  it('ten simultaneous distinct pins each reach only their own kind', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: Object.fromEntries(
        KINDS.map(kind => [
          kind,
          { mode: 'specific', providerId: 'pin', modelId: `pin-${kind}` },
        ]),
      ),
    })
    for (const kind of KINDS) {
      expect(
        getModelForSessionType(
          kind as TierModelSessionType,
          'acme',
          'acme-parent',
          CONFIG,
        )[0],
      ).toEqual({ providerId: 'pin', modelId: `pin-${kind}` })
    }
  })

  it('a policy on one kind never moves any other kind off its census default', () => {
    for (const routed of KINDS) {
      setSessionModelSettingsSnapshot({
        sessionModelPolicy: {
          [routed]: { mode: 'specific', providerId: 'pin', modelId: 'pin-x' },
        },
      })
      for (const other of KINDS) {
        if (other === routed) continue
        const parent = { providerId: 'acme', modelId: 'acme-parent' }
        expect(
          getModelForSessionType(
            other as TierModelSessionType,
            parent.providerId,
            parent.modelId,
            CONFIG,
          ),
        ).toEqual(expectRoute(other, undefined, parent, {}))
      }
    }
  })

  it('"other" (unattributed fast one-shots) is not routable by any policy', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: Object.fromEntries(
        KINDS.map(kind => [kind, { mode: 'same-as-parent' }]),
      ),
    })
    // Still the fast rung — no kind's policy leaks onto "other".
    expect(getModelForSessionType('other', 'acme', 'acme-parent', CONFIG)).toEqual([
      { providerId: 'acme', modelId: 'acme-mini' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
  })
})

// ── Agent tool matrix (shipped config; call-time tier axis) ───────────────

/** `resolveModelTier` reads the SHIPPED config: anthropic's ladder is
 *  fast=claude-haiku-4-5, balanced=claude-sonnet-5-5, best=claude-fable-5-1
 *  (asserted in nexus-model-config.test.ts); ollama has no ladder. The
 *  parent runs claude-sonnet-5-5, so `balanced` resolves to the parent. */
const SHIPPED_LADDER: Record<string, Partial<Record<ModelTierSlot, string>>> = {
  anthropic: {
    fast: 'claude-haiku-4-5',
    balanced: 'claude-sonnet-5-5',
    best: 'claude-fable-5-1',
  },
  ollama: {},
}
const AGENT_PARENTS = [
  { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', label: 'anthropic' },
  { providerId: 'ollama', modelId: 'llama3', label: 'ollama (no ladder)' },
]
const CALL_TIERS: Array<string | undefined> = [undefined, 'fast', 'balanced', 'best']
const AGENT_POLICIES = POLICIES.map(p =>
  p.label === 'specific = acme parent'
    ? {
        label: 'specific = anthropic parent',
        policy: {
          mode: 'specific',
          providerId: 'anthropic',
          modelId: 'claude-sonnet-5-5',
        } as SessionModelPolicy,
      }
    : p,
)
const AGENT_DICTIONARIES = DICTIONARIES.map(d =>
  d.label === 'best pinned = acme parent'
    ? {
        label: 'best pinned = anthropic parent',
        tiers: {
          best: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' },
        } as NexusModelTiersSettings,
      }
    : d,
)

/** Oracle for the Agent tool. `note` presence is asserted separately (its
 *  wording is not the contract; whether the model is told is). */
function expectAgent(
  callTier: string | undefined,
  policy: SessionModelPolicy | undefined,
  parent: Candidate,
  dict: NexusModelTiersSettings,
): { kind: TierResolution['kind']; target?: Candidate; noted: boolean } {
  if (policy?.mode === 'same-as-parent') {
    return { kind: 'parent', noted: !!callTier }
  }
  if (policy?.mode === 'specific') {
    const pin: Candidate = {
      providerId: policy.providerId,
      modelId: policy.modelId,
      ...(policy.thinkingTier ? { thinkingTier: policy.thinkingTier } : {}),
    }
    return same(pin, parent)
      ? { kind: 'parent', noted: !!callTier }
      : { kind: 'resolved', target: pin, noted: !!callTier }
  }
  // The call-time tier wins over the soft route; the soft route fills in.
  const tier = (callTier ??
    (policy?.mode === 'tier' ? policy.tier : undefined)) as
    | ModelTierSlot
    | undefined
  if (!tier) return { kind: 'none', noted: false }
  const pin = dict[tier]
  const ladder = SHIPPED_LADDER[parent.providerId]?.[tier]
  if (!pin && !ladder) return { kind: 'failed', noted: true }
  const head: Candidate = pin
    ? {
        providerId: pin.providerId,
        modelId: pin.modelId,
        ...(pin.thinkingTier ? { thinkingTier: pin.thinkingTier } : {}),
      }
    : { providerId: parent.providerId, modelId: ladder! }
  return same(head, parent)
    ? { kind: 'parent', noted: false }
    : { kind: 'resolved', target: head, noted: false }
}

const AGENT_CASES = CALL_TIERS.flatMap(callTier =>
  AGENT_POLICIES.flatMap(p =>
    AGENT_DICTIONARIES.flatMap(d =>
      AGENT_PARENTS.map(parent => ({
        name: `call tier ${callTier ?? 'none'} | policy ${p.label} | ${d.label} | ${parent.label}`,
        callTier,
        policy: p.policy,
        dict: d.tiers,
        parent: { providerId: parent.providerId, modelId: parent.modelId },
      })),
    ),
  ),
)

describe('resolveModelTier — full matrix (call tier × policy × dictionary × provider)', () => {
  it('covers the whole cartesian product', () => {
    expect(AGENT_CASES).toHaveLength(
      CALL_TIERS.length *
        AGENT_POLICIES.length *
        AGENT_DICTIONARIES.length *
        AGENT_PARENTS.length,
    )
  })

  it.each(AGENT_CASES)('$name', ({ callTier, policy, dict, parent }) => {
    setSessionModelSettingsSnapshot({
      modelTiers: dict,
      sessionModelPolicy: policy ? { agent_tool: policy } : {},
    })
    const got = resolveModelTier(callTier, parent.providerId, parent.modelId)
    const want = expectAgent(callTier, policy, parent, dict)
    expect(got.kind).toBe(want.kind)
    if (got.kind === 'resolved') {
      expect({
        providerId: got.providerId,
        modelId: got.modelId,
        ...(got.thinkingTier ? { thinkingTier: got.thinkingTier } : {}),
      }).toEqual(want.target)
    }
    const noted = 'note' in got && !!got.note
    expect(noted).toBe(want.noted)
  })
})
