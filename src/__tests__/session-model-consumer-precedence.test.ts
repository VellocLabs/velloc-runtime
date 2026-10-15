import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_WORKER_AGENT } from '../agents/builtInAgents'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import type { Message } from '../runtime/RuntimeTypes'
import { MSG_TYPE_ASSISTANT, ROLE_ASSISTANT } from '../runtime/VercelModelConstants'
import { queryFastModel } from '../models/fastModelCall'
import { runSkillInFork } from '../skillLibrary/executeForkedSkill'
import { askAboutPage } from '../toolkit/builtin/webFetch/fetchHelpers'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import * as forkedAgentModule from '../agents/forkedRun'
import { rememberForkPrefix } from '../agents/forkedRun'
import { createForkedAgentHookRunner } from '../lifecycleHooks/hookAgentRunner'
import {
  resetSessionModelSettingsSnapshot,
  setSessionModelSettingsSnapshot,
} from '../models/tierSettingsSnapshot'
import type {
  SessionModelPolicy,
  SessionModelPolicyType,
} from '../settings/settingsTypes'

/**
 * The feature-own model axis (a prompt or agent hook's `model:`, a forked skill's `model:`): with an absent /
 * default policy the feature's own `model:` wins (else the kind's census default); a tier / specific /
 * same-as-parent route wins over it. The Agent tool differs (session-model-routing-matrix.test.ts).
 */

const PARENT = { providerId: 'anthropic', modelId: 'claude-sonnet-5' }
// Shipped anthropic ladder (asserted in nexus-model-config.test.ts).
const HAIKU = 'claude-haiku-4-5'
const FABLE = 'claude-fable-5-1'
const OWN = 'feature-own-model'
const PIN = { providerId: 'pinned', modelId: 'pinned-model' }

const POLICIES: Array<{ label: string; policy: SessionModelPolicy | undefined }> = [
  { label: 'absent', policy: undefined },
  { label: 'default', policy: { mode: 'default' } },
  { label: 'tier best', policy: { mode: 'tier', tier: 'best' } },
  { label: 'specific', policy: { mode: 'specific', ...PIN } },
  { label: 'same-as-parent', policy: { mode: 'same-as-parent' } },
]

function route(kind: SessionModelPolicyType, policy: SessionModelPolicy | undefined) {
  setSessionModelSettingsSnapshot({
    sessionModelPolicy: policy ? { [kind]: policy } : {},
  })
}

afterEach(() => {
  resetSessionModelSettingsSnapshot()
  vi.restoreAllMocks()
})

// ── prompt_hook — queryFastModel with the hook's `model:` ──────────────────

function fastModelHarness() {
  const models: string[] = []
  const callModel = async function* (args: { modelOverride?: string }) {
    models.push(String(args.modelOverride))
    yield {
      type: MSG_TYPE_ASSISTANT,
      uuid: 'a',
      message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: '{"ok": true}' }] },
    } as unknown as Message
  }
  const toolUseContext = {
    options: {
      mainLoopProviderId: PARENT.providerId,
      mainLoopModel: PARENT.modelId,
      callModel,
      tools: [],
    },
    cancelSource: new AbortController(),
  } as unknown as ToolCallContext
  const run = (model: string | undefined) =>
    queryFastModel({
      systemPrompt: 'You are evaluating a hook in Nexus.',
      userPrompt: 'hook input',
      signal: toolUseContext.cancelSource.signal,
      toolUseContext,
      providerId: PARENT.providerId,
      querySource: 'fast_model_call',
      ...(model ? { model } : {}),
    })
  return { models, run }
}

describe('prompt_hook — hook `model:` × policy', () => {
  const EXPECT: Record<string, { withOwn: string; withoutOwn: string }> = {
    absent: { withOwn: OWN, withoutOwn: HAIKU },
    default: { withOwn: OWN, withoutOwn: HAIKU },
    'tier best': { withOwn: FABLE, withoutOwn: FABLE },
    specific: { withOwn: PIN.modelId, withoutOwn: PIN.modelId },
    'same-as-parent': { withOwn: PARENT.modelId, withoutOwn: PARENT.modelId },
  }

  it.each(POLICIES)('policy $label', async ({ label, policy }) => {
    route('prompt_hook', policy)
    const withOwn = fastModelHarness()
    await withOwn.run(OWN)
    expect(withOwn.models).toEqual([EXPECT[label]!.withOwn])

    const withoutOwn = fastModelHarness()
    await withoutOwn.run(undefined)
    expect(withoutOwn.models).toEqual([EXPECT[label]!.withoutOwn])
  })
})

// ── hook_agent — the verifier fork ────────────────────────────────────────

type ForkArgs = {
  modelLadder?: Array<{ providerId: string; modelId: string }>
  overrides?: { options?: { mainLoopModel?: string } }
}

/** What model the fork will run on: a policy route rides `modelLadder`
 *  (head = the model), a feature-own model rides the options override,
 *  neither = the parent (inherit). */
function forkModel(arg: ForkArgs): string {
  if (arg.modelLadder?.length) return arg.modelLadder[0]!.modelId
  return arg.overrides?.options?.mainLoopModel ?? PARENT.modelId
}

