// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import {
  ComposerEffortPicker,
  SessionEffortProvider,
  effortStopFraction,
  resolveEffortStops,
  type SessionEffortContextValue,
} from '../browser/webview/ComposerEffortPicker'
import { ModelQuickPicker } from '../browser/webview/ModelQuickPicker'
import { mergeRequestedTier } from '../browser/worker/modelSelection'
import { AgentModelController } from '../browser/worker/AgentModelController'
import type { AgentRuntimeState } from '../browser/runtime/AgentRuntimeState'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  BrowserLlmCatalog,
  BrowserLlmModel,
  BrowserLlmSelection,
} from '../browser/bridge/protocol/nexus_llm'

/**
 * Session effort (F-12): the composer's effort control changes THIS session only; the topbar sets the global
 * default. `mergeRequestedTier` keeps a reopened session's persisted tier; `resolveEffortStops` /
 * `ComposerEffortPicker` give one stop per tier (the model's `defaultThinkingTier` marked Recommended), hidden under
 * two tiers, inert for a teammate; the topbar marks the global default's pill.
 */

afterEach(cleanup)

const opus: BrowserLlmModel = {
  id: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  enabled: true,
  supportsStreaming: true,
  defaultThinkingTier: 'medium',
  availableThinkingTiers: ['low', 'medium', 'high', 'xhigh', 'max'],
}

const haiku: BrowserLlmModel = {
  id: 'claude-haiku-4-5',
  label: 'Claude Haiku 4.5',
  enabled: true,
  supportsStreaming: true,
  availableThinkingTiers: ['high'],
}

const catalog = {
  providers: [
    { id: 'anthropic', label: 'Anthropic', iconSvg: '', enabled: true, models: [opus, haiku] },
  ],
} as unknown as BrowserLlmCatalog

function mountEffort(overrides: Partial<SessionEffortContextValue> = {}) {
  const onSelect = vi.fn()
  render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        SessionEffortProvider,
        {
          value: {
            catalog,
            selection: { providerId: 'anthropic', modelId: opus.id, thinkingTier: 'medium' },
            onSelect,
            ...overrides,
          },
        },
        createElement(ComposerEffortPicker),
      ),
    ),
  )
  return { onSelect }
}

describe('mergeRequestedTier — a session keeps its own effort', () => {
  const requested: BrowserLlmSelection = {
    providerId: 'anthropic',
    modelId: opus.id,
    thinkingTier: 'medium',
  }

  it('a persisted tier wins over the requested (global default) tier', () => {
    const persisted = { ...requested, thinkingTier: 'max' }
    expect(mergeRequestedTier(persisted, requested).thinkingTier).toBe('max')
  })

  it('the requested tier fills a selection that carries none', () => {
    const resolved = { providerId: 'anthropic', modelId: opus.id }
    expect(mergeRequestedTier(resolved, requested).thinkingTier).toBe('medium')
  })

  it('a different model never takes the requested tier', () => {
    const resolved = { providerId: 'anthropic', modelId: haiku.id }
    expect(mergeRequestedTier(resolved, requested).thinkingTier).toBeUndefined()
  })

  it('a session that ran on the model\'s default effort keeps it on reopen', async () => {
    // Created before any topbar pick: no tier requested, so it runs on the
    // model's default (Opus 5: high). The record must say so, or a reopen
    // under a later global default ('low') would adopt that one.
    let metadata: { llmSelection?: BrowserLlmSelection } = {}
    const runtime = {
      options: {},
      engine: { setModelSelection: vi.fn() },
      conversationStore: {
        getSessionMetadata: async () => metadata,
        updateSessionMetadata: async (patch: typeof metadata) => {
          metadata = { ...metadata, ...patch }
        },
      },
    } as unknown as AgentRuntimeState
    const controller = new AgentModelController({
      getRuntime: () => runtime,
      emitState: () => {},
      emitDebugLog: () => {},
      reportModelChanged: () => {},
    })
    controller.bindRuntime(runtime)
    await controller.applySelection({ providerId: 'anthropic', modelId: 'claude-opus-5' })
    expect(metadata.llmSelection).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-5', thinkingTier: 'high' })
    const globalDefault = { providerId: 'anthropic', modelId: 'claude-opus-5', thinkingTier: 'low' }
    expect(mergeRequestedTier(metadata.llmSelection!, globalDefault).thinkingTier).toBe('high')
  })
})

