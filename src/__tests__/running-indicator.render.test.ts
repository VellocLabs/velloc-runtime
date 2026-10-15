import { describe, expect, it } from 'vitest'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  providerApiErrorKindLabel,
  RunningIndicatorView,
  resolveRunningIndicatorVisibility,
  retryReasonText,
  runningStatusText,
  thinkingVerb,
} from '../components/assistant-ui/running-indicator'
import { FOOTER_BAR_FRAME } from '../components/assistant-ui/footer-bar-frame'
import { createTranslate } from '../browser/webview/i18n'

/**
 * The conversation running-indicator: the status string is pure (the translator is a parameter) and the `View`
 * renders without assistant-ui/bridge hooks; both the English baseline and a non-English locale are pinned.
 */
const t = createTranslate('en')

describe('runningStatusText', () => {
  it('escalates the thinking verb by elapsed time', () => {
    expect(thinkingVerb(t, 0)).toBe('thinking')
    expect(thinkingVerb(t, 7_999)).toBe('thinking')
    expect(thinkingVerb(t, 8_000)).toBe('thinking more')
    expect(thinkingVerb(t, 20_000)).toBe('almost done thinking')
  })

  it('shows the thinking verb + token count while generating', () => {
    expect(
      runningStatusText(t, { phase: 'thinking', generatedTokens: 1800, thinkingElapsedMs: 0 }),
    ).toBe('thinking · 1.8k tokens')
    expect(
      runningStatusText(t, { phase: 'thinking', generatedTokens: 0, thinkingElapsedMs: 25_000 }),
    ).toBe('almost done thinking')
  })

  it("shows the running tool's name while a tool/mcp is in flight", () => {
    expect(
      runningStatusText(t, { phase: 'tool', activeName: 'Read', generatedTokens: 1800, thinkingElapsedMs: 0 }),
    ).toBe('Read · 1.8k tokens')
    expect(
      runningStatusText(t, { phase: 'mcp', activeName: null, generatedTokens: 0, thinkingElapsedMs: 0 }),
    ).toBe('running task')
  })

  it('omits the token segment when usage is absent (0) — models that report no usage', () => {
    expect(
      runningStatusText(t, { phase: 'thinking', generatedTokens: 0, thinkingElapsedMs: 0 }),
    ).toBe('thinking')
    expect(
      runningStatusText(t, { phase: 'tool', activeName: 'Bash', generatedTokens: 0, thinkingElapsedMs: 0 }),
    ).toBe('Bash')
  })
})

/**
 * Locale coverage. The line used to be built from hardcoded English literals
 * even though the surrounding component already used `useT()`; every segment
 * now comes from the `statusBar.*` catalog keys, so a non-English webview gets
 * a translated status instead of an English island.
 */
describe('runningStatusText — locale', () => {
  const zh = createTranslate('zh')

  it('translates the thinking verb, the tool placeholder and the token suffix', () => {
    expect(
      runningStatusText(zh, { phase: 'thinking', generatedTokens: 1800, thinkingElapsedMs: 0 }),
    ).toBe('思考中 · 1.8k tokens')
    expect(
      runningStatusText(zh, { phase: 'thinking', generatedTokens: 0, thinkingElapsedMs: 25_000 }),
    ).toBe('即将思考完毕')
    expect(
      runningStatusText(zh, { phase: 'mcp', activeName: null, generatedTokens: 0, thinkingElapsedMs: 0 }),
    ).toBe('执行任务中')
  })

  it('translates the retry countdown, keeping the attempt numbers interpolated', () => {
    expect(
      runningStatusText(zh, {
        phase: 'thinking',
        activeRetry: { remainingSeconds: 5, attempt: 3, maxRetries: 10 },
        generatedTokens: 0,
        thinkingElapsedMs: 0,
      }),
    ).toBe('5 秒后重试（第 3/10 次）')
    expect(
      runningStatusText(zh, {
        phase: 'thinking',
        activeRetry: { remainingSeconds: 0, attempt: 3, maxRetries: 10 },
        generatedTokens: 0,
        thinkingElapsedMs: 0,
      }),
    ).toBe('开始第 3/10 次重试')
    // In-flight attempt with the live elapsed counter (inFlightSeconds).
    expect(
      runningStatusText(zh, {
        phase: 'thinking',
        activeRetry: {
          remainingSeconds: 0,
          inFlightSeconds: 12,
          attempt: 3,
          maxRetries: 10,
        },
        generatedTokens: 0,
        thinkingElapsedMs: 0,
      }),
    ).toBe('第 3/10 次重试进行中（已 12 秒）')
  })

  it("keeps the tool's own name untranslated — it is an identifier, not chrome", () => {
    expect(
      runningStatusText(zh, { phase: 'tool', activeName: 'Read', generatedTokens: 0, thinkingElapsedMs: 0 }),
    ).toBe('Read')
  })
})

