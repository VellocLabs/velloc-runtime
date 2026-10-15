// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import {
  SettingsGroupLabel,
  SettingsNotice,
  SettingsSection,
  SettingsSubpageLayout,
  settingsText,
} from '../browser/webview/settings/SettingsSubpageLayout'

/**
 * One type scale for every settings page: pins the components in `SettingsSubpageLayout.tsx` (`settingsText`) and
 * keeps the sections from drifting off them.
 */

const SECTIONS_DIR = join(__dirname, '../browser/webview/settings/sections')

function sectionSources(): Array<[string, string]> {
  return readdirSync(SECTIONS_DIR)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => [f, readFileSync(join(SECTIONS_DIR, f), 'utf8')])
}

afterEach(cleanup)

describe('settings layout primitives', () => {
  it('renders the page title as the one <h1>, with adornment, actions and description', () => {
    render(
      createElement(SettingsSubpageLayout, {
        title: 'Page',
        description: 'About this page',
        adornment: createElement('span', { 'data-testid': 'badge' }, 'on'),
        actions: createElement('button', { 'data-testid': 'act' }, 'Add'),
        children: createElement(SettingsSection, { title: 'Group' }, 'body'),
      }),
    )
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.textContent).toBe('Page')
    expect(h1.className).toBe(settingsText.pageTitle)
    const header = h1.closest('[data-settings-page-header]')!
    expect(header.contains(screen.getByTestId('badge'))).toBe(true)
    expect(header.contains(screen.getByTestId('act'))).toBe(true)
    expect(header.textContent).toContain('About this page')

    const h2 = screen.getByRole('heading', { level: 2 })
    expect(h2.textContent).toBe('Group')
    expect(h2.className).toBe(settingsText.sectionTitle)
  })

  it('draws no page header when the page has no title', () => {
    const { container } = render(
      createElement(SettingsSubpageLayout, null, 'body'),
    )
    expect(container.querySelector('[data-settings-page-header]')).toBeNull()
    expect(container.querySelector('h1')).toBeNull()
  })

  it('renders group labels and notices in the shared style', () => {
    render(
      createElement('div', null,
        createElement(SettingsGroupLabel, null, 'Tier'),
        createElement(SettingsNotice, { testId: 'n', tone: 'warning', children: 'Careful' }),
      ),
    )
    const label = screen.getByRole('heading', { level: 3 })
    for (const cls of settingsText.groupLabel.split(' ')) {
      expect(label.className).toContain(cls)
    }
    expect(screen.getByTestId('n').className).toContain('bg-warning/10')
  })
})

describe('settings pages use the shared scale', () => {
  it('has no hand-rolled heading element in a settings section', () => {
    const offenders: string[] = []
    for (const [file, src] of sectionSources()) {
      // Every <h1>–<h4> opening tag, attributes included (they may span lines).
      for (const m of src.matchAll(/<h[1-4]\b[^>]*>/g)) {
        if (!m[0].includes('settingsText.')) offenders.push(`${file}: ${m[0].replace(/\s+/g, ' ')}`)
      }
    }
    expect(
      offenders,
      'use SettingsSubpageLayout title / SettingsSection / SettingsGroupLabel (or settingsText.*) instead',
    ).toEqual([])
  })

  it('has no page-local banner or small-caps heading style', () => {
    const offenders: string[] = []
    for (const [file, src] of sectionSources()) {
      if (src.includes('border-l-4')) offenders.push(`${file}: border-l-4 banner — use SettingsNotice`)
      if (/font-(?:medium|semibold) text-muted-foreground text-xs uppercase tracking-wide/.test(src)) {
        offenders.push(`${file}: hand-rolled small-caps label — use SettingsGroupLabel`)
      }
    }
    expect(offenders).toEqual([])
  })
})
