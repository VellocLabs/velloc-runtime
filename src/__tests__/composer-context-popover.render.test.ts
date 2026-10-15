// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TokenUsageIndicator } from '../browser/webview/TokenUsageIndicator'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PlanUsageSnapshot } from '../models/usage/planUsage'
import type { Message, StreamRecord } from '../runtime/RuntimeTypes'
import type { BrowserLlmCatalog } from '../browser/bridge/browserBridgeProtocol'
import { createConfiguredModelCatalog } from '../browser/webview/modelCatalog'
import { resetEntryResolutions } from '../config/nexusModelConfig/modelEntryResolution'

/**
 * The composer context ring's popover: Compact follows `canCompact` and calls `onCompact` once; Plan usage limits
 * render only with a snapshot. The trigger carries the last turn's cache ratio, its tooltip is at most three
 * lines, and at 0% the trigger and cache segments are absent.
 */

afterEach(cleanup)

type RingProps = {
  canCompact?: boolean
  onCompact?: () => void
  planUsage?: PlanUsageSnapshot
  onPlanUsageOpen?: () => void
  messages?: Message[]
  liveEvents?: StreamRecord[]
  isStreaming?: boolean
  providerId?: string
  modelFree?: boolean
}

function assistant(usage: Record<string, number>): Message {
  return {
    type: 'assistant',
    uuid: `a-${Math.random()}`,
    message: { role: 'assistant', content: [], model: 'm', usage },
  } as unknown as Message
}

function mountRing(props: RingProps) {
  render(
    createElement(
      TooltipProvider,
      null,
      createElement(TokenUsageIndicator, {
      messages: [],
      liveEvents: [],
      modelId: undefined,
      isStreaming: false,
      ...props,
      } as Parameters<typeof TokenUsageIndicator>[0]),
    ),
  )
  return screen.getByTestId('composer-context-usage')
}

function renderRing(props: RingProps) {
  fireEvent.click(mountRing(props))
  return screen.getByTestId('composer-context-popover')
}

/** Focus opens a Radix tooltip at once (hover waits out a delay). */
function hoverSummary(trigger: HTMLElement): HTMLElement {
  fireEvent.focus(trigger)
  return screen.getByTestId('composer-context-tooltip')
}