describe('resolveEffortStops', () => {
  it('one stop per tier; the default is Recommended; the pick is current', () => {
    expect(resolveEffortStops(opus, 'xhigh')).toEqual({
      tiers: ['low', 'medium', 'high', 'xhigh', 'max'],
      currentIndex: 3,
      recommendedIndex: 1,
    })
  })

  it('no tier (or an unknown one) runs on the model default', () => {
    expect(resolveEffortStops(opus, undefined)?.currentIndex).toBe(1)
    expect(resolveEffortStops(opus, 'bogus')?.currentIndex).toBe(1)
  })

  it('a model without a default names no Recommended stop', () => {
    const noDefault = { availableThinkingTiers: ['low', 'high'] }
    expect(resolveEffortStops(noDefault, 'high')).toEqual({
      tiers: ['low', 'high'],
      currentIndex: 1,
      recommendedIndex: -1,
    })
  })

  it('no tier and no model default: no stop is current (no tier is sent)', () => {
    // e.g. a custom-provider reasoning model: tiers but no defaultThinkingTier.
    // The engine sends no effort at all, so the first stop must not claim it.
    const noDefault = { availableThinkingTiers: ['low', 'medium', 'high'] }
    expect(resolveEffortStops(noDefault, undefined)?.currentIndex).toBe(-1)
    expect(resolveEffortStops(noDefault, 'bogus')?.currentIndex).toBe(-1)
  })

  it('fewer than two tiers is nothing to choose', () => {
    expect(resolveEffortStops(haiku, 'high')).toBeNull()
    expect(resolveEffortStops({}, undefined)).toBeNull()
  })
})

describe('effortStopFraction — the thumb reaches both ends', () => {
  it('the first stop is flush left, the last flush right', () => {
    expect(effortStopFraction(0, 5)).toBe(0)
    expect(effortStopFraction(4, 5)).toBe(1)
    expect(effortStopFraction(2, 5)).toBe(0.5)
    expect(effortStopFraction(1, 2)).toBe(1)
  })
})

