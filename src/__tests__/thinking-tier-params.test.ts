import { describe, expect, it } from 'vitest'
import { buildThinkingBodyExtension } from '../config/nexusModelConfig/thinkingTierParams'

describe('buildThinkingBodyExtension', () => {
  it('returns undefined when tier or provider is missing', () => {
    expect(buildThinkingBodyExtension(undefined, 'medium', 8192)).toBeUndefined()
    expect(buildThinkingBodyExtension('anthropic', undefined, 8192)).toBeUndefined()
    expect(buildThinkingBodyExtension(undefined, undefined, 8192)).toBeUndefined()
  })

  describe('anthropic — adaptive thinking', () => {
    // Newer Claude models take `thinking.type.adaptive` + `output_config.effort`, not the legacy
    // `thinking: { type: 'enabled', budget_tokens }`. The popup label `extra-high` is our spelling of `xhigh`.
    it.each([
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['extra-high', 'xhigh'],
      ['max', 'max'],
    ])('emits adaptive thinking with effort=%s for tier %s', (tier, effort) => {
      expect(buildThinkingBodyExtension('anthropic', tier, 8192)).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort },
      })
    })

    it('does NOT emit the deprecated enabled+budget_tokens shape', () => {
      // Regression guard for the user-reported bug. If this assertion fails
      // because someone reintroduced `type: 'enabled'`, Anthropic's API
      // will reject every Opus 4.7 / Haiku 4.5 turn.
      const body = buildThinkingBodyExtension('anthropic', 'high', 32_000)
      expect(body).toBeDefined()
      expect(body!.thinking).not.toMatchObject({ type: 'enabled' })
      expect(body).not.toHaveProperty('budget_tokens')
      expect(body).not.toHaveProperty('max_tokens')
      expect(body).not.toHaveProperty('temperature')
    })

    it('returns undefined for an unknown tier name', () => {
      expect(buildThinkingBodyExtension('anthropic', 'turbo', 8192))
        .toBeUndefined()
    })
  })

  describe('openai — reasoning_effort', () => {
    // The mapper does not gate per model (`availableThinkingTiers` does); it spells out every tier label this codebase
    // produces, and `max` passes through verbatim.
    it.each([
      ['none', 'none'],
      ['minimal', 'minimal'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['extra-high', 'xhigh'],
      ['xhigh', 'xhigh'],
      ['max', 'max'],
    ])('maps tier %s to reasoning_effort=%s', (tier, effort) => {
      expect(buildThinkingBodyExtension('openai', tier, 8192)).toEqual({
        reasoning_effort: effort,
      })
    })

    it('returns undefined for an unknown tier name', () => {
      expect(buildThinkingBodyExtension('openai', 'turbo', 8192))
        .toBeUndefined()
    })
  })

  describe('chatgpt-pro — Codex reasoning vocabulary', () => {
    // Live-verified (live-model-verification.spec.ts): the
    // Codex backend accepts low..xhigh plus `max` (in practice), so the
    // openai mapper's historical `max → high` downgrade must NOT apply —
    // a user's explicit MAX pick would be silently lowered. Regression:
    // this provider previously fell through the mapper entirely, so
    // picked tiers never reached the wire.
    it.each([
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['extra-high', 'xhigh'],
      ['xhigh', 'xhigh'],
      ['max', 'max'],
    ])('maps tier %s to reasoning_effort=%s', (tier, effort) => {
      expect(buildThinkingBodyExtension('chatgpt-pro', tier, 8192)).toEqual({
        reasoning_effort: effort,
      })
    })

    it('returns undefined for efforts Codex rejects on the wire', () => {
      // `ultra` is advertised in the bundled Codex catalog but REJECTED as
      // a reasoning effort ("Invalid value: 'ultra'", live-verified) — a
      // stale persisted `ultra` must be dropped, not forwarded.
      expect(buildThinkingBodyExtension('chatgpt-pro', 'ultra', 8192))
        .toBeUndefined()
      // `minimal`/`none` belong to public-API rows; same treatment.
      expect(buildThinkingBodyExtension('chatgpt-pro', 'minimal', 8192))
        .toBeUndefined()
      expect(buildThinkingBodyExtension('chatgpt-pro', 'none', 8192))
        .toBeUndefined()
    })
  })

  describe('deepseek — thinking toggle + reasoning_effort compat collapsing', () => {
    // DeepSeek's real effort levels are `low`/`high`/`max` (the
    // V4-Pro update made `low` its own level; before that the vendor folded
    // it into `high`, and so did this map — a `low` pick used to go out as
    // `high`). The vendor still folds medium→high and xhigh→high for
    // compatibility; the mapper sends `max` for the top pills instead so
    // they never fold DOWN. Regression: deepseek previously fell through the
    // mapper entirely — tier pills were cosmetic and never reached the wire.
    it.each([
      ['low', 'low'],
      ['medium', 'high'],
      ['high', 'high'],
      ['extra-high', 'max'],
      ['xhigh', 'max'],
      ['max', 'max'],
    ])('maps tier %s to reasoning_effort=%s', (tier, effort) => {
      expect(buildThinkingBodyExtension('deepseek', tier, 8192)).toEqual({
        reasoning_effort: effort,
      })
    })

    it('maps `none` to the thinking toggle, NOT reasoning_effort', () => {
      // Live-verified: `reasoning_effort: 'none'` is rejected
      // ("unknown variant `none`"); disabling thinking rides the separate
      // `thinking.type` knob per the vendor thinking-mode guide.
      expect(buildThinkingBodyExtension('deepseek', 'none', 8192)).toEqual({
        thinking: { type: 'disabled' },
      })
    })

    it('returns undefined for unknown tier names', () => {
      expect(buildThinkingBodyExtension('deepseek', 'ultra', 8192))
        .toBeUndefined()
    })
  })

  describe('kimi — K3 reasoning_effort alias mapping', () => {
    // Kimi K3 / K2.8 (Kimi Code endpoint). Every non-highspeed row accepts
    // low/high/max (K3 used to accept only `max`), and the
    // endpoint MAPS a few tier aliases per the model docs
    // (https://www.kimi.com/code/docs/kimi-code/models.html):
    //   ultra/max/xhigh -> max,  high/medium -> high,  low/minimum/light -> low.
    // `none` disables thinking via the `thinking.type` knob (no effort variant).
    it.each([
      ['low', 'low'],
      ['medium', 'high'],
      ['high', 'high'],
      ['extra-high', 'max'],
      ['xhigh', 'max'],
      ['ultra', 'max'],
      ['max', 'max'],
    ])('maps tier %s to reasoning_effort=%s', (tier, effort) => {
      expect(buildThinkingBodyExtension('kimi', tier, 8192)).toEqual({
        reasoning_effort: effort,
      })
    })

    it('maps `none` to the thinking toggle, NOT reasoning_effort', () => {
      expect(buildThinkingBodyExtension('kimi', 'none', 8192)).toEqual({
        thinking: { type: 'disabled' },
      })
    })

    it('returns undefined for unknown tier names (the endpoint 400s them)', () => {
      expect(buildThinkingBodyExtension('kimi', 'turbo', 8192)).toBeUndefined()
    })
  })

  describe('google — Gemini thinkingLevel', () => {
    it.each([
      ['minimal', 'minimal'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['extra-high', 'high'],
      ['max', 'high'],
    ])('maps tier %s to thinkingLevel=%s', (tier, level) => {
      expect(buildThinkingBodyExtension('google', tier, 8192)).toEqual({
        generationConfig: { thinkingConfig: { thinkingLevel: level } },
      })
    })

    it('sends nothing for `none` (Gemini thinking cannot be switched off) or an unknown tier', () => {
      expect(buildThinkingBodyExtension('google', 'none', 8192)).toBeUndefined()
      expect(buildThinkingBodyExtension('google', 'turbo', 8192)).toBeUndefined()
    })
  })

  describe('glm — no tier mapping (binary thinking handled by model)', () => {
    // GLM-4.6's `thinking.type` is binary (enabled/disabled) with no
    // effort gradient, and the model ships with hybrid thinking on by
    // default. The catalog no longer surfaces tier pills for GLM, so the
    // wire mapper must not emit a `thinking` block for any tier — the
    // model's own heuristic decides.
    it.each(['low', 'medium', 'high'])(
      'returns undefined for tier %s',
      tier => {
        expect(buildThinkingBodyExtension('glm', tier, 8192)).toBeUndefined()
      },
    )
  })

  describe('qwen — DashScope enable_thinking + budget', () => {
    // The gateway requires max_completion_tokens (== maxOutputTokens on
    // the wire) to be STRICTLY GREATER than thinking_budget — verified
    // live. maxOutputTokens=65_536 here keeps every tier
    // budget below the clamp so the raw table values pass through.
    it.each([
      ['low', 2048],
      ['medium', 8192],
      ['high', 32_768],
      // The current-generation catalog (qwen3.8-max)
      // surfaces a `max` pill; it must map to the top budget, NOT fall
      // through to undefined (which would silently send no thinking params).
      ['max', 32_768],
    ])(
      'emits enable_thinking + budget=%i for tier %s',
      (tier, budget) => {
        expect(buildThinkingBodyExtension('qwen', tier, 65_536)).toEqual({
          enable_thinking: true,
          thinking_budget: budget,
        })
      },
    )

    it('clamps the budget to at most half of maxOutputTokens', () => {
      // Regression: the gateway RESERVES thinking_budget out of
      // max_completion_tokens — budget = max−1 truncated content at ~50
      // tokens (finish_reason=length), which
      // the agent loop auto-continued into an endless repetition loop.
      // Halving the envelope keeps ≥ half for content (verified healthy
      // on the live endpoint).
      expect(buildThinkingBodyExtension('qwen', 'max', 16_384)).toEqual({
        enable_thinking: true,
        thinking_budget: 8192,
      })
      expect(buildThinkingBodyExtension('qwen', 'high', 16_384)).toEqual({
        enable_thinking: true,
        thinking_budget: 8192,
      })
      // Budgets already below half the cap pass through unchanged.
      expect(buildThinkingBodyExtension('qwen', 'low', 16_384)).toEqual({
        enable_thinking: true,
        thinking_budget: 2048,
      })
    })

    it('drops the budget when there is no room below the cap', () => {
      // maxOutputTokens <= 1 leaves no positive budget; the endpoint
      // accepts a bare enable_thinking toggle (model-default budget).
      expect(buildThinkingBodyExtension('qwen', 'max', 1)).toEqual({
        enable_thinking: true,
      })
    })

    it('maps `none` to the enable_thinking toggle, NOT a budget', () => {
      // Valid only for models that accept the toggle (qwen3.6-flash —
      // live-verified). qwen3.8-max
      // REJECTS `enable_thinking: false` ("restricted to True"), so its
      // catalog entry never offers a `none` pill (guarded in
      // nexus-model-config.test.ts) and a stale persisted `none` is
      // dropped by the deps.ts availableTiers gate before this mapper.
      expect(buildThinkingBodyExtension('qwen', 'none', 8192)).toEqual({
        enable_thinking: false,
      })
    })

    it('returns undefined for unknown tier names', () => {
      expect(buildThinkingBodyExtension('qwen', 'extra-high', 8192))
        .toBeUndefined()
    })
  })

  it('returns undefined for unsupported providers', () => {
    expect(buildThinkingBodyExtension('ollama', 'medium', 8192)).toBeUndefined()
    // kimi now has a K3 alias mapping (see its describe block above) — it is
    // no longer an "unsupported" pass-through provider.
    expect(buildThinkingBodyExtension('minimax', 'medium', 8192))
      .toBeUndefined()
    expect(buildThinkingBodyExtension('glm', 'medium', 8192)).toBeUndefined()
  })
})