/**
 * Provider-retry status: translated under `en`; counts the in-flight attempt up via `inFlightSeconds` while the
 * phase stays `retry`; names what the provider returned, not the classifier slug.
 */
describe('runningStatusText — provider retry', () => {
  const retry = {
    remainingSeconds: 5,
    attempt: 3,
    maxRetries: 10,
    errorKind: 'server_error',
    // Current workers send the catalog KEY; the indicator resolves it. The
    // legacy pre-i18n `errorTitle` path is covered in `retryReasonText` below.
    errorTitleKey: 'providerIssue.serviceUnavailable.title',
    errorDetail: 'HTTP 503: upstream connect timeout',
  }

  it('counts down in English, with the human reason and the provider detail', () => {
    const text = runningStatusText(t, {
      phase: 'thinking',
      activeRetry: retry,
      generatedTokens: 0,
      thinkingElapsedMs: 0,
    })
    expect(text).toBe(
      'retrying in 5s (attempt 3/10) · Provider service unavailable · HTTP 503: upstream connect timeout',
    )
    // Under the `en` translator no segment may be CJK — the original bug was a
    // Chinese literal that survived regardless of locale. (Genuine Chinese
    // output is now a `zh` concern, covered in the locale describe above.)
    expect(text).not.toMatch(/[一-鿿]/)
  })

  it('counts the in-flight attempt UP once the countdown reaches 0', () => {
    // The phase stays `retry` until the provider's first stream event — for a
    // stream-idle timeout that is minutes. A static label read as a stuck UI
    // (the user watched "starting retry 1/10" for 90s+); the elapsed counter
    // makes the wait visibly progress.
    const at = (inFlightSeconds: number) =>
      runningStatusText(t, {
        phase: 'thinking',
        activeRetry: { ...retry, remainingSeconds: 0, inFlightSeconds },
        generatedTokens: 0,
        thinkingElapsedMs: 0,
      })
    expect(at(12)).toContain('retry 3/10 in progress (12s)')
    // Consecutive worker ticks must change the rendered line.
    expect(at(13)).not.toBe(at(12))
  })

  it('falls back to the static "starting" label when inFlightSeconds is absent (old worker)', () => {
    const text = runningStatusText(t, {
      phase: 'thinking',
      activeRetry: { ...retry, remainingSeconds: 0 },
      generatedTokens: 0,
      thinkingElapsedMs: 0,
    })
    expect(text).toContain('starting retry 3/10')
    expect(text).not.toContain('0s')
  })

  it('takes priority over the token count and the thinking verb', () => {
    expect(
      runningStatusText(t, {
        phase: 'thinking',
        activeRetry: { remainingSeconds: 2, attempt: 1, maxRetries: 10 },
        generatedTokens: 1800,
        thinkingElapsedMs: 25_000,
      }),
    ).toBe('retrying in 2s (attempt 1/10)')
  })
})

/**
 * The slug→label step the status line and the transcript's
 * `ProviderApiErrorCard` now share. The card used to de-slug `apiErrorKind`
 * itself (`kind.replace(/_/g, ' ')`), which is how a Chinese user got a
 * Chinese "provider request failed" heading over a row reading "issue: unknown" — the
 * one word in the card that never reached the catalog.
 */
