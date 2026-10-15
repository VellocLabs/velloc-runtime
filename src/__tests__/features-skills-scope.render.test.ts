// @vitest-environment happy-dom
/**
 * Settings · Features: skill install/uninstall (`skills.install` / `uninstall`) need `full`. A scoped connection
 * gets a read-only Installed list and no "Install skills" section; desktop (`full`, or no provider) renders both.
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'

import type { CapabilityAdvert } from '../browser/runtimeProtocol'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import { FeaturesSection } from '../browser/webview/settings/sections/FeaturesSection'
import type { CatalogSkill } from '../browser/webview/settings/sections/SkillsMarketplace'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { queryFor } from './_helpers/capabilityQuery'
import { makeMockSettingsBridge } from './_helpers/mockSettingsBridge'

function catalogSkill(name: string): CatalogSkill {
  return {
    id: `anthropic/${name}`,
    name,
    description: `Work with ${name} files.`,
    publisher: 'anthropic',
    publisherLabel: 'Anthropic',
    repo: 'anthropics/skills',
    branch: 'main',
    path: `skills/${name}`,
    files: ['SKILL.md'],
  }
}

/** `pdf` is installed; `docx` is only in the catalog. */
const CATALOG = [catalogSkill('pdf'), catalogSkill('docx')]

let restoreFetch = () => {}
beforeEach(() => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).endsWith('skills-catalog.json')
      ? new Response(JSON.stringify({ skills: CATALOG }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('', { status: 404 })) as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }
})

afterEach(() => {
  cleanup()
  restoreFetch()
})

const FEATURES: CapabilityAdvert = {
  cap: 'features',
  acts: ['catalog', 'snapshot', 'setEnabled'],
}

let rescans = 0
beforeEach(() => {
  rescans = 0
})

function renderFeatures(capabilities?: CapabilityQuery) {
  const bridge = makeMockSettingsBridge({
    'features.catalog': async () => ({ features: [] }),
    'features.snapshot': async () => ({ enabled: {}, source: 'default' }),
    'skills.listInstalled': async () => ({
      skills: [{ id: 'anthropic/pdf', name: 'pdf', dir: 'anthropic-pdf' }],
    }),
    'skills.rescan': async () => {
      rescans += 1
      return { reloaded: false }
    },
  })
  const section = createElement(
    SettingsBridgeContext.Provider,
    { value: bridge },
    createElement(FeaturesSection),
  )
  return render(
    capabilities
      ? createElement(RuntimeCapabilitiesContext.Provider, { value: capabilities }, section)
      : section,
  )
}

describe('FeaturesSection skills — desktop renders install and uninstall', () => {
  it.each([
    ['with no capability provider (the desktop tree)', undefined],
    [
      'for a full grant',
      queryFor([
        FEATURES,
        { cap: 'skills', acts: ['listInstalled', 'rescan', 'install', 'uninstall', 'listImportable', 'importLocal'] },
      ]),
    ],
  ])('%s', async (_label, capabilities) => {
    renderFeatures(capabilities)

    const installed = await screen.findByTestId('skill-card-anthropic/pdf')
    expect(within(installed).getByRole('button', { name: 'Uninstall' })).toBeTruthy()
    expect(screen.getByTestId('skills-marketplace')).toBeTruthy()
    expect(await screen.findByTestId('skill-install-anthropic/docx')).toBeTruthy()
    // Listing is followed by the rescan that loads a hand-dropped folder.
    await waitFor(() => expect(rescans).toBeGreaterThan(0))
  })
})

describe('FeaturesSection skills — a scoped grant sees no disk-writing control', () => {
  it('lists installed skills without Uninstall and drops the Install section', async () => {
    renderFeatures(queryFor([FEATURES, { cap: 'skills', acts: ['listInstalled'] }]))

    const installed = await screen.findByTestId('skill-card-anthropic/pdf')
    expect(within(installed).queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('skills-marketplace')).toBeNull()
    expect(screen.queryByTestId('skill-install-anthropic/docx')).toBeNull()
    expect(screen.queryByText('Install skills')).toBeNull()
  })

  it('lists without the rescan: reloading every open session needs control', async () => {
    renderFeatures(queryFor([FEATURES, { cap: 'skills', acts: ['listInstalled'] }]))

    await screen.findByTestId('skill-card-anthropic/pdf')
    expect(rescans).toBe(0)
  })
})
