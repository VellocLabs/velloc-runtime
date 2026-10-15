// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, useState, type FC, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  useComposerRuntime,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { TooltipProvider } from '../components/ui/tooltip'
import {
  NextMessageStrip,
  PendingMessageProvider,
  PendingMessageEntriesProvider,
  ClearPendingMessageProvider,
  NEXT_MESSAGE_ROTATE_MS,
  nextRotateIndex,
  resolveQueuedMessages,
  restoreNextMessageIntoComposer,
  splitPendingMessages,
} from '../components/assistant-ui/next-message-strip'

// The strip reads its strings through i18n; echo the key so assertions can
// match it. Real catalogs translate 'composer.nextMessage' → 'Next message'.
vi.mock('../browser/webview/i18n', () => ({
  useT: () => (key: string) => key,
}))

afterEach(() => cleanup())

/** Exposes the assistant-ui composer runtime to the test via a ref callback so
 *  assertions can read `composer.getState().text` after the strip's × handler
 *  runs. Renders nothing itself. */
const ComposerProbe: FC<{
  initialText: string
  onReady: (text: () => string) => void
}> = ({ initialText, onReady }) => {
  const composer = useComposerRuntime()
  useState(() => {
    if (initialText) composer.setText(initialText)
    onReady(() => composer.getState().text)
    return 0
  })
  return null
}

type HarnessProps = {
  pendingMessage: string | null
  /** The worker's entry list (one per parked submit). Omitted ⇒ the strip
   *  falls back to splitting `pendingMessage`. */
  pendingEntries?: string[] | null
  onClear?: (() => void) | null
  initialText?: string
  /** Receives a getter for the live composer text once mounted. */
  onComposerReady?: (getText: () => string) => void
}

function Harness({ pendingMessage, pendingEntries = null, onClear = null, initialText = '', onComposerReady }: HarnessProps) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: (m) => m,
    isRunning: false,
    onNew: async () => {},
  })

  const tree: ReactNode = createElement(
    PendingMessageProvider,
    { value: pendingMessage },
    createElement(
      PendingMessageEntriesProvider,
      { value: pendingEntries },
      createElement(
        ClearPendingMessageProvider,
        { value: onClear },
        createElement(NextMessageStrip),
        createElement(ComposerProbe, {
          initialText,
          onReady: (getText: () => string) => onComposerReady?.(getText),
        }),
      ),
    ),
  )

  return createElement(
    TooltipProvider,
    null,
    createElement(AssistantRuntimeProvider, { runtime }, tree),
  )
}

