// @vitest-environment happy-dom
import { createElement, useCallback, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import { NexusModelPicker } from '../browser/webview/topbar/NexusModelPicker'
import { isCustomProviderId } from '../browser/webview/ModelQuickPicker'
import type {
  BrowserLlmCatalog,
  BrowserLlmProvider,
  BrowserLlmSelection,
} from '../browser/bridge/protocol/nexus_llm'
import type { ScopeMode } from '../browser/runtimeProtocol'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

/**
 * `NexusModelPicker` is wrapped in `React.memo`, so the shell's per-token renders bail out. The catalog's counting
 * `providers` getter observes renders: the picker reads it every render, but the `[catalog]`-keyed memos do not.
 */

const providers: BrowserLlmProvider[] = [
  {
    id: 'p1',
    label: 'Provider One',
    enabled: true,
    iconSvg: '',
    defaultModelId: 'm1',
    models: [
      { id: 'm1', label: 'Model One', enabled: true },
      { id: 'm2', label: 'Model Two', enabled: true },
    ],
  },
] as unknown as BrowserLlmProvider[]

function makeCountingCatalog(): {
  catalog: BrowserLlmCatalog
  reads: () => number
} {
  let count = 0
  const catalog = {
    get providers() {
      count += 1
      return providers
    },
    defaultSelection: { providerId: 'p1', modelId: 'm1' },
  } as unknown as BrowserLlmCatalog
  return { catalog, reads: () => count }
}

const selection: BrowserLlmSelection = { providerId: 'p1', modelId: 'm1' }

afterEach(() => {
  cleanup()
})

/**
 * The topbar picker's "Provider settings…" footer opens Settings → Models, a
 * page built on `providers.*` (`manager`). A control or observe connection
 * cannot open that page (the settings shell falls back to General), so it gets
 * no footer; a manager, a `full` grant and the desktop tree (no provider) keep
 * it. The grants are read from the real scope tables (`advertsForScope`).
 */
describe('NexusModelPicker — the Provider settings footer follows the grant', () => {
  const catalog = {
    providers,
    defaultSelection: selection,
  } as unknown as BrowserLlmCatalog

  function renderOpenPicker(capabilities?: CapabilityQuery) {
    const picker = createElement(NexusModelPicker, {
      catalog,
      selection,
      onSelect: () => {},
      onOpenSettings: () => {},
      // Programmatic open: the popover (and its footer) mounts without a click.
      openToken: 1,
    })
    return render(
      capabilities
        ? createElement(RuntimeCapabilitiesContext.Provider, { value: capabilities }, picker)
        : picker,
    )
  }

  it.each([
    ['with no capability provider (the desktop tree)', undefined],
    ['for a full grant', queryFor(advertsForScope('full'))],
    ['for a manager grant', queryFor(advertsForScope('manager'))],
  ])('renders the footer %s', async (_label, capabilities) => {
    renderOpenPicker(capabilities)
    expect(
      await screen.findByTestId('nexus-model-picker-provider-settings'),
    ).toBeTruthy()
  })

  it.each<ScopeMode>(['control', 'observe'])(
    'drops the footer for a %s grant and keeps the model rows',
    async mode => {
      renderOpenPicker(queryFor(advertsForScope(mode)))
      // The popover is open — its rows are there — and only the footer is gone.
      expect(await screen.findByTestId('nexus-model-option-p1-m1')).toBeTruthy()
      expect(
        screen.queryByTestId('nexus-model-picker-provider-settings'),
      ).toBeNull()
    },
  )
})

describe('NexusModelPicker memoization', () => {
  it('is wrapped in React.memo', () => {
    // $$typeof flips from undefined (plain function) to the memo symbol —
    // a direct, deterministic guard that the memo wrapper is not dropped.
    expect((NexusModelPicker as unknown as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    )
  })

  it('does NOT re-run its render body when the parent re-renders with stable props', () => {
    const { catalog, reads } = makeCountingCatalog()
    let bump: (() => void) | undefined

    function Harness() {
      const [, setTick] = useState(0)
      bump = () => setTick(t => t + 1)
      // Stable callbacks (mirrors NexusTopBar's useCallback) so the only thing
      // changing on a parent render is unrelated parent state.
      const onSelect = useCallback(() => {}, [])
      const onOpenSettings = useCallback(() => {}, [])
      return createElement(NexusModelPicker, {
        catalog,
        selection,
        onSelect,
        onOpenSettings,
      })
    }

    render(createElement(Harness))
    const afterMount = reads()
    expect(afterMount).toBeGreaterThan(0)

    // Two parent re-renders with identical picker props. With React.memo the
    // picker bails out, so its render body never runs and `providers` is not
    // read again. Without memo each bump re-runs the body and bumps the count.
    act(() => bump?.())
    act(() => bump?.())
    expect(reads()).toBe(afterMount)
  })

  it('lists an alias-hidden snapshot row once, as its curated twin', () => {
    // Regression: the configured Anthropic catalog carries BOTH the dated
    // snapshot id and its synthesized curated alias under the same label
    // ("Claude Haiku 4.5" twice in the popover). The snapshot row is marked
    // `pickerAliasId` by createConfiguredProvider — the picker must skip it
    // in its option list while still resolving it as the active selection.
    const catalog = {
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          enabled: true,
          iconSvg: '',
          defaultModelId: 'claude-haiku-4-5-20251001',
          models: [
            {
              id: 'claude-haiku-4-5-20251001',
              label: 'Claude Haiku 4.5',
              enabled: true,
              pickerAliasId: 'claude-haiku-4-5',
            },
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', enabled: true },
          ],
        },
      ],
    } as unknown as BrowserLlmCatalog

    render(createElement(NexusModelPicker, {
      catalog,
      // Persisted selections may still hold the snapshot id.
      selection: { providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
      onSelect: () => {},
      onOpenSettings: () => {},
    }))

    // The e2e option surface mirrors what the popover renders: exactly one
    // Haiku entry, keyed by the curated alias id.
    expect(
      globalThis.__NEXUS_PICKER_E2E__?.options.map(option => option.modelId),
    ).toEqual(['claude-haiku-4-5'])
  })

  it('openToken opens the popover and the active row is scrolled into view', async () => {
    // Regression (quick-picker visibility): opening the popover must bring
    // the CHECKED model row into view — with several providers the active
    // row routinely sits below the fold of the max-h-80 list. Also guards
    // the programmatic-open plumbing (`openToken`) the adopt-default send
    // gate uses. happy-dom has no layout, so record scrollIntoView receivers.
    const scrolled: Element[] = []
    const proto = Element.prototype as unknown as {
      scrollIntoView?: (options?: unknown) => void
    }
    const original = proto.scrollIntoView
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      const catalog = {
        providers: [
          {
            id: 'p1',
            label: 'Provider One',
            enabled: true,
            iconSvg: '',
            defaultModelId: 'm1',
            models: Array.from({ length: 20 }, (_, i) => ({
              id: `m${i + 1}`,
              label: `Model ${i + 1}`,
              enabled: true,
            })),
          },
        ],
        defaultSelection: { providerId: 'p1', modelId: 'm1' },
      } as unknown as BrowserLlmCatalog
      const props = {
        catalog,
        selection: { providerId: 'p1', modelId: 'm15' },
        onSelect: () => {},
        onOpenSettings: () => {},
      }

      const { rerender } = render(
        createElement(NexusModelPicker, { ...props, openToken: 0 }),
      )
      // Token 0 is inert — mount must not auto-open the popover.
      expect(
        document.querySelector('[data-testid="nexus-model-option-p1-m15"]'),
      ).toBeNull()

      rerender(createElement(NexusModelPicker, { ...props, openToken: 1 }))
      expect(
        document.querySelector('[data-testid="nexus-model-option-p1-m15"]'),
      ).not.toBeNull()

      // The scroll is deferred one rAF past Radix's positioning pass.
      await act(
        () =>
          new Promise<void>(resolve =>
            requestAnimationFrame(() => resolve()),
          ),
      )
      expect(
        scrolled.some(
          el =>
            el.querySelector('[data-testid="nexus-model-option-p1-m15"]') !==
            null,
        ),
      ).toBe(true)
    } finally {
      proto.scrollIntoView = original
    }
  })

  it('scrolls when the selection lands AFTER the popover opened (adopt-default path)', async () => {
    // Regression: the adopt-default send gate opens the popover (openToken)
    // BEFORE the adopted selection round-trips through the worker — no row
    // is active at open time. When the selection prop lands a beat later,
    // the checked row mounts and the scroll must re-fire; keyed on `open`
    // alone it never did, leaving the row below the fold.
    const scrolled: Element[] = []
    const proto = Element.prototype as unknown as {
      scrollIntoView?: (options?: unknown) => void
    }
    const original = proto.scrollIntoView
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      const catalog = {
        providers: [
          {
            id: 'p1',
            label: 'Provider One',
            enabled: true,
            iconSvg: '',
            defaultModelId: 'm1',
            models: Array.from({ length: 20 }, (_, i) => ({
              id: `m${i + 1}`,
              label: `Model ${i + 1}`,
              enabled: true,
            })),
          },
        ],
        defaultSelection: { providerId: 'p1', modelId: 'm1' },
      } as unknown as BrowserLlmCatalog
      const props = {
        catalog,
        onSelect: () => {},
        onOpenSettings: () => {},
        openToken: 1,
      }

      // Open with a STALE selection — no row is active.
      const { rerender } = render(
        createElement(NexusModelPicker, {
          ...props,
          selection: { providerId: 'gone', modelId: 'gone-model' },
        }),
      )
      await act(
        () =>
          new Promise<void>(resolve =>
            requestAnimationFrame(() => resolve()),
          ),
      )
      scrolled.length = 0

      // The adopted selection lands while the popover is still open.
      rerender(
        createElement(NexusModelPicker, {
          ...props,
          selection: { providerId: 'p1', modelId: 'm18' },
        }),
      )
      await act(
        () =>
          new Promise<void>(resolve =>
            requestAnimationFrame(() => resolve()),
          ),
      )
      expect(
        scrolled.some(
          el =>
            el.querySelector('[data-testid="nexus-model-option-p1-m18"]') !==
            null,
        ),
      ).toBe(true)
    } finally {
      proto.scrollIntoView = original
    }
  })

  it('DOES re-run its render body when a prop actually changes', () => {
    const { catalog, reads } = makeCountingCatalog()
    let setSel: ((s: BrowserLlmSelection) => void) | undefined

    function Harness() {
      const [sel, setSelState] = useState<BrowserLlmSelection>(selection)
      setSel = setSelState
      const onSelect = useCallback(() => {}, [])
      const onOpenSettings = useCallback(() => {}, [])
      return createElement(NexusModelPicker, {
        catalog,
        selection: sel,
        onSelect,
        onOpenSettings,
      })
    }

    render(createElement(Harness))
    const afterMount = reads()
    act(() => setSel?.({ providerId: 'p1', modelId: 'm2' }))
    expect(reads()).toBeGreaterThan(afterMount)
  })
})