describe('providerApiErrorKindLabel', () => {
  it('resolves every classifier slug through the catalog', () => {
    expect(providerApiErrorKindLabel(t, 'repetitive_tool_calls')).toBe(
      'repetitive tool calls',
    )
    expect(providerApiErrorKindLabel(t, 'unknown')).toBe('connection error')
    expect(providerApiErrorKindLabel(t, 'authentication_failed')).toBe(
      'authentication failed',
    )
    // A 402 used to have no slug of its own and read "invalid request".
    expect(providerApiErrorKindLabel(t, 'billing_error')).toBe('insufficient credits')
    expect(providerApiErrorKindLabel(createTranslate('zh'), 'billing_error')).toBe(
      '额度不足',
    )
  })

  it('follows the webview locale rather than rendering the raw slug', () => {
    const zh = createTranslate('zh')
    expect(providerApiErrorKindLabel(zh, 'unknown')).toBe('连接错误')
    expect(providerApiErrorKindLabel(zh, 'repetitive_tool_calls')).toBe(
      '工具调用重复',
    )
    expect(providerApiErrorKindLabel(createTranslate('ja'), 'rate_limit')).toBe(
      'プロバイダのレート制限',
    )
  })

  it('de-slugs an unmapped kind instead of handing it to t()', () => {
    // `t()` echoes an unknown key back verbatim, so a slug with no catalog
    // entry must never reach it — it would render as a bogus dotted key.
    expect(providerApiErrorKindLabel(t, 'some_new_kind')).toBe('some new kind')
    expect(providerApiErrorKindLabel(createTranslate('zh'), 'some_new_kind')).toBe(
      'some new kind',
    )
  })
})