describe('NextMessageStrip', () => {
  it('renders nothing when there is no pending message', () => {
    render(createElement(Harness, { pendingMessage: null }))
    expect(screen.queryByTestId('next-message-strip')).toBeNull()
  })

  it('renders the message (truncated by CSS) and a title tooltip', () => {
    render(createElement(Harness, { pendingMessage: 'please update the README' }))
    const summary = screen.getByTestId('next-message-text')
    expect(summary.getAttribute('title')).toBe('please update the README')
    expect(summary.textContent).toBe('please update the README')
    // One line, ellipsis-truncated.
    expect(summary.className).toContain('truncate')
    expect(summary.className).toContain('whitespace-nowrap')
    // A single queued message needs no count badge.
    expect(screen.queryByTestId('next-message-count')).toBeNull()
  })

  // The strip is a fixed-height status line, not a growing list. Rendering every
  // queued line stacked it into a block that pushed the composer around and read
  // as a second transcript; one message at a time plus the `i/N` position badge
  // says the same thing in one row, and the timer cycles through the rest.
  it('shows the FIRST queued message plus a 1/N position badge when more are queued', () => {
    render(
      createElement(Harness, {
        pendingMessage: 'check the tests\nthen update the docs\nand ship it',
      }),
    )
    const summary = screen.getByTestId('next-message-text')
    expect(summary.textContent).toBe('check the tests')
    expect(summary.textContent).not.toContain('then update the docs')
    expect(summary.textContent).not.toContain('and ship it')

    const badge = screen.getByTestId('next-message-count')
    expect(badge.textContent).toBe('1/3')
    expect(badge.getAttribute('aria-label')).toBe('composer.nextMessagePosition')

    // The hidden ones are still reachable without clicking anything.
    expect(summary.getAttribute('title')).toBe(
      'check the tests\nthen update the docs\nand ship it',
    )
  })

  // Regression: the count was derived by splitting the worker's newline-JOINED
  // text, so a single Shift+Enter submit counted once per line. One parked
  // 3-line message rendered a 3-slot queue and showed only its first line —
  // the strip claimed a queue that did not exist.
  it('counts MESSAGES, not lines, when a parked submit is itself multi-line', () => {
    render(
      createElement(Harness, {
        pendingMessage: 'first line\nsecond line\nthird line',
        pendingEntries: ['first line\nsecond line\nthird line'],
      }),
    )
    // One message ⇒ no badge at all.
    expect(screen.queryByTestId('next-message-count')).toBeNull()
    // …and the shown message is the WHOLE submit, not its first line (CSS
    // collapses the newlines onto the strip's single row).
    expect(screen.getByTestId('next-message-text').textContent).toBe(
      'first line\nsecond line\nthird line',
    )
  })

  it('counts a multi-line submit as one entry alongside single-line ones', () => {
    render(
      createElement(Harness, {
        pendingMessage: 'do this\nand that\nplus the other\nthen ship it',
        pendingEntries: ['do this\nand that\nplus the other', 'then ship it'],
      }),
    )
    // Two submits, four lines. Splitting the text would say 4.
    expect(screen.getByTestId('next-message-count').textContent).toBe('1/2')
    expect(screen.getByTestId('next-message-text').textContent).toBe(
      'do this\nand that\nplus the other',
    )
  })

  it('falls back to splitting the text when the worker sent no entry list', () => {
    // Older worker (or an embed that only has the joined text): the strip still
    // renders a plausible queue rather than nothing.
    render(
      createElement(Harness, {
        pendingMessage: 'one\ntwo',
        pendingEntries: null,
      }),
    )
    expect(screen.getByTestId('next-message-count').textContent).toBe('1/2')
    expect(screen.getByTestId('next-message-text').textContent).toBe('one')
  })

  it('keeps the row one line high however many messages are queued', () => {
    const { rerender } = render(createElement(Harness, { pendingMessage: 'one' }))
    const single = screen.getByTestId('next-message-strip').className
    rerender(
      createElement(Harness, { pendingMessage: 'one\ntwo\nthree\nfour' }),
    )
    const many = screen.getByTestId('next-message-strip')
    // Same layout classes either way — only the transient landed marker differs
    // (this rerender is an append, so it is present).
    expect(many.className.replace(' nexus-pending-landed', '')).toBe(single)
    expect(many.querySelectorAll('[data-testid="next-message-text"]')).toHaveLength(1)
    expect(screen.getByTestId('next-message-text').className).toContain(
      'whitespace-nowrap',
    )
  })

  it('× still hands back EVERY queued message, not just the shown one', async () => {
    const onClear = vi.fn()
    let getText: (() => string) | null = null
    render(
      createElement(Harness, {
        pendingMessage: 'shown one\nhidden one',
        onClear,
        initialText: '',
        onComposerReady: (g: () => string) => { getText = g },
      }),
    )
    fireEvent.click(screen.getByTestId('next-message-clear'))
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1))
    expect(getText!()).toBe('shown one\nhidden one')
  })

  it('marks the role with an icon, not the words "Next message"', () => {
    render(createElement(Harness, { pendingMessage: 'please update the README' }))
    const strip = screen.getByTestId('next-message-strip')
    // The label is gone from the visible text. (`composer.removeNextMessage`
    // remains — that is the × button's sr-only tooltip label, not a visible
    // caption.)
    expect(strip.textContent).not.toContain('composer.nextMessage')
    // …but it survives as the icon's accessible name and hover tooltip, so the
    // catalog key is still what every locale renders.
    const icon = screen.getByTestId('next-message-icon')
    expect(icon.getAttribute('aria-label')).toBe('composer.nextMessage')
    expect(icon.getAttribute('title')).toBe('composer.nextMessage')
    expect(icon.querySelector('svg')).not.toBeNull()
  })

  it('sizes to its text and caps at 40% of the footer width (never full-width)', () => {
    render(createElement(Harness, { pendingMessage: 'please update the README' }))
    const strip = screen.getByTestId('next-message-strip')
    // shrink-to-fit content, capped at 40%; the row stays right-aligned.
    expect(strip.className).toContain('w-fit')
    expect(strip.className).toContain('max-w-[40%]')
    expect(strip.className).not.toContain('max-w-[33%]')
    expect(strip.className).not.toContain('max-w-full')
  })

  it('exposes an accessible remove button labelled "Remove next message"', () => {
    render(createElement(Harness, { pendingMessage: 'x' }))
    const btn = screen.getByTestId('next-message-clear')
    expect(btn.getAttribute('aria-label')).toBe('composer.removeNextMessage')
  })

  it('clicking × restores the text into an EMPTY composer and calls onClear', async () => {
    const onClear = vi.fn()
    let getText: (() => string) | null = null
    render(
      createElement(Harness, {
        pendingMessage: 'restore me',
        onClear,
        initialText: '',
        onComposerReady: (g) => { getText = g },
      }),
    )
    fireEvent.click(screen.getByTestId('next-message-clear'))
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1))
    expect(getText!()).toBe('restore me')
  })

  it('clicking × appends after an existing draft with a newline separator', async () => {
    const onClear = vi.fn()
    let getText: (() => string) | null = null
    render(
      createElement(Harness, {
        pendingMessage: 'second line',
        onClear,
        initialText: 'first line',
        onComposerReady: (g) => { getText = g },
      }),
    )
    fireEvent.click(screen.getByTestId('next-message-clear'))
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1))
    expect(getText!()).toBe('first line\nsecond line')
  })
})

