// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'

import { SessionModelsSection } from '../browser/webview/settings/sections/SessionModelsSection'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserLlmCatalog } from '../browser/bridge/protocol/nexus_llm'
import type { SessionModelsFieldValues } from '../browser/bridge/protocol/sessionModels'

/**
 * SessionModelsSection, through the rendered component: one quick-picker control per row showing the resolved
 * result; tier rows count their features; per-feature routing under "Advanced options"; the picker's patches and
 * per-row reset; contextual notes only where they apply; "Reset all" only while modified, confirm-gated, clearing
 * both sections.
 */

const EMPTY: SessionModelsFieldValues = {
  modelTiers: {},
  sessionModelPolicy: {},
}

/** Two enabled (verified) providers with pickable models (default selection
 *  = anthropic's fable, so "Auto" resolves on the anthropic ladder: fast →
 *  claude-haiku-4-5, balanced → claude-sonnet-5), plus one fully disabled
 *  provider. */
const CATALOG: BrowserLlmCatalog = {
  providers: [
    {
      id: 'anthropic',
      label: 'Anthropic',
      iconSvg: '<svg />',
      enabled: true,
      defaultModelId: 'claude-fable-5',
      models: [
        { id: 'claude-fable-5', label: 'Fable 5', enabled: true },
        { id: 'claude-sonnet-5', label: 'Sonnet 5', enabled: true },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', enabled: true },
      ],
    },
    {
      id: 'google',
      label: 'Google',
      iconSvg: '<svg />',
      enabled: true,
      defaultModelId: 'gemini-flash',
      models: [{ id: 'gemini-flash', label: 'Gemini Flash', enabled: true }],
    },
    {
      id: 'openai',
      label: 'OpenAI',
      iconSvg: '<svg />',
      enabled: false,
      defaultModelId: 'gpt-x',
      models: [{ id: 'gpt-x', label: 'GPT X', enabled: true }],
    },
  ],
  defaultSelection: { providerId: 'anthropic', modelId: 'claude-fable-5' },
}

function makeBridge(
  initial: SessionModelsFieldValues = EMPTY,
  pinHealth: Record<string, unknown> = {
    modelTiers: {},
    sessionModelPolicy: {},
  },
  /** What the runtime answers `sessionModels/autoTiers` with (the model Auto
   *  runs each tier on, where it is not the session's own). */
  autoTiers: Record<string, { modelId: string; label?: string }> = {},
) {
  const autoTierCalls: Array<Record<string, unknown>> = []
  let values: SessionModelsFieldValues = {
    modelTiers: { ...initial.modelTiers },
    sessionModelPolicy: { ...initial.sessionModelPolicy },
  }
  const setFieldCalls: Array<Record<string, unknown>> = []
  const bridge = {
    request: vi.fn(
      async (
        route: { action: string },
        payload: { patch?: Record<string, unknown> },
      ) => {
        if (route.action === 'snapshot') {
          return { values: { ...values }, source: 'default', pinHealth }
        }
        if (route.action === 'autoTiers') {
          autoTierCalls.push(payload as Record<string, unknown>)
          return { tiers: autoTiers }
        }
        // setField — apply the same merge/clear semantics as the adapter.
        const patch = (payload.patch ?? {}) as {
          modelTiers?: Record<string, unknown>
          sessionModelPolicy?: Record<string, unknown>
        }
        setFieldCalls.push(patch)
        if (patch.modelTiers) {
          const tiers = { ...values.modelTiers } as Record<string, unknown>
          for (const [k, v] of Object.entries(patch.modelTiers)) {
            if (v === null) delete tiers[k]
            else tiers[k] = v
          }
          values = {
            ...values,
            modelTiers: tiers as SessionModelsFieldValues['modelTiers'],
          }
        }
        if (patch.sessionModelPolicy) {
          const pol = { ...values.sessionModelPolicy } as Record<
            string,
            unknown
          >
          for (const [k, v] of Object.entries(patch.sessionModelPolicy)) {
            if (v === null) delete pol[k]
            else pol[k] = v
          }
          values = {
            ...values,
            sessionModelPolicy:
              pol as SessionModelsFieldValues['sessionModelPolicy'],
          }
        }
        return { ok: true, values: { ...values } }
      },
    ),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
  return { bridge, setFieldCalls, autoTierCalls }
}

function renderSection(
  bridge: NexusSettingsBridge,
  catalog: BrowserLlmCatalog | null = CATALOG,
) {
  return render(
    createElement(
      SettingsBridgeContext.Provider,
      { value: bridge },
      createElement(SessionModelsSection, { catalog }),
    ),
  )
}

const trigger = (prefix: string) =>
  screen.getByTestId(`${prefix}-model-picker-trigger`)

/** Open a row's picker and click one of its leading options. */
async function pickOption(prefix: string, optionTestId: string) {
  fireEvent.click(trigger(prefix))
  fireEvent.click(await screen.findByTestId(optionTestId))
}

/** Close a row's open picker with Escape, and wait until the close has
 *  finished: Radix hands focus back to the trigger on a deferred
 *  `setTimeout(0)`. Opening ANOTHER row's picker before that lands lets the
 *  late focus move read as a focus-outside of the new popover, which then
 *  dismisses itself — and a click on its option is lost. */
async function closeMenu(prefix: string) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  await waitFor(() => {
    expect(document.activeElement).toBe(trigger(prefix))
  })
}