describe('retryReasonText', () => {
  it('prefers the classifier title and appends the provider detail', () => {
    expect(
      retryReasonText(t, {
        remainingSeconds: 1,
        attempt: 1,
        maxRetries: 10,
        errorKind: 'rate_limit',
        errorTitleKey: 'providerIssue.rateLimit.title',
        errorDetail: 'HTTP 429: too many requests',
      }),
    ).toBe('Provider rate limit reached · HTTP 429: too many requests')
  })

  it('falls back to a readable label when only the slug is known (old worker)', () => {
    expect(
      retryReasonText(t, {
        remainingSeconds: 1,
        attempt: 1,
        maxRetries: 10,
        errorKind: 'server_error',
      }),
    ).toBe('provider server error')
    // Unknown slugs still beat raw snake_case — and must NOT be handed to
    // `t()`, which would echo the slug back as a bogus catalog key.
    expect(
      retryReasonText(t, {
        remainingSeconds: 1,
        attempt: 1,
        maxRetries: 10,
        errorKind: 'some_new_kind',
      }),
    ).toBe('some new kind')
  })

  it('translates the classification key and the slug fallback', () => {
    const zh = createTranslate('zh')
    expect(
      retryReasonText(zh, {
        remainingSeconds: 1,
        attempt: 1,
        maxRetries: 10,
        errorKind: 'server_error',
      }),
    ).toBe('服务商服务器错误')
    // The point of the key migration: the classification follows the
    // webview's locale. It used to arrive as an English literal from the
    // worker and render as English inside an otherwise-Chinese status line.
    expect(
      retryReasonText(zh, {
        remainingSeconds: 1,
        attempt: 1,
        maxRetries: 10,
        errorKind: 'server_error',
        errorTitleKey: 'providerIssue.serviceUnavailable.title',
      }),
    ).toBe('服务商服务不可用')
  })

  it('falls back to a pre-i18n worker’s English title text', () => {
    // A SharedWorker from before the key migration sends resolved English on
    // `errorTitle` and no key. Showing it beats showing the bare slug, so it
    // is passed through verbatim — it is already text, not a key.
    expect(
      retryReasonText(t, {
        remainingSeconds: 1,
        attempt: 1,
        maxRetries: 10,
        errorKind: 'server_error',
        errorTitle: 'Provider service unavailable',
      }),
    ).toBe('Provider service unavailable')
  })

  it('ignores a classification key this build has no catalog entry for', () => {
    // The reverse skew: a NEWER worker names a verdict key this bundle
    // predates. `t()` echoes an unknown key verbatim, so without the
    // `isMessageKey` gate the status line would read
    // "providerIssue.somethingNew.title". It must fall through the ladder.
    expect(
      retryReasonText(t, {
        remainingSeconds: 1,
        attempt: 1,
        maxRetries: 10,
        errorKind: 'server_error',
        errorTitleKey: 'providerIssue.somethingNew.title',
      }),
    ).toBe('provider server error')
    // …and with no slug either, the reason is simply empty — never a key.
    expect(
      retryReasonText(t, {
        remainingSeconds: 1,
        attempt: 1,
        maxRetries: 10,
        errorTitleKey: 'providerIssue.somethingNew.title',
      }),
    ).toBe('')
  })

  it('flattens and truncates a long multi-line provider body', () => {
    const reason = retryReasonText(t, {
      remainingSeconds: 1,
      attempt: 1,
      maxRetries: 10,
      errorTitleKey: 'providerIssue.serviceUnavailable.title',
      errorDetail: `HTTP 500:\n{\n  "error": "${'x'.repeat(300)}"\n}`,
    })
    expect(reason).not.toContain('\n')
    expect(reason.endsWith('…')).toBe(true)
    // title + ' · ' + 120 detail chars — bounded, so the row still shows the
    // countdown that precedes it.
    expect(reason.length).toBeLessThanOrEqual(
      'Provider service unavailable'.length + 3 + 120,
    )
  })

  it('drops a detail that merely repeats the title, and yields nothing when empty', () => {
    expect(
      retryReasonText(t, {
        remainingSeconds: 1,
        attempt: 1,
        maxRetries: 10,
        errorTitleKey: 'providerIssue.network.title',
        errorDetail: 'network connection issue',
      }),
    ).toBe('Network connection issue')
    expect(
      retryReasonText(t, { remainingSeconds: 1, attempt: 1, maxRetries: 10 }),
    ).toBe('')
  })
})

/**
 * The run gate: both inputs ride the session port the composer's Send/Stop gate reads, so the indicator and the
 * composer agree on whether a turn is in flight.
 */
describe('resolveRunningIndicatorVisibility', () => {
  it('shows while assistant-ui reports a live run', () => {
    expect(
      resolveRunningIndicatorVisibility({ isRunning: true, sessionBusy: true }),
    ).toBe(true)
  })

  // The gap the old sessionPhase OR existed for: during a provider retry (and
  // before the turn's first message) there is no live assistant message, so
  // assistant-ui's message-derived isRunning is false while the turn runs.
  it('shows when only the session snapshot is busy (retry / pre-first-token)', () => {
    expect(
      resolveRunningIndicatorVisibility({ isRunning: false, sessionBusy: true }),
    ).toBe(true)
  })

  // The reported bug, pinned: turn over on the session port → hidden, no
  // matter what a stale broadcast might still be claiming.
  it('hides once the turn is over on the session port', () => {
    expect(
      resolveRunningIndicatorVisibility({ isRunning: false, sessionBusy: false }),
    ).toBe(false)
  })
})