function stubFork() {
  rememberForkPrefix({
    toolUseContext: {
      options: {
        tools: [],
        mainLoopModel: PARENT.modelId,
        mainLoopProviderId: PARENT.providerId,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  const spy = vi.spyOn(forkedAgentModule, 'launchFork')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spy.mockResolvedValue({ messages: [], agentId: 'fork-1' } as any)
  return spy
}

/** Fork-backed kinds default to inherit, so without an own model every
 *  soft case lands on the parent. */
const FORK_EXPECT: Record<string, { withOwn: string; withoutOwn: string }> = {
  absent: { withOwn: OWN, withoutOwn: PARENT.modelId },
  default: { withOwn: OWN, withoutOwn: PARENT.modelId },
  'tier best': { withOwn: FABLE, withoutOwn: FABLE },
  specific: { withOwn: PIN.modelId, withoutOwn: PIN.modelId },
  'same-as-parent': { withOwn: PARENT.modelId, withoutOwn: PARENT.modelId },
}

describe('hook_agent — hook `model:` × policy', () => {
  beforeEach(() => {
    rememberForkPrefix(null)
  })

  it.each(POLICIES)('policy $label', async ({ label, policy }) => {
    route('hook_agent', policy)
    const context = {
      options: { sessionId: 's' },
    } as unknown as ToolCallContext
    for (const [own, want] of [
      [OWN, FORK_EXPECT[label]!.withOwn],
      [undefined, FORK_EXPECT[label]!.withoutOwn],
    ] as const) {
      const spy = stubFork()
      await createForkedAgentHookRunner(context)({
        prompt: 'verify',
        systemPrompt: 'You are verifying a hook condition in Nexus.',
        ...(own ? { model: own } : {}),
        signal: new AbortController().signal,
      })
      expect(forkModel(spy.mock.calls[0]![0] as ForkArgs)).toBe(want)
      spy.mockRestore()
    }
  })
})

// ── skill_fork — frontmatter `model:` ──────────────────────────────────────

function skillCommand(model: string | undefined): ChromiumPromptCommand {
  return {
    type: 'prompt',
    name: 'forky',
    description: 'A forked skill',
    content: 'fork body',
    path: '/skills/forky/SKILL.md',
    loadedFrom: 'skills',
    source: 'project',
    context: 'fork',
    ...(model ? { model } : {}),
  }
}

describe('skill_fork — frontmatter `model:` × policy', () => {
  it.each(POLICIES)('policy $label', async ({ label, policy }) => {
    route('skill_fork', policy)
    for (const [own, want] of [
      [OWN, FORK_EXPECT[label]!.withOwn],
      [undefined, FORK_EXPECT[label]!.withoutOwn],
      // `model: inherit` means "no own model" — never a model literally
      // named "inherit".
      ['inherit', FORK_EXPECT[label]!.withoutOwn],
    ] as const) {
      const spy = stubFork()
      await runSkillInFork({
        command: skillCommand(own),
        body: 'expanded body',
        args: undefined,
        context: {
          options: {
            sessionId: 'sess-fork',
            agentDefinitions: { enabledAgents: [DEFAULT_WORKER_AGENT] },
          },
          agentId: null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as any,
      })
      expect(
        forkModel(spy.mock.calls[0]![0] as ForkArgs),
        `own model ${own ?? '(none)'}`,
      ).toBe(want)
      spy.mockRestore()
    }
  })
})

// ── web_fetch — WebFetch's secondary pass ────────────────────────────────
//
// Wiring only: WebFetch always upgrades http→https, and the e2e harness has
// no https content server, so this kind cannot be driven end-to-end today
// (the e2e wiring matrix covers the other nine). This pins that the real
// WebFetch helper reaches the resolver AS `web_fetch`, obeys its policy, and
// retries a failing pin on the session model.

describe('web_fetch — the WebFetch summarizer follows its own policy', () => {
  const run = async (fail?: string) => {
    const models: string[] = []
    const callModel = async function* (args: { modelOverride?: string }) {
      models.push(String(args.modelOverride))
      if (fail && args.modelOverride === fail) throw new Error('model not found')
      yield {
        type: MSG_TYPE_ASSISTANT,
        uuid: 'a',
        message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'summary' }] },
      } as unknown as Message
    }
    const context = {
      options: {
        mainLoopProviderId: PARENT.providerId,
        mainLoopModel: PARENT.modelId,
        callModel,
        tools: [],
      },
      cancelSource: new AbortController(),
    } as unknown as ToolCallContext
    const answer = await askAboutPage(
      'what is on the page?',
      '# Page\n\nbody',
      context.cancelSource.signal,
      false,
      context,
      PARENT.providerId,
    )
    return { models, answer }
  }

  it('census default: the Fast tier', async () => {
    expect((await run()).models).toEqual([HAIKU])
  })

  it('a web_fetch route is honored — and a route on another kind is not', async () => {
    route('web_fetch', { mode: 'specific', ...PIN })
    expect((await run()).models).toEqual([PIN.modelId])
    route('session_title', { mode: 'specific', ...PIN })
    expect((await run()).models).toEqual([HAIKU])
    route('web_fetch', { mode: 'same-as-parent' })
    expect((await run()).models).toEqual([PARENT.modelId])
  })

  it('a failing pin is retried once on the session model', async () => {
    route('web_fetch', { mode: 'specific', ...PIN })
    const { models, answer } = await run(PIN.modelId)
    expect(models).toEqual([PIN.modelId, PARENT.modelId])
    expect(answer).toBe('summary')
  })
})