// With more than one message queued the strip cycles through them on a timer
// (1/N → 2/N → … → back to 1/N), so every parked message becomes visible
// without the strip ever growing. These pin the cycle: order, wrap, the
// single-message no-op, the interval constant, and that an append restarts the
// interval (the re-mount that replays the landed pulse also resets the clock,
// giving a fresh full slot to whatever is showing).
describe('NextMessageStrip rotation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function renderQueued(entries: string[]) {
    return render(
      createElement(Harness, {
        pendingMessage: entries.join('\n'),
        pendingEntries: entries,
      }),
    )
  }

  it('starts on the first message and advances every NEXT_MESSAGE_ROTATE_MS', () => {
    renderQueued(['first one', 'second one', 'third one'])
    expect(screen.getByTestId('next-message-text').textContent).toBe('first one')
    expect(screen.getByTestId('next-message-count').textContent).toBe('1/3')

    // Not yet — the first slot gets its full interval.
    act(() => { vi.advanceTimersByTime(NEXT_MESSAGE_ROTATE_MS - 1) })
    expect(screen.getByTestId('next-message-text').textContent).toBe('first one')

    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByTestId('next-message-text').textContent).toBe('second one')
    expect(screen.getByTestId('next-message-count').textContent).toBe('2/3')

    act(() => { vi.advanceTimersByTime(NEXT_MESSAGE_ROTATE_MS) })
    expect(screen.getByTestId('next-message-text').textContent).toBe('third one')
    expect(screen.getByTestId('next-message-count').textContent).toBe('3/3')
  })

  it('wraps from the last message back to the first', () => {
    renderQueued(['a', 'b'])
    act(() => { vi.advanceTimersByTime(NEXT_MESSAGE_ROTATE_MS) })
    expect(screen.getByTestId('next-message-text').textContent).toBe('b')
    expect(screen.getByTestId('next-message-count').textContent).toBe('2/2')

    act(() => { vi.advanceTimersByTime(NEXT_MESSAGE_ROTATE_MS) })
    expect(screen.getByTestId('next-message-text').textContent).toBe('a')
    expect(screen.getByTestId('next-message-count').textContent).toBe('1/2')
  })

  it('never rotates a single queued message — there is nothing to cycle to', () => {
    render(createElement(Harness, { pendingMessage: 'only one' }))
    act(() => { vi.advanceTimersByTime(NEXT_MESSAGE_ROTATE_MS * 5) })
    expect(screen.getByTestId('next-message-text').textContent).toBe('only one')
    expect(screen.queryByTestId('next-message-count')).toBeNull()
  })

  it('restarts the interval on an append (the landed re-mount resets the clock)', () => {
    const { rerender } = render(
      createElement(Harness, {
        pendingMessage: 'first one',
        pendingEntries: ['first one'],
      }),
    )
    // Halfway through the first slot…
    act(() => { vi.advanceTimersByTime(NEXT_MESSAGE_ROTATE_MS / 2) })

    // …an append lands (and re-mounts the strip).
    rerender(
      createElement(Harness, {
        pendingMessage: 'first one\nsecond one',
        pendingEntries: ['first one', 'second one'],
      }),
    )
    // Half a slot later the ORIGINAL interval would have advanced; the
    // restarted one must not have.
    act(() => { vi.advanceTimersByTime(NEXT_MESSAGE_ROTATE_MS / 2) })
    expect(screen.getByTestId('next-message-text').textContent).toBe('first one')
    // A full fresh slot later it does.
    act(() => { vi.advanceTimersByTime(NEXT_MESSAGE_ROTATE_MS / 2) })
    expect(screen.getByTestId('next-message-text').textContent).toBe('second one')
  })

  it('clamps the index when the batch shrinks beneath the rotation', () => {
    // A cross-WebView clear-then-resubmit replaces the batch with a SHORTER
    // one while the timer is deep in the old queue. The worker consumes from
    // the front, so the index can only point past the end mid-rotation — it
    // must clamp to the first message, never render nothing.
    const { rerender } = render(
      createElement(Harness, {
        pendingMessage: 'one\ntwo\nthree',
        pendingEntries: ['one', 'two', 'three'],
      }),
    )
    act(() => { vi.advanceTimersByTime(NEXT_MESSAGE_ROTATE_MS * 2) })
    expect(screen.getByTestId('next-message-text').textContent).toBe('three')

    rerender(
      createElement(Harness, {
        pendingMessage: 'fresh',
        pendingEntries: ['fresh'],
      }),
    )
    expect(screen.getByTestId('next-message-text').textContent).toBe('fresh')
    expect(screen.queryByTestId('next-message-count')).toBeNull()
  })
})