describe('RunningIndicatorView render', () => {
  it('animates the blob and shows elapsed time before the status text while running', () => {
    const html = renderToStaticMarkup(
      createElement(RunningIndicatorView, {
        running: true,
        elapsed: '12s',
        statusText: 'thinking · 1.8k tokens',
      }),
    )
    // Running → the animation classes the globals.css keyframes target are present.
    expect(html).toContain('nexus-blob-orbit')
    expect(html).toContain('nexus-blob-core')
    // currentColor everywhere → strictly monochrome (no hardcoded hue).
    expect(html).toContain('fill="currentColor"')
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/)
    // …and the one hue is the ACCENT: `text-primary` on the <svg> makes
    // currentColor resolve to `--primary` — the token the composer's Send
    // button fills itself with, which the Appearance accent swatch rewrites —
    // instead of the row's near-black foreground.
    expect(html).toContain('class="nexus-running-blob text-primary"')
    // Only the blob follows the accent; the status text stays muted.
    expect(html).toContain('text-muted-foreground')
    expect(html).toContain('12s')
    expect(html).toContain('thinking · 1.8k tokens')
    // The elapsed time renders BEFORE the status text.
    expect(html.indexOf('12s')).toBeLessThan(html.indexOf('thinking · 1.8k tokens'))
    expect(html).toContain('data-running="true"')
  })

  // The turn's status is LIVE-only. It used to freeze instead — a static blob
  // holding the last text at 45% opacity — which read as "still thinking" over
  // an already-idle composer. Ending a turn now removes the cluster outright.
  it('drops the whole status cluster when the turn ends', () => {
    const html = renderToStaticMarkup(
      createElement(RunningIndicatorView, {
        running: false,
        elapsed: '1m 11s',
        statusText: 'almost done thinking · 12k tokens',
      }),
    )
    expect(html).not.toContain('nexus-running-blob')
    expect(html).not.toContain('nexus-blob-orbit')
    expect(html).not.toContain('nexus-blob-core')
    expect(html).not.toContain('data-running="true"')
    // No frozen leftovers: neither the final time nor the last status survives.
    expect(html).not.toContain('1m 11s')
    expect(html).not.toContain('almost done thinking · 12k tokens')
  })

  // The idle notice is where the removed continue banner's sentence went: it
  // explains why the composer is offering "Continue" instead of "Send".
  it('shows the idle notice in the settled row', () => {
    const html = renderToStaticMarkup(
      createElement(RunningIndicatorView, {
        running: false,
        elapsed: '1m 11s',
        statusText: 'almost done thinking',
        idleNotice: 'Conversation was cancelled',
      }),
    )
    expect(html).toContain('Conversation was cancelled')
    expect(html).toContain('status-bar-idle-notice')
    // Still no frozen live status alongside it.
    expect(html).not.toContain('almost done thinking')
    expect(html).not.toContain('1m 11s')
  })

  // While the turn runs, the live status owns the line — a stale "conversation
  // was cancelled" next to an animating blob would contradict it.
  it('hides the idle notice while the turn is running', () => {
    const html = renderToStaticMarkup(
      createElement(RunningIndicatorView, {
        running: true,
        elapsed: '3s',
        statusText: 'thinking',
        idleNotice: 'Conversation was cancelled',
      }),
    )
    expect(html).not.toContain('Conversation was cancelled')
    expect(html).toContain('thinking')
  })

  // The status bar wears the footer-bar frame the mods' band and status lines
  // share, and its row is the compact 32px one (min-h-8, down from min-h-10).
  it('wears the shared footer-bar frame at the compact height', () => {
    const html = renderToStaticMarkup(
      createElement(RunningIndicatorView, { running: true, elapsed: '3s', statusText: 'thinking' }),
    )
    const cls = /data-slot="nexus-status-bar"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? ''
    for (const token of FOOTER_BAR_FRAME.split(' ')) expect(cls.split(' ')).toContain(token)
    expect(cls.split(' ')).toContain('min-h-8')
    expect(cls).not.toContain('min-h-10')
  })

  it('renders just the time when there is no status text yet', () => {
    const html = renderToStaticMarkup(
      createElement(RunningIndicatorView, { running: true, elapsed: '3s', statusText: '' }),
    )
    expect(html).toContain('3s')
  })

  // Layout pin for the "16m 51s on two lines" bug: the elapsed span is a flex
  // item whose min-content width is its longest WORD, so a long status text
  // squeezed it and the space in "16m 51s" became a line break. It must be
  // exempt from both shrinking and wrapping.
  it('never lets the elapsed time shrink or wrap under a long status text', () => {
    const html = renderToStaticMarkup(
      createElement(RunningIndicatorView, {
        running: true,
        elapsed: '16m 51s',
        statusText:
          'starting retry 1/10 · Provider service unavailable · native host reported no chunks for 94s (stream cancelled upstream)',
      }),
    )
    const elapsedSpan = html.match(/<span class="([^"]*)">16m 51s<\/span>/)
    expect(elapsedSpan, 'elapsed span must render with its own class list').toBeTruthy()
    expect(elapsedSpan![1]).toContain('shrink-0')
    expect(elapsedSpan![1]).toContain('whitespace-nowrap')
  })

  // Layout pin for the jittering retry countdown: the status text carries live
  // counters (`retrying in 8s (attempt 1/10)`, token counts) that re-render once
  // a second, and in the proportional default digit glyphs have different
  // advance widths — an `8` is wider than a `1` — so each tick resized the line
  // and the text visibly danced. Both number-bearing spans must be tabular.
  it('renders the live status counters with fixed-width digits', () => {
    const statusText = 'retrying in 8s (attempt 1/10) · Provider overloaded'
    const html = renderToStaticMarkup(
      createElement(RunningIndicatorView, {
        running: true,
        elapsed: '16m 51s',
        statusText,
      }),
    )
    const statusSpan = html.match(
      new RegExp(`<span class="([^"]*)"[^>]*>${statusText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`),
    )
    expect(statusSpan, 'status-text span must render with its own class list').toBeTruthy()
    expect(statusSpan![1]).toContain('tabular-nums')
    const elapsedSpan = html.match(/<span class="([^"]*)">16m 51s<\/span>/)
    expect(elapsedSpan![1]).toContain('tabular-nums')
  })

  it('renders the collapse-all status-bar action (lock-to-bottom moved to the floating button)', () => {
    const html = renderToStaticMarkup(
      createElement(RunningIndicatorView, {
        running: true,
        elapsed: '3s',
        statusText: 'thinking',
        onAction: () => {},
      }),
    )
    expect(html).toContain('data-slot="nexus-status-bar"')
    expect(html).toContain('data-testid="status-bar-collapse-all"')
    expect(html).not.toContain('data-testid="status-bar-lock-bottom"')
    expect(html).not.toContain('data-testid="status-bar-right-panel-toggle"')
    expect(html).toContain('aria-label="Collapse all"')
  })

  // Same row, no status cluster — the state a never-run thread starts in AND
  // the one a finished turn returns to. The actions must survive both, so
  // collapse-all stays reachable in a settled conversation.
  it('keeps the action-only status bar when not running', () => {
    const html = renderToStaticMarkup(
      createElement(RunningIndicatorView, {
        running: false,
        elapsed: '0s',
        statusText: '',
        onAction: () => {},
      }),
    )
    expect(html).toContain('data-slot="nexus-status-bar"')
    expect(html).toContain('data-testid="status-bar-collapse-all"')
    expect(html).not.toContain('data-testid="status-bar-lock-bottom"')
    expect(html).not.toContain('data-testid="status-bar-right-panel-toggle"')
    expect(html).not.toContain('nexus-running-blob')
    expect(html).not.toContain('0s')
  })

  // Regression guard for the duplicate-filter-id "one SVG vanishes" bug: two
  // mounted blobs must get distinct goo `<filter>` ids (derived from useId).
  it('gives each mounted blob a unique goo filter id', () => {
    const html = renderToStaticMarkup(
      createElement(Fragment, null, [
        createElement(RunningIndicatorView, { key: 'a', running: true, elapsed: '1s', statusText: 'thinking' }),
        createElement(RunningIndicatorView, { key: 'b', running: true, elapsed: '1s', statusText: 'thinking' }),
      ]),
    )
    const ids = [...html.matchAll(/id="(nexus-blob-goo-[^"]+)"/g)].map((m) => m[1])
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) {
      expect(html).toContain(`url(#${id})`)
    }
  })
})