describe('NexusModelPicker custom-provider badge', () => {
  it('isCustomProviderId matches the custom- prefix only', () => {
    // Every user-created provider id starts with `custom-` (minted by
    // generateCustomProviderId), including the two reserved backend slots;
    // built-in ids never carry the prefix.
    expect(isCustomProviderId('custom-abc-provider')).toBe(true)
    expect(isCustomProviderId('custom-openai')).toBe(true)
    expect(isCustomProviderId('custom-anthropic')).toBe(true)
    expect(isCustomProviderId('openai')).toBe(false)
    expect(isCustomProviderId('anthropic')).toBe(false)
    expect(isCustomProviderId(undefined)).toBe(false)
  })

  it('shows a Custom badge on the trigger for a custom-provider selection', () => {
    const catalog = {
      providers: [
        {
          id: 'custom-abc-provider',
          label: 'ABC Provider',
          enabled: true,
          iconSvg: '',
          defaultModelId: 'abc-1',
          models: [{ id: 'abc-1', label: 'ABC Model', enabled: true }],
        },
      ],
    } as unknown as BrowserLlmCatalog

    const { container } = render(
      createElement(NexusModelPicker, {
        catalog,
        selection: { providerId: 'custom-abc-provider', modelId: 'abc-1' },
        onSelect: () => {},
        onOpenSettings: () => {},
      }),
    )

    const badge = container.querySelector(
      '[data-testid="nexus-model-picker-custom-badge"]',
    )
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toBe('Custom')
  })

  it('shows no Custom badge for a built-in provider selection', () => {
    const catalog = {
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          enabled: true,
          iconSvg: '',
          defaultModelId: 'gpt-4',
          models: [{ id: 'gpt-4', label: 'GPT-4', enabled: true }],
        },
      ],
    } as unknown as BrowserLlmCatalog

    const { container } = render(
      createElement(NexusModelPicker, {
        catalog,
        selection: { providerId: 'openai', modelId: 'gpt-4' },
        onSelect: () => {},
        onOpenSettings: () => {},
      }),
    )

    expect(
      container.querySelector('[data-testid="nexus-model-picker-custom-badge"]'),
    ).toBeNull()
  })

  it('badges the custom provider group header only, not its model rows', () => {
    const catalog = {
      providers: [
        {
          id: 'p1',
          label: 'Provider One',
          enabled: true,
          iconSvg: '',
          defaultModelId: 'm1',
          models: [{ id: 'm1', label: 'Model One', enabled: true }],
        },
        {
          id: 'custom-abc-provider',
          label: 'ABC Provider',
          enabled: true,
          iconSvg: '',
          defaultModelId: 'abc-1',
          models: [{ id: 'abc-1', label: 'ABC Model', enabled: true }],
        },
      ],
    } as unknown as BrowserLlmCatalog

    const { container } = render(
      createElement(NexusModelPicker, {
        catalog,
        selection: { providerId: 'custom-abc-provider', modelId: 'abc-1' },
        onSelect: () => {},
        onOpenSettings: () => {},
        openToken: 1,
      }),
    )

    // The trigger badge is inline (not portaled)…
    expect(
      container.querySelector(
        '[data-testid="nexus-model-picker-custom-badge"]',
      ),
    ).not.toBeNull()
    // …the popover content IS portaled to document.body by Radix, so query
    // the document (same as the openToken tests above). The custom provider's
    // group header carries the badge…
    expect(
      document.querySelector(
        '[data-testid="nexus-provider-custom-badge-custom-abc-provider"]',
      ),
    ).not.toBeNull()
    // …the built-in provider's group header has no badge…
    expect(
      document.querySelector('[data-testid="nexus-provider-custom-badge-p1"]'),
    ).toBeNull()
    // …and model rows carry no per-model badge at all (the provider header
    // badge is sufficient — repeating it on every child row was noise).
    expect(
      document.querySelector('[data-testid="nexus-model-custom-badge-p1-m1"]'),
    ).toBeNull()
    expect(
      document.querySelector(
        '[data-testid="nexus-model-custom-badge-custom-abc-provider-abc-1"]',
      ),
    ).toBeNull()
  })
})
