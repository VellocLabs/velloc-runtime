// @vitest-environment happy-dom
/**
 * The phone shell's session menu and rename sheet (F-24): Copy branch name appears only when the
 * branch is known and says so when the copy fails; Archive and Rename call back; the rename sheet
 * saves the trimmed title or cancels.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../browser/webview/i18n'
import {
  MobileRenameSheet,
  MobileSessionMenu,
  type MobileMenuTarget,
  type MobileSessionMenuProps,
} from '../mobile/MobileSessionMenu'

afterEach(cleanup)

function renderMenu(target: MobileMenuTarget, overrides: Partial<MobileSessionMenuProps> = {}) {
  const props = {
    target,
    onClose: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    writeText: vi.fn(async () => true),
    ...overrides,
  }
  render(createElement(I18nProvider, { locale: 'en' as const }, createElement(MobileSessionMenu, props)))
  return props
}

describe('MobileSessionMenu', () => {
  it('has no Copy branch name when the branch is unknown', () => {
    renderMenu({ sessionId: 's1', title: 'Trip' })
    expect(screen.getByTestId('mobile-session-menu').textContent).toContain('Trip')
    expect(screen.queryByTestId('mobile-menu-copy-branch')).toBeNull()
    expect(screen.getByTestId('mobile-menu-rename')).toBeTruthy()
    expect(screen.getByTestId('mobile-menu-archive')).toBeTruthy()
  })

  it('copies the known branch and closes', async () => {
    const props = renderMenu({ sessionId: 's1', title: 'Trip', branch: 'feature/trip' })
    expect(screen.getByTestId('mobile-menu-copy-branch').textContent).toContain('feature/trip')
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-menu-copy-branch'))
    })
    expect(props.writeText).toHaveBeenCalledWith('feature/trip')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('stays open and says so when the copy fails', async () => {
    const props = renderMenu(
      { sessionId: 's1', title: 'Trip', branch: 'feature/trip' },
      { writeText: vi.fn(async () => false) },
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-menu-copy-branch'))
    })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('mobile-menu-copy-failed').textContent).toBe("Couldn't copy the branch name.")
  })

  it('archives and closes; Rename hands the target on', () => {
    const target = { sessionId: 's1', title: 'Trip' }
    const props = renderMenu(target)
    fireEvent.click(screen.getByTestId('mobile-menu-rename'))
    expect(props.onRename).toHaveBeenCalledWith(target)
    fireEvent.click(screen.getByTestId('mobile-menu-archive'))
    expect(props.onArchive).toHaveBeenCalledWith('s1')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('names an untitled session as a new one', () => {
    renderMenu({ sessionId: 's1', title: '   ' })
    expect(screen.getByRole('heading').textContent).toBe('New session')
  })
})

describe('MobileRenameSheet', () => {
  function renderRename() {
    const props = { target: { sessionId: 's1', title: 'Trip' }, onClose: vi.fn(), onSave: vi.fn() }
    render(createElement(I18nProvider, { locale: 'en' as const }, createElement(MobileRenameSheet, props)))
    return props
  }

  it('opens on the current title and saves the trimmed new one', () => {
    const props = renderRename()
    const input = screen.getByTestId('mobile-rename-input') as HTMLInputElement
    expect(input.value).toBe('Trip')
    fireEvent.change(input, { target: { value: '  Road trip  ' } })
    fireEvent.click(screen.getByTestId('mobile-rename-save'))
    expect(props.onSave).toHaveBeenCalledWith('s1', 'Road trip')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('cancels without saving', () => {
    const props = renderRename()
    fireEvent.change(screen.getByTestId('mobile-rename-input'), { target: { value: 'Other' } })
    fireEvent.click(screen.getByTestId('mobile-rename-cancel'))
    expect(props.onSave).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalled()
  })
})