describe('nextRotateIndex', () => {
  it('advances to the next slot and wraps at the end', () => {
    expect(nextRotateIndex(0, 3)).toBe(1)
    expect(nextRotateIndex(1, 3)).toBe(2)
    expect(nextRotateIndex(2, 3)).toBe(0)
  })

  it('is a no-op for a single (or empty) queue — rotation needs 2+', () => {
    expect(nextRotateIndex(0, 1)).toBe(0)
    expect(nextRotateIndex(0, 0)).toBe(0)
  })
})

/**
 * The restore itself, shared by the two places a next message stops being
 * pending: the strip's × and the composer's Stop button. Stop drops the saved
 * batch worker-side (`clearForInterrupt`), so without this the user's typed
 * text was destroyed with no way to get it back.
 */
describe('restoreNextMessageIntoComposer', () => {
  function fakeComposer(initialText = '') {
    let text = initialText
    return {
      getState: () => ({ text }),
      setText: (next: string) => {
        text = next
      },
      read: () => text,
    }
  }

  it('puts the pending text into an empty composer', () => {
    const composer = fakeComposer('')
    restoreNextMessageIntoComposer(composer, 'restore me')
    expect(composer.read()).toBe('restore me')
  })

  it('appends after an in-progress draft with a newline separator', () => {
    const composer = fakeComposer('first line')
    restoreNextMessageIntoComposer(composer, 'second line')
    expect(composer.read()).toBe('first line\nsecond line')
  })

  it.each([null, undefined, ''])(
    'leaves the draft alone when there is nothing pending (%s)',
    pending => {
      const composer = fakeComposer('my draft')
      restoreNextMessageIntoComposer(composer, pending)
      expect(composer.read()).toBe('my draft')
    },
  )
})