describe('composer context popover', () => {
  // A mounted-but-hidden thread (another session in front): the popover and
  // the tooltip are portaled to <body>, and left open behind a display:none
  // anchor they jump to the window's top-left corner. They close instead,
  // and stay closed when the thread comes back.
  it('closes the popover and the tooltip while the thread is hidden', () => {
    const element = (isForeground: boolean) =>
      createElement(
        TooltipProvider,
        null,
        createElement(TokenUsageIndicator, {
          messages: [],
          liveEvents: [],
          modelId: undefined,
          isStreaming: false,
          isForeground,
        } as Parameters<typeof TokenUsageIndicator>[0]),
      )
    const { rerender } = render(element(true))
    const trigger = screen.getByTestId('composer-context-usage')
    fireEvent.click(trigger)
    expect(screen.queryByTestId('composer-context-popover')).not.toBeNull()
    rerender(element(false))
    expect(screen.queryByTestId('composer-context-popover')).toBeNull()
    expect(screen.queryByTestId('composer-context-tooltip')).toBeNull()
    rerender(element(true))
    expect(screen.queryByTestId('composer-context-popover')).toBeNull()
  })

  it('disables Compact session while a turn runs', () => {
    const onCompact = vi.fn()
    renderRing({ canCompact: false, onCompact })
    const button = screen.getByTestId('composer-compact-session')
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(onCompact).not.toHaveBeenCalled()
  })

  it('runs Compact session once when the session is stopped', () => {
    const onCompact = vi.fn()
    renderRing({ canCompact: true, onCompact })
    const button = screen.getByTestId('composer-compact-session')
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(button.textContent).toBe('Compact')
    fireEvent.click(button)
    expect(onCompact).toHaveBeenCalledTimes(1)
  })

  it('hides the plan section without a snapshot', () => {
    renderRing({ canCompact: true, onCompact: () => {} })
    expect(screen.queryByTestId('composer-plan-usage')).toBeNull()
  })

  it('renders one row per plan window with the plan name', () => {
    const now = Date.now()
    renderRing({
      canCompact: true,
      onCompact: () => {},
      planUsage: {
        planName: 'Max (5x)',
        windows: [
          { kind: 'five_hour', usedPercent: 37, resetsAt: now + 2 * 3600_000 },
          { kind: 'weekly', usedPercent: 6 },
        ],
      },
    })
    const section = screen.getByTestId('composer-plan-usage')
    expect(section.textContent).toContain('Plan usage limits · Max (5x)')
    expect(section.textContent).toContain('5-hour limit')
    expect(section.textContent).toContain('Resets in 2 hr 0 min')
    expect(section.textContent).toContain('37%')
    expect(section.textContent).toContain('Weekly · all models')
    expect(section.textContent).toContain('6%')
  })

  it('renders money figures — a prepaid balance has no windows, so the section reads Credits', () => {
    renderRing({
      planUsage: {
        windows: [],
        amounts: [
          { kind: 'balance', amount: 95.5, currency: 'USD' },
          { kind: 'spent', amount: 4.5, currency: 'USD', period: 'total' },
        ],
      },
    })
    const section = screen.getByTestId('composer-plan-usage')
    expect(section.textContent).toContain('Credits')
    expect(section.textContent).not.toContain('Plan usage limits')
    expect(screen.getByTestId('composer-plan-amount-balance').textContent).toBe('Credit balance$95.50')
    expect(screen.getByTestId('composer-plan-amount-spent-total').textContent).toBe('Total spent$4.50')
  })

  it('labels a free-request window apart from the plan quota, next to a key limit', () => {
    renderRing({
      planUsage: {
        windows: [
          { kind: 'daily', usedPercent: 25 },
          { kind: 'daily', subject: 'free_requests', usedPercent: 80 },
        ],
        amounts: [
          { kind: 'limit_remaining', amount: 15, currency: 'USD' },
          { kind: 'spent', amount: 1.25, currency: 'USD', period: 'day' },
        ],
      },
    })
    const section = screen.getByTestId('composer-plan-usage')
    expect(section.textContent).toContain('Plan usage limits')
    expect(section.textContent).toContain('Daily limit')
    expect(section.textContent).toContain('Free-model requests today')
    expect(screen.getByTestId('composer-plan-amount-limit_remaining').textContent).toBe('Key limit remaining$15.00')
    expect(screen.getByTestId('composer-plan-amount-spent-day').textContent).toBe('Spent today$1.25')
  })

  it('says why the account balance is missing instead of leaving the key cap alone', () => {
    renderRing({
      planUsage: {
        windows: [],
        amounts: [{ kind: 'limit_remaining', amount: 100, currency: 'USD' }],
        balanceNote: 'unavailable',
      },
    })
    const note = screen.getByTestId('composer-plan-balance-note')
    expect(note.textContent).toContain('Credit balance')
    expect(note.textContent).toContain('n/a')
    // The explanation sits behind the (?) beside n/a, not inline.
    expect(note.textContent).not.toContain("Couldn't read the account balance")
    expect(screen.queryByTestId('composer-plan-balance-help-content')).toBeNull()
    fireEvent.click(screen.getByTestId('composer-plan-balance-help'))
    expect(screen.getByTestId('composer-plan-balance-help-content').textContent).toContain(
      "Couldn't read the account balance",
    )
    // The note leads the money figures.
    const section = screen.getByTestId('composer-plan-usage')
    expect(section.textContent!.indexOf('n/a')).toBeLessThan(section.textContent!.indexOf('Key limit remaining'))
  })

  it('a balance note alone still opens the money section', () => {
    renderRing({ planUsage: { windows: [], balanceNote: 'needs_key' } })
    expect(screen.getByTestId('composer-plan-usage').textContent).toContain('n/a')
    expect(screen.getByTestId('composer-plan-balance-help').getAttribute('aria-label')).toBe(
      'Why is the balance unavailable?',
    )
    fireEvent.click(screen.getByTestId('composer-plan-balance-help'))
    expect(screen.getByTestId('composer-plan-balance-help-content').textContent).toContain('management key')
  })

  it('grows the card to fit its rows, wrapping only at the viewport cap', () => {
    const popover = renderRing({ planUsage: { windows: [{ kind: 'weekly', usedPercent: 18 }] } })
    expect(popover.className).not.toMatch(/(^|\s)w-80(\s|$)/)
    expect(popover.className).toContain('max-w-[calc(100vw-2rem)]')
    // A forced nowrap pushes a row's figure out of a card held at the cap
    // (narrow window, remote client, long translation); rows must wrap there.
    expect(popover.className).not.toContain('whitespace-nowrap')
  })

  it('asks for fresh figures when the popover opens', () => {
    const onPlanUsageOpen = vi.fn()
    renderRing({ onPlanUsageOpen })
    expect(onPlanUsageOpen).toHaveBeenCalledTimes(1)
  })
})

