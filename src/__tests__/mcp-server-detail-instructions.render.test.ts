// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { McpServerDetailDialog, type McpServerDetail } from '../components/assistant-ui/mcp-server-detail-dialog'
import { en } from '../browser/webview/i18n/messages/en'

/**
 * The MCP server detail's Instructions section (F-10): shown for a connected
 * server that sent instructions, as plain text; a long text starts clamped
 * and Show more / Show less expands and collapses it; a short one has no
 * toggle; none, or a failed server, shows no section.
 */

function renderDetail(server: McpServerDetail) {
  return render(createElement(McpServerDetailDialog, { open: true, onOpenChange: () => {}, server }))
}

const exists = (testId: string) => screen.queryByTestId(testId) !== null

const LONG = Array.from({ length: 12 }, (_, i) => `Rule ${i + 1}: one mutating step per run.`).join('\n')

afterEach(() => {
  cleanup()
})

describe('McpServerDetailDialog instructions', () => {
  it('shows short instructions in full with no toggle', () => {
    renderDetail({ name: 'contree', status: 'connected', tools: [], instructions: 'Search before you build.' })
    const section = screen.getByTestId('mcp-server-detail-instructions')
    expect(section.textContent).toContain(en['mcpServers.instructionsHeading'])
    const text = screen.getByTestId('mcp-server-detail-instructions-text')
    expect(text.textContent).toBe('Search before you build.')
    expect(text.className).not.toContain('line-clamp-6')
    expect(exists('mcp-server-detail-instructions-toggle')).toBe(false)
  })

  it('clamps long instructions, and Show more / Show less expands and collapses them', () => {
    renderDetail({ name: 'contree', status: 'connected', tools: [], instructions: LONG })
    const text = screen.getByTestId('mcp-server-detail-instructions-text')
    const toggle = screen.getByTestId('mcp-server-detail-instructions-toggle')
    expect(text.textContent).toBe(LONG)
    expect(text.className).toContain('line-clamp-6')
    expect(toggle.textContent).toBe(en['mcpServers.showMore'])
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe(text.id)

    fireEvent.click(toggle)
    expect(text.className).not.toContain('line-clamp-6')
    expect(toggle.textContent).toBe(en['mcpServers.showLess'])
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(text.className).toContain('line-clamp-6')
    expect(toggle.textContent).toBe(en['mcpServers.showMore'])
  })

  it('clamps a single line past the character threshold', () => {
    renderDetail({ name: 'contree', status: 'connected', tools: [], instructions: 'x'.repeat(481) })
    expect(exists('mcp-server-detail-instructions-toggle')).toBe(true)
  })

  it('renders markup in the instructions as text', () => {
    renderDetail({ name: 'contree', status: 'connected', tools: [], instructions: '<b>bold</b> **star**' })
    const text = screen.getByTestId('mcp-server-detail-instructions-text')
    expect(text.textContent).toBe('<b>bold</b> **star**')
    expect(text.querySelector('b')).toBeNull()
  })

  it('shows no section without instructions, or for a failed server', () => {
    renderDetail({ name: 'plain', status: 'connected', tools: [] })
    expect(exists('mcp-server-detail-instructions')).toBe(false)
    cleanup()
    renderDetail({ name: 'down', status: 'failed', error: 'refused', instructions: 'stale' })
    expect(exists('mcp-server-detail-instructions')).toBe(false)
  })
})
