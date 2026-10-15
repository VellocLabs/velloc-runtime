// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { en } from '../browser/webview/i18n/messages/en'
import {
  RemoteConnectScreen,
  type RemoteConnectState,
} from '../browser/webview/remote/RemoteConnectScreen'

/**
 * The remote connect / error screen (F-24): every state renders a catalog title + body; retry only on retryable
 * states; the build-mismatch jump only on `build_mismatch`; reconnect only on `listener_disabled`; auto-retry drives
 * `onRetry` for the self-reconnecting states.
 */

const ALL_STATES: RemoteConnectState[] = [
  'connecting',
  'failed',
  'unauthorized',
  'expired',
  'invalid',
  'runtime_offline',
  'listener_disabled',
  'too_many_clients',
  'protocol_too_old',
  'protocol_too_new',
  'build_mismatch',
  'replaced',
]

/** The states that render `DesktopUnreachableCard` instead of title + body
 *  copy — pinned on their own below. */
const UNREACHABLE = new Set<RemoteConnectState>(['failed', 'runtime_offline'])
const COPY_STATES = ALL_STATES.filter(state => !UNREACHABLE.has(state))

const RETRYABLE = new Set<RemoteConnectState>([
  'too_many_clients',
  // The one state whose retry is ONLY manual: the screen offers the button so
  // the user can move the connection back here, and no timer ever presses it.
  'replaced',
])

afterEach(() => {
  cleanup()
})