describe('composer context trigger — last-turn cache ratio', () => {
  // Session-wide this is 30 / 140 ≈ 21%; the last turn alone is 75%.
  const messages = [
    assistant({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 }),
    assistant({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    }),
  ]

  it("shows the last turn's ratio — not the session's — beside the ring", () => {
    const trigger = mountRing({ messages })
    expect(screen.getByTestId('composer-cache-ratio').textContent).toBe('75%')
    expect(trigger.getAttribute('aria-label')).toMatch(
      /^Context \d+% used · last turn 75% cached$/,
    )
  })

  /** The tooltip's lines by test id, de-duplicated — Radix renders the
   *  content twice (visible + the screen-reader copy). */
  function tooltipLine(tooltip: HTMLElement, id: string): string | undefined {
    const texts = [...new Set(Array.from(tooltip.querySelectorAll(`[data-testid="${id}"]`))
      .map((line) => line.textContent ?? ''))]
    expect(texts.length).toBeLessThanOrEqual(1)
    return texts[0]
  }

  it('puts the quota first, then context · cache on one line', () => {
    const tooltip = hoverSummary(
      mountRing({
        messages,
        planUsage: { windows: [{ kind: 'weekly', usedPercent: 6 }] },
      }),
    )
    expect(tooltipLine(tooltip, 'composer-plan-tooltip-line')).toBe('6% of weekly limit')
    expect(tooltipLine(tooltip, 'composer-context-tooltip-line')).toMatch(
      /^Context .+ \(\d+%\) · cache 75%$/,
    )
    expect(tooltipLine(tooltip, 'composer-money-tooltip-line')).toBeUndefined()
    const text = tooltip.textContent ?? ''
    expect(text.indexOf('6% of weekly limit')).toBeLessThan(text.indexOf('Context '))
    expect(text).not.toContain('Total cache read')
  })

  it('shows only the most-used window with its reset, then balance and spend on one line', () => {
    const now = Date.now()
    const tooltip = hoverSummary(
      mountRing({
        planUsage: {
          windows: [
            { kind: 'weekly', usedPercent: 10 },
            { kind: 'five_hour', usedPercent: 32, resetsAt: now + 2 * 3_600_000 + 10 * 60_000 },
            { kind: 'monthly', usedPercent: 8 },
          ],
          amounts: [
            { kind: 'balance', amount: 95.5, currency: 'USD' },
            { kind: 'spent', period: 'day', amount: 0.03, currency: 'USD' },
          ],
        },
      }),
    )
    expect(tooltipLine(tooltip, 'composer-plan-tooltip-line')).toMatch(/^32% of 5-hour limit · .*2.*10/)
    expect(tooltip.textContent).not.toContain('weekly limit')
    expect(tooltip.textContent).not.toContain('monthly limit')
    expect(tooltipLine(tooltip, 'composer-money-tooltip-line')).toBe(
      'Credit balance $95.50 · Spent today $0.03',
    )
  })

  it('breaks a usage tie on the soonest reset', () => {
    const now = Date.now()
    const tooltip = hoverSummary(
      mountRing({
        planUsage: {
          windows: [
            { kind: 'weekly', usedPercent: 40, resetsAt: now + 5 * 86_400_000 },
            { kind: 'five_hour', usedPercent: 40, resetsAt: now + 3_600_000 },
          ],
        },
      }),
    )
    expect(tooltipLine(tooltip, 'composer-plan-tooltip-line')).toMatch(/^40% of 5-hour limit/)
  })

  it('leaves the balance explanation out of the hover summary', () => {
    const tooltip = hoverSummary(
      mountRing({
        planUsage: {
          windows: [{ kind: 'daily', usedPercent: 72 }],
          amounts: [{ kind: 'limit_remaining', amount: 99.93, currency: 'USD' }],
          balanceNote: 'needs_key',
        },
      }),
    )
    expect(tooltip.textContent).not.toContain('management key')
    expect(tooltipLine(tooltip, 'composer-money-tooltip-line')).toBe('Key limit remaining $99.93')
  })

  it('turns the trigger red when a limit metering this model is used up — and only then', () => {
    const usd = 'USD' as const
    const cases: Array<[string, Partial<RingProps>, boolean]> = [
      ['openrouter balance spent', { providerId: 'openrouter', planUsage: { windows: [], amounts: [
        { kind: 'balance', amount: 0, currency: usd },
        { kind: 'limit_remaining', amount: 99.93, currency: usd },
      ] } }, true],
      ['openrouter balance negative', { providerId: 'openrouter', planUsage: { windows: [], amounts: [
        { kind: 'balance', amount: -0.4, currency: usd },
      ] } }, true],
      ['openrouter key limit used up, balance unknown', { providerId: 'openrouter', planUsage: { windows: [], amounts: [
        { kind: 'limit_remaining', amount: 0, currency: usd },
      ], balanceNote: 'needs_key' } }, true],
      ['credit left', { providerId: 'openrouter', planUsage: { windows: [], amounts: [
        { kind: 'balance', amount: 4.2, currency: usd },
      ] } }, false],
      ['unknown is not zero', { providerId: 'openrouter', planUsage: { windows: [], balanceNote: 'needs_key' } }, false],
      ['spend is not a limit', { providerId: 'kimi', planUsage: { windows: [], amounts: [
        { kind: 'spent', period: 'day', amount: 0, currency: usd },
      ] } }, false],
      ['5-hour window used up', { providerId: 'kimi', planUsage: { windows: [
        { kind: 'five_hour', usedPercent: 100 }, { kind: 'weekly', usedPercent: 40 },
      ] } }, true],
      ['weekly window used up', { providerId: 'kimi', planUsage: { windows: [{ kind: 'weekly', usedPercent: 100 }] } }, true],
      ['monthly window used up', { providerId: 'kimi', planUsage: { windows: [{ kind: 'monthly', usedPercent: 100 }] } }, true],
      ['99% is not used up', { providerId: 'kimi', planUsage: { windows: [{ kind: 'five_hour', usedPercent: 99 }] } }, false],
      // OpenRouter's free-request quota meters free models only.
      ['free quota out, paid model', { providerId: 'openrouter', planUsage: { windows: [
        { kind: 'daily', subject: 'free_requests', usedPercent: 100 },
      ] } }, false],
      ['free quota out, free model', { providerId: 'openrouter', modelFree: true, planUsage: { windows: [
        { kind: 'daily', subject: 'free_requests', usedPercent: 100 },
      ] } }, true],
      ['no usage', {}, false],
    ]
    for (const [name, props, red] of cases) {
      const trigger = mountRing(props)
      expect(trigger.className.includes('bg-destructive/10'), name).toBe(red)
      expect(trigger.hasAttribute('data-limit-reached'), name).toBe(red)
      expect(trigger.getAttribute('aria-label')!.endsWith(' · Usage limit reached'), name).toBe(red)
      cleanup()
    }
  })

  it('marks each used-up window and money row red in the popover, leaving the rest', () => {
    renderRing({
      planUsage: {
        windows: [
          { kind: 'five_hour', usedPercent: 100 },
          { kind: 'weekly', usedPercent: 40 },
        ],
        amounts: [
          { kind: 'balance', amount: 0, currency: 'USD' },
          { kind: 'limit_remaining', amount: 99.93, currency: 'USD' },
          { kind: 'spent', period: 'day', amount: 0.07, currency: 'USD' },
        ],
      },
    })
    const fiveHour = screen.getByTestId('composer-plan-window-five_hour')
    expect(fiveHour.hasAttribute('data-exhausted')).toBe(true)
    expect(fiveHour.className).toContain('text-destructive')
    expect(fiveHour.querySelector('[role="progressbar"] > div')!.className).toContain('bg-destructive')
    const weekly = screen.getByTestId('composer-plan-window-weekly')
    expect(weekly.hasAttribute('data-exhausted')).toBe(false)
    expect(weekly.className).not.toContain('text-destructive')
    expect(screen.getByTestId('composer-plan-amount-balance').hasAttribute('data-exhausted')).toBe(true)
    expect(screen.getByTestId('composer-plan-amount-limit_remaining').hasAttribute('data-exhausted')).toBe(false)
    expect(screen.getByTestId('composer-plan-amount-spent-day').hasAttribute('data-exhausted')).toBe(false)
  })

  it('openrouter: the tooltip folds balance and key limit into one Available; the popover keeps both', () => {
    const planUsage: PlanUsageSnapshot = {
      windows: [],
      amounts: [
        { kind: 'balance', amount: 4.2, currency: 'USD' },
        { kind: 'limit_remaining', amount: 99.93, currency: 'USD' },
        { kind: 'spent', period: 'day', amount: 0.07, currency: 'USD' },
      ],
    }
    const trigger = mountRing({ providerId: 'openrouter', planUsage })
    expect(tooltipLine(hoverSummary(trigger), 'composer-money-tooltip-line')).toBe(
      'Available $4.20 · Spent today $0.07',
    )
    fireEvent.click(trigger)
    expect(screen.getByTestId('composer-plan-amount-balance').textContent).toBe('Credit balance$4.20')
    expect(screen.getByTestId('composer-plan-amount-limit_remaining').textContent).toBe('Key limit remaining$99.93')
  })

  // Regression: with no management key the tooltip read "Available $99.93"
  // off the key limit alone, on an account that may hold nothing.
  it('openrouter: no balance, no Available in the tooltip — the popover still has the key limit', () => {
    const trigger = mountRing({
      providerId: 'openrouter',
      planUsage: {
        windows: [],
        amounts: [
          { kind: 'limit_remaining', amount: 99.93, currency: 'USD' },
          { kind: 'spent', period: 'day', amount: 0.07, currency: 'USD' },
        ],
        balanceNote: 'needs_key',
      },
    })
    const tooltip = hoverSummary(trigger)
    expect(tooltip.textContent).not.toContain('Available')
    expect(tooltipLine(tooltip, 'composer-money-tooltip-line')).toBe('Spent today $0.07')
    fireEvent.click(trigger)
    expect(screen.getByTestId('composer-plan-amount-limit_remaining').textContent).toBe('Key limit remaining$99.93')
    expect(screen.getByTestId('composer-plan-balance-note').textContent).toContain('n/a')
  })

  // Regression: a paid OpenRouter model on a free-tier key showed the
  // free-model request allowance as its headline quota and in the popover,
  // reading as if the paid model were free.
  it('openrouter: the free-request quota shows on a free model only', () => {
    const planUsage: PlanUsageSnapshot = {
      windows: [
        { kind: 'daily', usedPercent: 10 },
        { kind: 'daily', subject: 'free_requests', usedPercent: 60 },
      ],
      amounts: [
        { kind: 'balance', amount: 4.2, currency: 'USD' },
        { kind: 'spent', period: 'day', amount: 0.07, currency: 'USD' },
      ],
    }

    const paid = mountRing({ providerId: 'openrouter', planUsage })
    const paidTooltip = hoverSummary(paid)
    expect(paidTooltip.textContent).not.toContain('Free-model')
    expect(tooltipLine(paidTooltip, 'composer-plan-tooltip-line')).toMatch(/^10% of /)
    expect(tooltipLine(paidTooltip, 'composer-money-tooltip-line')).toBe(
      'Available $4.20 · Spent today $0.07',
    )
    fireEvent.click(paid)
    const paidSection = screen.getByTestId('composer-plan-usage')
    expect(paidSection.textContent).not.toContain('Free-model requests today')
    expect(screen.queryByTestId('composer-plan-window-daily-free_requests')).toBeNull()
    expect(screen.getByTestId('composer-plan-window-daily')).toBeTruthy()
    cleanup()

    const free = mountRing({ providerId: 'openrouter', modelFree: true, planUsage })
    expect(tooltipLine(hoverSummary(free), 'composer-plan-tooltip-line')).toMatch(/^60% of /)
    fireEvent.click(free)
    expect(screen.getByTestId('composer-plan-usage').textContent).toContain('Free-model requests today')
    expect(screen.getByTestId('composer-plan-window-daily-free_requests')).toBeTruthy()
    expect(screen.queryByTestId('composer-plan-window-daily')).toBeNull()
  })

  it('without a plan, context leads and no quota or money line renders', () => {
    const tooltip = hoverSummary(mountRing({ messages }))
    expect(tooltipLine(tooltip, 'composer-plan-tooltip-line')).toBeUndefined()
    expect(tooltipLine(tooltip, 'composer-money-tooltip-line')).toBeUndefined()
    expect(tooltipLine(tooltip, 'composer-context-tooltip-line')).toMatch(/^Context /)
  })

  it('omits the cache segment and tooltip line when the last turn is 0%', () => {
    const trigger = mountRing({
      messages: [
        assistant({ input_tokens: 10, cache_read_input_tokens: 90 }),
        assistant({ input_tokens: 100, output_tokens: 5 }),
      ],
    })
    expect(screen.queryByTestId('composer-cache-ratio')).toBeNull()
    expect(trigger.getAttribute('aria-label')).toMatch(/^Context \d+% used$/)
    expect(hoverSummary(trigger).textContent).not.toContain('cache')
  })

  it("reads the in-flight turn's usage while streaming", () => {
    mountRing({
      messages,
      isStreaming: true,
      liveEvents: [
        {
          type: 'stream_event',
          event: {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 50,
                cache_read_input_tokens: 50,
                cache_creation_input_tokens: 0,
              },
            },
          },
        } as unknown as StreamRecord,
      ],
    })
    expect(screen.getByTestId('composer-cache-ratio').textContent).toBe('50%')
  })
})