async function expandAdvanced() {
  fireEvent.click(await screen.findByTestId('session-models-advanced-toggle'))
  await waitFor(() => {
    expect(advancedState()).toBe('open')
  })
}

/** Radix keeps the content element while closed (`data-state="closed"`,
 *  children unmounted), so state — not presence — is the observable. */
const advancedState = () =>
  screen.queryByTestId('session-models-advanced')?.getAttribute('data-state') ??
  null

afterEach(() => {
  cleanup()
})

describe('SessionModelsSection', () => {
  it('shows resolved values: Auto tiers with usage counts, advanced collapsed, no reset-all', async () => {
    const { bridge } = makeBridge()
    renderSection(bridge)

    // Auto follows the session's provider, so the row names no model — a
    // name here read as a fixed pick and went stale on a provider switch.
    await screen.findByTestId('session-models-tier-fast')
    for (const slot of ['fast', 'balanced']) {
      const text = trigger(`session-models-tier-${slot}`).textContent
      expect(text).toContain('Auto · follows session')
      expect(text).not.toContain('Haiku')
      expect(text).not.toContain('Sonnet')
    }
    for (const slot of ['fast', 'balanced', 'best']) {
      expect(
        screen
          .getByTestId(`session-models-tier-${slot}`)
          .getAttribute('data-modified'),
      ).toBe('false')
      expect(screen.queryByTestId(`session-models-tier-${slot}-reset`)).toBeNull()
    }
    // Usage counts follow the census: fast ← title, web fetch, prompt hook;
    // balanced ← recall selection; best ← nothing by default, so it says nothing.
    expect(
      screen.getByTestId('session-models-tier-fast-used-by').textContent,
    ).toContain('3')
    expect(
      screen.getByTestId('session-models-tier-balanced-used-by').textContent,
    ).toContain('1')
    expect(screen.queryByTestId('session-models-tier-best-used-by')).toBeNull()

    // Nothing modified: no Reset all, no count, a quiet hint instead of a
    // standing warning banner.
    expect(screen.queryByTestId('session-models-reset-all')).toBeNull()
    expect(screen.queryByTestId('session-models-modified-count')).toBeNull()
    expect(screen.getByTestId('session-models-hint')).toBeTruthy()

    // Per-feature routing is collapsed by default.
    expect(advancedState()).toBe('closed')
    expect(
      screen.queryByTestId('session-models-route-compact-model-picker-trigger'),
    ).toBeNull()

    // Expanded, every feature row shows what its Default resolves to — the
    // tier alone while that tier is on Auto.
    await expandAdvanced()
    expect(
      trigger('session-models-route-session_title').textContent,
    ).toBe('Fast')
    expect(
      trigger('session-models-route-memory_recall').textContent,
    ).toBe('Balanced')
    expect(trigger('session-models-route-compact').textContent).toContain(
      'Session model',
    )
    expect(trigger('session-models-route-agent_tool').textContent).toContain(
      'Per task',
    )
    expect(trigger('session-models-route-prompt_hook').textContent).toContain(
      'Per hook',
    )
    expect(trigger('session-models-route-skill_fork').textContent).toContain(
      'Per skill',
    )
  })

  it("Auto's option names the model the RUNTIME resolves for the default selection (a gateway's borrowed ladder)", async () => {
    // A gateway declares no ladder; the page cannot work one out — the
    // borrowed ladder searches the gateway's whole listing, which only the
    // runtime holds. It asks, with the default selection, and shows the
    // answer: by the catalog's label when the model is a row, else by the
    // name the runtime sends, else by its id.
    const catalog: BrowserLlmCatalog = {
      providers: [{
        id: 'openrouter',
        label: 'OpenRouter',
        iconSvg: '<svg />',
        enabled: true,
        defaultModelId: 'anthropic/claude-opus-*@latest',
        models: [
          { id: 'anthropic/claude-opus-*@latest', label: 'Claude Opus', enabled: true, availableThinkingTiers: ['low', 'high'] },
          { id: 'anthropic/claude-fable-5.1', label: 'Claude Fable 5.1', enabled: true },
        ],
      }],
      defaultSelection: { providerId: 'openrouter', modelId: 'anthropic/claude-opus-*@latest' },
    }
    const { bridge, autoTierCalls, setFieldCalls } = makeBridge(undefined, undefined, {
      fast: { modelId: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' }, // not a catalog row
      best: { modelId: 'anthropic/claude-fable-5.1' }, // a catalog row
      // balanced: absent — the session's own model
    })
    renderSection(bridge, catalog)
    await screen.findByTestId('session-models-tier-fast')
    await waitFor(() => expect(autoTierCalls).toEqual([
      { providerId: 'openrouter', modelId: 'anthropic/claude-opus-*@latest' },
    ]))
    const autoText = async (slot: string) => {
      fireEvent.click(trigger(`session-models-tier-${slot}`))
      const text = (await screen.findByTestId(`session-models-tier-${slot}-auto`)).textContent
      await closeMenu(`session-models-tier-${slot}`)
      return text
    }
    await waitFor(async () => expect(await autoText('fast')).toContain('default: Claude Haiku 4.5'))
    expect(await autoText('best')).toContain('default: Claude Fable 5.1')
    // The tier the runtime left out reads as before: the session model at
    // the tier's effort.
    expect(await autoText('balanced')).toContain('default: Session model (')
    // Asking is a read: nothing was written.
    expect(setFieldCalls).toEqual([])
  })

  it("Auto's option names the default provider's model as an example; a pin is named on every row", async () => {
    const { bridge } = makeBridge({
      modelTiers: {
        balanced: { providerId: 'anthropic', modelId: 'claude-fable-5' },
      },
      sessionModelPolicy: {},
    })
    renderSection(bridge)
    await screen.findByTestId('session-models-tier-fast')

    // The Auto option says what it depends on, and what it means today.
    fireEvent.click(trigger('session-models-tier-fast'))
    expect(
      (await screen.findByTestId('session-models-tier-fast-auto')).textContent,
    ).toContain("Follows the session's provider · default: Haiku 4.5")
    await closeMenu('session-models-tier-fast')

    // A pinned tier is a fixed choice: named on its row and on the feature
    // rows that draw from it.
    expect(trigger('session-models-tier-balanced').textContent).toContain(
      'Fable 5',
    )
    await expandAdvanced()
    expect(
      trigger('session-models-route-memory_recall').textContent,
    ).toContain('Balanced · Fable 5')
  })

  it('a tier row pins a model from its picker, and Auto / the row reset clear it', async () => {
    const { bridge, setFieldCalls } = makeBridge()
    renderSection(bridge)
    await screen.findByTestId('session-models-tier-fast')

    fireEvent.click(trigger('session-models-tier-fast'))
    fireEvent.click(
      await screen.findByTestId(
        'session-models-tier-fast-model-option-anthropic-claude-fable-5',
      ),
    )
    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({
        modelTiers: {
          fast: { providerId: 'anthropic', modelId: 'claude-fable-5' },
        },
      })
    })
    await waitFor(() => {
      expect(
        screen
          .getByTestId('session-models-tier-fast')
          .getAttribute('data-modified'),
      ).toBe('true')
    })
    expect(trigger('session-models-tier-fast').textContent).toContain('Fable 5')
    // Something is modified → Reset all + the count appear.
    expect(screen.getByTestId('session-models-reset-all')).toBeTruthy()
    expect(
      screen.getByTestId('session-models-modified-count').textContent,
    ).toContain('1')

    // The "Auto" option clears the pin.
    await pickOption('session-models-tier-fast', 'session-models-tier-fast-auto')
    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({ modelTiers: { fast: null } })
    })

    // Pin again, then the per-row reset clears it.
    fireEvent.click(trigger('session-models-tier-best'))
    fireEvent.click(
      await screen.findByTestId(
        'session-models-tier-best-model-option-anthropic-claude-haiku-4-5',
      ),
    )
    fireEvent.click(await screen.findByTestId('session-models-tier-best-reset'))
    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({ modelTiers: { best: null } })
    })
  })

  it('an existing routing override opens Advanced on load and is shown as modified', async () => {
    const { bridge } = makeBridge({
      modelTiers: {},
      sessionModelPolicy: {
        session_title: { mode: 'tier', tier: 'balanced' },
        web_fetch: { mode: 'same-as-parent' },
      },
    })
    renderSection(bridge)

    // Opened without a click — an override never hides.
    await waitFor(() => {
      expect(advancedState()).toBe('open')
    })
    expect(
      screen.getByTestId('session-models-advanced-summary').textContent,
    ).toContain('2')
    const title = screen.getByTestId('session-models-route-session_title')
    expect(title.getAttribute('data-modified')).toBe('true')
    expect(trigger('session-models-route-session_title').textContent).toBe(
      'Balanced',
    )
    expect(trigger('session-models-route-web_fetch').textContent).toContain(
      'Same as session',
    )
    // The rerouted title no longer counts toward fast; it counts toward
    // balanced (with recall selection). web_fetch left fast too.
    expect(
      screen.getByTestId('session-models-tier-fast-used-by').textContent,
    ).toContain('1')
    expect(
      screen.getByTestId('session-models-tier-balanced-used-by').textContent,
    ).toContain('2')
  })

  it('a stored {mode:"default"} is not an override', async () => {
    const { bridge } = makeBridge({
      modelTiers: {},
      sessionModelPolicy: { compact: { mode: 'default' } },
    })
    renderSection(bridge)
    await screen.findByTestId('session-models-tier-fast')
    expect(advancedState()).toBe('closed')
    expect(screen.queryByTestId('session-models-reset-all')).toBeNull()
  })

  it('feature-row options write default / same-as-parent / tier / specific patches', async () => {
    const { bridge, setFieldCalls } = makeBridge()
    renderSection(bridge)
    await expandAdvanced()

    // Default already inherits the session model for compact, so "Same as
    // session" is not listed twice; a fast-tier default keeps it.
    fireEvent.click(trigger('session-models-route-compact'))
    await screen.findByTestId('session-models-route-compact-option-default')
    expect(
      screen.queryByTestId('session-models-route-compact-option-same-as-parent'),
    ).toBeNull()
    await closeMenu('session-models-route-compact')

    const p = 'session-models-route-session_title'
    await pickOption(p, `${p}-option-tier-best`)
    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({
        sessionModelPolicy: { session_title: { mode: 'tier', tier: 'best' } },
      })
    })
    await pickOption(p, `${p}-option-same-as-parent`)
    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({
        sessionModelPolicy: { session_title: { mode: 'same-as-parent' } },
      })
    })
    fireEvent.click(trigger(p))
    fireEvent.click(
      await screen.findByTestId(`${p}-model-option-anthropic-claude-sonnet-5`),
    )
    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({
        sessionModelPolicy: {
          session_title: {
            mode: 'specific',
            providerId: 'anthropic',
            modelId: 'claude-sonnet-5',
          },
        },
      })
    })
    await waitFor(() => {
      expect(trigger(p).textContent).toContain('Sonnet 5')
    })
    await pickOption(p, `${p}-option-default`)
    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({
        sessionModelPolicy: { session_title: null },
      })
    })
  })

  it('a row menu opens below its trigger, or above it when the room is below-short', async () => {
    const { bridge } = makeBridge()
    renderSection(bridge)
    await screen.findByTestId('session-models-tier-fast')
    const menuSide = async (optionTestId: string) =>
      (await screen.findByTestId(optionTestId))
        .closest('[data-slot="popover-content"]')
        ?.getAttribute('data-side-anchored')

    // Plenty of room below → below.
    fireEvent.click(trigger('session-models-tier-fast'))
    expect(await menuSide('session-models-tier-fast-auto')).toBe('bottom')
    fireEvent.click(trigger('session-models-tier-fast'))

    // A trigger near the window's bottom edge → above, never over it.
    const t = trigger('session-models-tier-best')
    t.getBoundingClientRect = () =>
      ({
        top: window.innerHeight - 60,
        bottom: window.innerHeight - 28,
        left: 0,
        right: 200,
        width: 200,
        height: 32,
        x: 0,
        y: window.innerHeight - 60,
        toJSON: () => ({}),
      }) as DOMRect
    fireEvent.click(t)
    expect(await menuSide('session-models-tier-best-auto')).toBe('top')
  })

  it('a weak tier under a quality-sensitive feature warns on that row only', async () => {
    const { bridge } = makeBridge({
      modelTiers: {},
      sessionModelPolicy: {
        compact: { mode: 'tier', tier: 'fast' },
        memory_recall: { mode: 'tier', tier: 'best' },
        session_title: { mode: 'tier', tier: 'fast' },
      },
    })
    renderSection(bridge)
    await waitFor(() => {
      expect(advancedState()).toBe('open')
    })
    expect(
      screen.getByTestId('session-models-route-compact-weak-tier'),
    ).toBeTruthy()
    // A strong tier does not warn; a feature without a floor never warns.
    expect(
      screen.queryByTestId('session-models-route-memory_recall-weak-tier'),
    ).toBeNull()
    expect(
      screen.queryByTestId('session-models-route-session_title-weak-tier'),
    ).toBeNull()
  })

  it('a pin on another provider than the session explains the lost prompt cache', async () => {
    const { bridge } = makeBridge({
      modelTiers: {
        fast: { providerId: 'google', modelId: 'gemini-flash' },
        balanced: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
      },
      sessionModelPolicy: {},
    })
    renderSection(bridge)
    expect(
      await screen.findByTestId('session-models-tier-fast-cache-hint'),
    ).toBeTruthy()
    expect(
      screen.queryByTestId('session-models-tier-balanced-cache-hint'),
    ).toBeNull()
  })

  it('a pin no longer enabled in the catalog warns, and its reset writes a null patch', async () => {
    const { bridge, setFieldCalls } = makeBridge({
      modelTiers: { fast: { providerId: 'openai', modelId: 'gpt-x' } },
      sessionModelPolicy: {
        compact: { mode: 'specific', providerId: 'gone', modelId: 'gone-model' },
      },
    })
    renderSection(bridge)

    const tierNote = await screen.findByTestId(
      'session-models-tier-fast-unavailable',
    )
    fireEvent.click(within(tierNote).getByRole('button'))
    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({ modelTiers: { fast: null } })
    })

    const pinNote = await screen.findByTestId(
      'session-models-route-compact-unavailable',
    )
    fireEvent.click(within(pinNote).getByRole('button'))
    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({
        sessionModelPolicy: { compact: null },
      })
    })
  })

  it('a FAILING pin (runtime pin health) shows the failing note; its reset clears it', async () => {
    // The pin is still catalog-valid (enabled pair) — but the runtime has
    // recorded failures for it. Distinct from the unavailable note.
    const { bridge, setFieldCalls } = makeBridge(
      {
        modelTiers: {
          fast: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
        },
        sessionModelPolicy: {},
      },
      {
        modelTiers: {
          fast: {
            count: 3,
            lastAt: 1_000,
            lastError: 'invalid api key',
            providerId: 'anthropic',
            modelId: 'claude-haiku-4-5',
          },
        },
        sessionModelPolicy: {},
      },
    )
    renderSection(bridge)

    const note = await screen.findByTestId('session-models-tier-fast-failing')
    expect(note.textContent).toContain('invalid api key')
    // No unavailable note — the pair is still enabled in the catalog.
    expect(
      screen.queryByTestId('session-models-tier-fast-unavailable'),
    ).toBeNull()
    fireEvent.click(within(note).getByRole('button'))
    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({ modelTiers: { fast: null } })
    })
    // The edit clears the health locally — the note is gone.
    await waitFor(() => {
      expect(
        screen.queryByTestId('session-models-tier-fast-failing'),
      ).toBeNull()
    })
  })

  it('Reset all is confirm-gated and clears BOTH sections', async () => {
    const { bridge, setFieldCalls } = makeBridge({
      modelTiers: {
        fast: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
      },
      sessionModelPolicy: { compact: { mode: 'same-as-parent' } },
    })
    renderSection(bridge)

    const resetAll = await screen.findByTestId('session-models-reset-all')
    expect(
      screen.getByTestId('session-models-modified-count').textContent,
    ).toContain('2')
    fireEvent.click(resetAll)

    // Nothing written until the dialog confirms.
    expect(setFieldCalls).toHaveLength(0)
    const dialog = await screen.findByTestId('session-models-reset-dialog')
    fireEvent.click(
      within(dialog).getByTestId('session-models-reset-confirm'),
    )
    await waitFor(() => {
      expect(setFieldCalls).toHaveLength(1)
    })
    const patch = setFieldCalls[0] as {
      modelTiers: Record<string, unknown>
      sessionModelPolicy: Record<string, unknown>
    }
    // Every slot and every kind nulled — a full return to defaults.
    expect(Object.values(patch.modelTiers).every(v => v === null)).toBe(true)
    expect(Object.keys(patch.modelTiers).sort()).toEqual([
      'balanced',
      'best',
      'fast',
    ])
    expect(
      Object.values(patch.sessionModelPolicy).every(v => v === null),
    ).toBe(true)
    expect(Object.keys(patch.sessionModelPolicy)).toHaveLength(10)
    // Nothing left modified → the header control goes away.
    await waitFor(() => {
      expect(screen.queryByTestId('session-models-reset-all')).toBeNull()
    })
  })
})