// The "landed" state is the only confirmation the user gets that a submit made
// while the agent was busy was accepted, so its trigger conditions are pinned
// here: it fires on APPEND and only on append, and it restarts (rather than
// stacks) when a second append lands inside the first one's tail.
describe('NextMessageStrip landed state', () => {
  it('does not animate on first appearance — that is a fade-in, not an append', () => {
    render(createElement(Harness, { pendingMessage: 'first one' }))
    expect(screen.getByTestId('next-message-strip').className).not.toContain(
      'nexus-pending-landed',
    )
  })

  it('animates when more text is appended to an already-visible strip', () => {
    const { rerender } = render(createElement(Harness, { pendingMessage: 'first one' }))
    rerender(createElement(Harness, { pendingMessage: 'first one\nsecond one' }))
    expect(screen.getByTestId('next-message-strip').className).toContain(
      'nexus-pending-landed',
    )
  })

  it('does not animate when the text is REPLACED rather than appended to', () => {
    const { rerender } = render(createElement(Harness, { pendingMessage: 'first one' }))
    // Not a prefix of the previous value ⇒ not an append (e.g. a cross-WebView
    // clear-then-resubmit), so the append confirmation must not fire.
    rerender(createElement(Harness, { pendingMessage: 'unrelated text' }))
    expect(screen.getByTestId('next-message-strip').className).not.toContain(
      'nexus-pending-landed',
    )
  })

  it('re-mounts the strip per append so the state restarts instead of stacking', () => {
    const { rerender } = render(createElement(Harness, { pendingMessage: 'a' }))
    rerender(createElement(Harness, { pendingMessage: 'a\nb' }))
    const afterFirstAppend = screen.getByTestId('next-message-strip')
    rerender(createElement(Harness, { pendingMessage: 'a\nb\nc' }))
    const afterSecondAppend = screen.getByTestId('next-message-strip')
    // A fresh DOM node ⇒ React tore the old one down, which is what makes the
    // CSS animations replay from 0% (re-applying the same class would not).
    expect(afterSecondAppend).not.toBe(afterFirstAppend)
    expect(afterSecondAppend.className).toContain('nexus-pending-landed')
  })

  it('marks the count badge so the bump layer can target it', () => {
    // The badge is what the append actually CHANGES, so it is what the motion
    // points at — the ring is the ambient "something landed" half.
    render(createElement(Harness, { pendingMessage: 'a\nb' }))
    expect(screen.getByTestId('next-message-count').className).toContain(
      'nexus-pending-count',
    )
  })

  it('keeps the strip clipped to its corners for the truncated text', () => {
    render(createElement(Harness, { pendingMessage: 'x' }))
    expect(screen.getByTestId('next-message-strip').className).toContain(
      'overflow-hidden',
    )
  })
})