describe('RemoteConnectScreen', () => {
  it.each(COPY_STATES)('renders catalog text (not raw keys) for %s', state => {
    render(createElement(RemoteConnectScreen, { state }))
    const main = screen.getByTestId('remote-connect-screen')
    expect(main.dataset.state).toBe(state)
    const heading = main.querySelector('h1')
    expect(heading).not.toBeNull()
    // A raw key still reads as dotted text; a catalog value never does.
    expect(heading!.textContent).not.toMatch(/^remote\./)
    expect(heading!.textContent!.length).toBeGreaterThan(0)
    const body = heading!.nextElementSibling
    expect(body?.textContent).not.toMatch(/^remote\./)
    expect(body?.textContent?.length ?? 0).toBeGreaterThan(0)
  })

  it.each(COPY_STATES)(
    'shows the retry button exactly on the retryable states (%s)',
    state => {
      const onRetry = vi.fn()
      render(createElement(RemoteConnectScreen, { state, onRetry }))
      const buttons = screen
        .queryAllByRole('button')
        .filter(button => button.textContent === en['remote.retry'])
      if (RETRYABLE.has(state)) {
        expect(buttons).toHaveLength(1)
        buttons[0]!.click()
        expect(onRetry).toHaveBeenCalledTimes(1)
      } else {
        expect(buttons).toHaveLength(0)
      }
    },
  )

  it('shows the jump button only for build_mismatch', () => {
    const onOpenMatchingBuild = vi.fn()
    render(
      createElement(RemoteConnectScreen, {
        state: 'build_mismatch',
        onOpenMatchingBuild,
      }),
    )
    const button = screen.getByRole('button')
    button.click()
    expect(onOpenMatchingBuild).toHaveBeenCalledTimes(1)
  })

  it.each(ALL_STATES)(
    'shows the reconnect (reload) button only on listener_disabled (%s)',
    state => {
      const onReload = vi.fn()
      render(createElement(RemoteConnectScreen, { state, onReload }))
      const buttons = screen.queryAllByRole('button', {
        name: en['remote.reconnect'],
      })
      if (state === 'listener_disabled') {
        expect(buttons).toHaveLength(1)
        buttons[0]!.click()
        expect(onReload).toHaveBeenCalledTimes(1)
      } else {
        expect(buttons).toHaveLength(0)
      }
    },
  )

  it('listener_disabled reconnects by reloading the page, and never on a timer', async () => {
    // The screen a remote user lands on after the desktop turned remote access
    // off. The listener is off until the user turns it back on, so no timer
    // may press anything — but once they have, reloading is the whole fix,
    // and the screen offers it instead of leaving them to know about F5.
    // Without the fix the screen has no button at all.
    vi.useFakeTimers()
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    })
    try {
      const onRetry = vi.fn()
      render(
        createElement(RemoteConnectScreen, { state: 'listener_disabled', onRetry }),
      )
      // Not the generic retry: the listener being off is not transient.
      expect(screen.queryByRole('button', { name: en['remote.retry'] })).toBeNull()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onRetry).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
      // Default action with no onReload injected: a real page reload.
      screen.getByRole('button', { name: en['remote.reconnect'] }).click()
      expect(reload).toHaveBeenCalledTimes(1)
      expect(onRetry).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
      vi.useRealTimers()
    }
  })

  it('auto-retries on the cadence when autoRetryMs is set', async () => {
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      render(
        createElement(RemoteConnectScreen, {
          state: 'runtime_offline',
          onRetry,
          autoRetryMs: 5_000,
        }),
      )
      expect(onRetry).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(onRetry).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('replaced says what happened, and never retries on a timer', async () => {
    // The state exists because the generic `failed` copy told a remote user
    // two untrue things — that the desktop did not answer, and that the page
    // keeps retrying. Pin the second one here (the first is the copy itself):
    // rendered with no autoRetryMs, the screen must stay put, with the manual
    // button still offered. Without the fix `replaced` has no title/body key
    // at all and this state does not exist.
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      render(createElement(RemoteConnectScreen, { state: 'replaced', onRetry }))
      const main = screen.getByTestId('remote-connect-screen')
      expect(main.dataset.state).toBe('replaced')
      const heading = main.querySelector('h1')!
      const body = heading.nextElementSibling
      // Its own copy — not the `failed` screen's, which is what it used to get.
      expect(heading.textContent).not.toBe(en['remote.unreachable.neverTitle'])
      expect(heading.textContent).toBe(en['remote.replacedTitle'])
      expect(body?.textContent).toBe(en['remote.replacedBody'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onRetry).not.toHaveBeenCalled()
      // …but the user can still take the connection back by hand.
      screen.getByRole('button').click()
      expect(onRetry).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('host_gone is the unified card saying the connection was LOST, retrying on its own', async () => {
    // A quit desktop used to land a live page on a copy screen
    // with a silent 5 s timer, while the overlay counted down — two UIs for
    // one event. Now it is the overlay's card, with its countdown and button.
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      render(
        createElement(RemoteConnectScreen, {
          state: 'host_gone',
          onRetry,
          autoRetryMs: 5_000,
        }),
      )
      const main = screen.getByTestId('remote-connect-screen')
      expect(main.dataset.state).toBe('host_gone')
      const card = screen.getByTestId('remote-offline-card')
      expect(card.dataset.phase).toBe('lost')
      expect(card.textContent).toContain(en['remote.unreachable.lostTitle'])
      expect(screen.getByTestId('remote-offline-countdown').textContent).toBe('Reconnecting in 5 s')
      screen.getByRole('button', { name: en['remote.unreachable.reconnectNow'] }).click()
      expect(onRetry).toHaveBeenLastCalledWith(true)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(onRetry).toHaveBeenCalledTimes(2)
      expect(onRetry).toHaveBeenLastCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['failed', 'runtime_offline'] as const)(
    'a page that never connected (%s) says the desktop is not detected — not that a connection broke',
    state => {
      render(
        createElement(RemoteConnectScreen, {
          state,
          onRetry: () => {},
          unreachable: { everConnected: false, attempt: 1, nextAttemptAt: Date.now() + 2_000 },
        }),
      )
      const card = screen.getByTestId('remote-offline-card')
      expect(card.dataset.phase).toBe('never')
      expect(card.textContent).toContain(en['remote.unreachable.neverTitle'])
      expect(card.textContent).not.toContain(en['remote.unreachable.lostTitle'])
      expect(screen.getByTestId('remote-offline-countdown').textContent).toBe(
        'Waiting for the desktop… retrying in 2 s',
      )
      expect(
        screen.getByRole('button', { name: en['remote.unreachable.retry'] }),
      ).toBeTruthy()
    },
  )

  it('retries at the ladder step the boot scheduled, and after several failures says it is stuck', async () => {
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      render(
        createElement(RemoteConnectScreen, {
          state: 'failed',
          onRetry,
          unreachable: { everConnected: false, attempt: 5, nextAttemptAt: Date.now() + 16_000 },
        }),
      )
      expect(screen.getByTestId('remote-offline-card').dataset.phase).toBe('stuck')
      expect(screen.getByRole('button', { name: en['remote.unreachable.tryAgain'] })).toBeTruthy()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(onRetry).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(onRetry).toHaveBeenCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a retry on the wire keeps the card, turned to connecting, with no timer of its own', async () => {
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      render(
        createElement(RemoteConnectScreen, {
          state: 'connecting',
          onRetry,
          unreachable: { everConnected: true, attempt: 2, nextAttemptAt: Date.now() + 4_000 },
        }),
      )
      expect(screen.getByTestId('remote-connect-screen').dataset.state).toBe('connecting')
      const card = screen.getByTestId('remote-offline-card')
      expect(card.dataset.phase).toBe('connecting')
      expect(card.textContent).toContain(en['remote.unreachable.connectingTitle'])
      // Never greyed out.
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onRetry).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not auto-retry without autoRetryMs', async () => {
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      render(
        createElement(RemoteConnectScreen, { state: 'failed', onRetry }),
      )
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onRetry).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