// On launch the first catalog often lands before OpenRouter's listing does, so
// it carries no figures for the session's model and the ring reads the 200K
// fallback. The listing's catalog then mirrors the real window into this
// realm's NEXUS_MODEL_CONFIG in place — the ring must re-read it on that new
// catalog, not keep the 200K (red) reading until the session changes.
describe('composer context ring — catalog figures that land after mount', () => {
  // The reported session's shape: an OpenRouter entry the user added, whose
  // id is its own `latest` resolution.
  const modelId = '~deepseek/deepseek-flash-latest'
  const NO_EVENTS: StreamRecord[] = []
  const catalogWith = (contextWindow?: number): BrowserLlmCatalog => ({
    providers: [
      {
        id: 'openrouter',
        label: 'OpenRouter',
        iconSvg: '<svg />',
        enabled: true,
        models: [
          {
            id: modelId,
            label: 'First load',
            enabled: true,
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            entry: {
              kind: 'latest',
              family: modelId,
              familyLabel: 'DeepSeek Flash',
              version: 'latest',
              resolvedId: modelId,
              preview: false,
            },
          },
        ],
        entryFamilies: [],
      },
    ],
  })

  // The mirrored row lives in the shared table; a catalog without figures
  // drops it again.
  afterEach(() => {
    createConfiguredModelCatalog(catalogWith())
    resetEntryResolutions()
  })

  it('re-reads the window when a catalog with the listing arrives', () => {
    // Held across renders: only the catalog changes, as on launch.
    const transcript = [assistant({ input_tokens: 190_000 })]
    const early = createConfiguredModelCatalog(catalogWith())
    const ring = (catalog: BrowserLlmCatalog | null | undefined) =>
      createElement(
        TooltipProvider,
        null,
        createElement(TokenUsageIndicator, {
          messages: transcript,
          liveEvents: NO_EVENTS,
          modelId,
          providerId: 'openrouter',
          catalog,
          isStreaming: false,
        }),
      )
    const { rerender } = render(ring(early))
    fireEvent.click(screen.getByTestId('composer-context-usage'))
    expect(screen.getByTestId('composer-context-popover').textContent).toContain('200k')

    const listed = createConfiguredModelCatalog(catalogWith(1_048_576))
    rerender(ring(listed))
    const popover = screen.getByTestId('composer-context-popover')
    expect(popover.textContent).toContain('1.05M')
    expect(popover.textContent).not.toContain('200k')
  })

  it('does not re-walk the transcript when a catalog arrives — it is a new object on every state push', () => {
    // Worker snapshots are structured-cloned, so `catalog` changes identity
    // whether or not its figures did. The O(messages) usage walk must key on
    // the transcript alone: count reads of the held array.
    let reads = 0
    const transcript = new Proxy([assistant({ input_tokens: 190_000 })], {
      get(target, key, receiver) {
        reads += 1
        return Reflect.get(target, key, receiver)
      },
    })
    const ring = (catalog: BrowserLlmCatalog | null | undefined) =>
      createElement(
        TooltipProvider,
        null,
        createElement(TokenUsageIndicator, {
          messages: transcript,
          liveEvents: NO_EVENTS,
          modelId,
          providerId: 'openrouter',
          catalog,
          isStreaming: false,
        }),
      )
    const { rerender } = render(ring(createConfiguredModelCatalog(catalogWith())))
    expect(reads).toBeGreaterThan(0)
    const afterMount = reads
    rerender(ring(createConfiguredModelCatalog(catalogWith())))
    rerender(ring(createConfiguredModelCatalog(catalogWith())))
    expect(reads).toBe(afterMount)
  })
})
