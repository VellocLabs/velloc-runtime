// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ArchivedSessionNotice } from '../components/assistant-ui/archived-session-notice'
import { ArchivedSessionProvider } from '../components/assistant-ui/thread-contexts'

// The line above an archived session's composer: it says the session is
// archived and offers Unarchive; any other session shows nothing. (F-36)

afterEach(() => cleanup())

describe('archived session notice', () => {
  it('shows for an archived session and unarchives it', () => {
    const onUnarchive = vi.fn()
    render(createElement(ArchivedSessionProvider, { value: { onUnarchive } }, createElement(ArchivedSessionNotice)))
    const notice = screen.getByTestId('archived-session-notice')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('This session is archived.')
    fireEvent.click(screen.getByTestId('archived-session-unarchive'))
    expect(onUnarchive).toHaveBeenCalledTimes(1)
  })

  it('shows nothing for a session that is not archived', () => {
    render(createElement(ArchivedSessionProvider, { value: null }, createElement(ArchivedSessionNotice)))
    expect(screen.queryByTestId('archived-session-notice')).toBeNull()
  })
})