describe('splitPendingMessages', () => {
  it('splits the worker’s newline-joined batch into one entry per submit', () => {
    expect(splitPendingMessages('one\ntwo\nthree')).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('counts a single message as one', () => {
    expect(splitPendingMessages('just one')).toEqual(['just one'])
  })

  it('drops blank lines so a stray trailing newline cannot inflate the count', () => {
    expect(splitPendingMessages('one\n')).toEqual(['one'])
    expect(splitPendingMessages('one\n\ntwo')).toEqual(['one', 'two'])
  })

  it('cannot recover a multi-line submit — which is why the worker sends a list', () => {
    // Pinning the limitation this function is only a fallback for: the join it
    // undoes is not injective.
    expect(splitPendingMessages('one line\nsame submit')).toEqual([
      'one line',
      'same submit',
    ])
  })
})

describe('resolveQueuedMessages', () => {
  it('prefers the worker’s entry list over splitting the joined text', () => {
    expect(
      resolveQueuedMessages('a\nb\nc', ['a\nb', 'c']),
    ).toEqual(['a\nb', 'c'])
  })

  it.each([null, undefined])(
    'falls back to splitting when there is no list (%s)',
    entries => {
      expect(resolveQueuedMessages('a\nb', entries)).toEqual(['a', 'b'])
    },
  )

  it('treats an empty list as absent — a visible strip always has a message', () => {
    expect(resolveQueuedMessages('a\nb', [])).toEqual(['a', 'b'])
  })
})

// happy-dom does not evaluate the stylesheet, so the keyframes are checked as
// source. This pins a real regression: the design tokens are `oklch()`, and an
// earlier flash asked for `hsl(var(--accent) / 0.65)` — an invalid colour that
// Chromium drops, which is why that flash was not merely brief but ABSENT.
describe('next-message landed keyframes', () => {
  const css = readFileSync(join(__dirname, '..', 'styles', 'globals.css'), 'utf8')

  it('never wraps an oklch design token in hsl()', () => {
    // Declarations only — the comment above the keyframes quotes the old broken
    // form on purpose, and that quote is the documentation of this very bug.
    expect(css).not.toMatch(/:\s*hsl\(\s*var\(--/)
  })

  it('is short and never loops', () => {
    // The predecessor held a tint for 5s, which left the strip visibly
    // repainted long after the event and drew the eye back to a row that was no
    // longer doing anything. Both layers are now sub-second.
    const ring = css.match(/\.nexus-pending-landed\s*\{[^}]*\}/)
    expect(ring).not.toBeNull()
    expect(ring![0]).toContain('nexus-pending-ring 520ms')
    expect(ring![0]).not.toContain('infinite')

    const bump = css.match(
      /\.nexus-pending-landed \.nexus-pending-count\s*\{[^}]*\}/,
    )
    expect(bump).not.toBeNull()
    expect(bump![0]).toContain('nexus-pending-count-bump 420ms')
    expect(bump![0]).not.toContain('infinite')
  })

  it('settles back to the strip’s resting border so there is no snap at the end', () => {
    const frames = css.match(/@keyframes nexus-pending-ring\s*\{[\s\S]*?\n\}/)
    expect(frames).not.toBeNull()
    // No animation-fill-mode is set, so the 100% frame has to reproduce the
    // resting Tailwind border (`border-border`) exactly, and the ring has to
    // end fully transparent rather than leaving a halo behind.
    expect(frames![0]).toContain('border-color: var(--border)')
    expect(frames![0]).toContain('var(--primary) 0%')
  })

  it('does not tint the strip’s fill — the ring is a box-shadow, not a background', () => {
    // A filled tint over `bg-muted/40` read as a warning state rather than an
    // acknowledgement, and it is the reason the old flash felt wrong.
    const frames = css.match(/@keyframes nexus-pending-ring\s*\{[\s\S]*?\n\}/)
    expect(frames![0]).toContain('box-shadow')
    expect(frames![0]).not.toContain('background-color')
  })

  it('makes the count badge transformable', () => {
    // A bare inline <span> ignores `transform`, so the bump would silently do
    // nothing.
    const rule = css.match(/\.nexus-pending-count\s*\{[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toContain('display: inline-block')
  })

  it('keeps both layers alive under the release WebUI’s spurious reduce', () => {
    // In release `reduce` is reported for every user, so anything gated on it
    // is seen by nobody — this block is the path that actually runs.
    const reduce = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduce).toContain('nexus-pending-ring')
    expect(reduce).toContain('nexus-pending-count-bump')
  })
})