describe('ComposerEffortPicker', () => {
  it('shows the session model read-only and its effort', () => {
    mountEffort()
    expect(screen.getByTestId('composer-effort-model').textContent).toBe('Claude Opus 5.5')
    const trigger = screen.getByTestId('composer-effort-trigger')
    expect(trigger.textContent).toBe('Medium')
    expect(trigger.getAttribute('data-tier')).toBe('medium')
  })

  it('a stop applies its tier to the session model; Recommended snaps back', () => {
    const { onSelect } = mountEffort({
      selection: { providerId: 'anthropic', modelId: opus.id, thinkingTier: 'xhigh' },
    })
    fireEvent.click(screen.getByTestId('composer-effort-trigger'))
    expect(screen.getByTestId('composer-effort-current').textContent).toBe('Extra')
    expect(screen.getByTestId('composer-effort-stop-xhigh').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('composer-effort-stop-medium').getAttribute('data-recommended')).toBe('true')

    fireEvent.click(screen.getByTestId('composer-effort-stop-high'))
    expect(onSelect).toHaveBeenLastCalledWith({
      providerId: 'anthropic',
      modelId: opus.id,
      thinkingTier: 'high',
    })

    fireEvent.click(screen.getByTestId('composer-effort-recommended'))
    expect(onSelect).toHaveBeenLastCalledWith({
      providerId: 'anthropic',
      modelId: opus.id,
      thinkingTier: 'medium',
    })
  })

  it('opening focuses the current stop, not the help button (no tooltip pops)', () => {
    mountEffort({
      selection: { providerId: 'anthropic', modelId: opus.id, thinkingTier: 'high' },
    })
    fireEvent.click(screen.getByTestId('composer-effort-trigger'))
    expect(document.activeElement).toBe(screen.getByTestId('composer-effort-stop-high'))
    expect(document.activeElement).not.toBe(screen.getByTestId('composer-effort-help'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('a click on the track picks the nearest stop, ends included', () => {
    const { onSelect } = mountEffort()
    fireEvent.click(screen.getByTestId('composer-effort-trigger'))
    const track = screen.getByTestId('composer-effort-track')
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 100, width: 200, top: 0, right: 300, bottom: 20, height: 20, x: 100, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    fireEvent.click(track, { clientX: 300 })
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ thinkingTier: 'max' }))
    fireEvent.click(track, { clientX: 99 })
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ thinkingTier: 'low' }))
    fireEvent.click(track, { clientX: 248 })
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ thinkingTier: 'xhigh' }))
  })

  it('arrow keys step through the stops', () => {
    const { onSelect } = mountEffort()
    fireEvent.click(screen.getByTestId('composer-effort-trigger'))
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinkingTier: 'high' }),
    )
  })

  it('a second arrow press before the snapshot lands steps on, and focus follows', () => {
    // `onSelect` here never re-publishes the selection — the worker round-trip
    // has not landed — so the current stop is still 'medium'.
    const { onSelect } = mountEffort()
    fireEvent.click(screen.getByTestId('composer-effort-trigger'))
    const group = screen.getByRole('radiogroup')
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(onSelect.mock.calls.map(([selection]) => selection.thinkingTier)).toEqual([
      'high',
      'xhigh',
    ])
    expect(document.activeElement).toBe(screen.getByTestId('composer-effort-stop-xhigh'))
  })

  it('no tier in effect shows Default, with no stop checked', () => {
    const noDefaultCatalog = {
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          iconSvg: '',
          enabled: true,
          models: [
            {
              id: 'reasoner',
              label: 'Reasoner',
              enabled: true,
              supportsStreaming: true,
              availableThinkingTiers: ['low', 'medium', 'high'],
            },
          ],
        },
      ],
    } as unknown as BrowserLlmCatalog
    mountEffort({
      catalog: noDefaultCatalog,
      selection: { providerId: 'custom', modelId: 'reasoner' },
    })
    const trigger = screen.getByTestId('composer-effort-trigger')
    expect(trigger.textContent).toBe('Default')
    fireEvent.click(trigger)
    expect(document.querySelector('[role="radio"][aria-checked="true"]')).toBeNull()
    expect(screen.queryByTestId('composer-effort-thumb')).toBeNull()
  })

  it('shows only the model name for a model with fewer than two tiers', () => {
    mountEffort({ selection: { providerId: 'anthropic', modelId: haiku.id } })
    expect(screen.getByTestId('composer-effort-model').textContent).toBe('Claude Haiku 4.5')
    expect(screen.queryByTestId('composer-effort-trigger')).toBeNull()
  })

  it('closes while its thread is hidden, and stays closed on return', () => {
    const value: SessionEffortContextValue = {
      catalog,
      selection: { providerId: 'anthropic', modelId: opus.id, thinkingTier: 'medium' },
      onSelect: () => {},
    }
    const element = (isForeground: boolean) =>
      createElement(
        TooltipProvider,
        null,
        createElement(
          SessionEffortProvider,
          { value },
          createElement(ComposerEffortPicker, { isForeground }),
        ),
      )
    const { rerender } = render(element(true))
    fireEvent.click(screen.getByTestId('composer-effort-trigger'))
    expect(screen.queryByTestId('composer-effort-popover')).not.toBeNull()
    rerender(element(false))
    expect(screen.queryByTestId('composer-effort-popover')).toBeNull()
    rerender(element(true))
    expect(screen.queryByTestId('composer-effort-popover')).toBeNull()
  })

  it('a teammate sees it inert', () => {
    const { onSelect } = mountEffort({ disabled: true, inertWhy: 'locked' })
    const trigger = screen.getByTestId('composer-effort-trigger') as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(trigger.title).toBe('locked')
    fireEvent.click(trigger)
    expect(screen.queryByTestId('composer-effort-popover')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('ModelQuickPicker — the global default effort is marked', () => {
  function mountPicker(defaultSelection: BrowserLlmSelection | null) {
    render(
      createElement(ModelQuickPicker, {
        catalog,
        selection: { providerId: 'anthropic', modelId: opus.id, thinkingTier: 'max' },
        defaultSelection,
        onSelect: () => {},
      }),
    )
    fireEvent.click(screen.getByTestId('nexus-model-picker-trigger'))
  }
  const pill = (tier: string) =>
    screen.getByTestId(`nexus-tier-anthropic-${opus.id}-${tier}`)

  it('marks the default tier even while the session runs another', () => {
    mountPicker({ providerId: 'anthropic', modelId: opus.id, thinkingTier: 'high' })
    expect(pill('high').getAttribute('data-default')).toBe('true')
    expect(pill('max').getAttribute('data-default')).toBeNull()
  })

  it('a default without a tier marks the model default tier', () => {
    mountPicker({ providerId: 'anthropic', modelId: opus.id })
    expect(pill('medium').getAttribute('data-default')).toBe('true')
  })

  it('no default, no mark', () => {
    mountPicker(null)
    expect(document.querySelector('[data-default="true"]')).toBeNull()
  })
})
