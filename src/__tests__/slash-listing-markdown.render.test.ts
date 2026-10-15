// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { StaticMarkdown } from '../components/assistant-ui/static-markdown'
import { renderPartsEnglish } from '../input/systemMessageParts'
import {
  buildAgentsListing,
  buildPermissionsListing,
  buildSkillsListing,
} from '../input/introspectionCommands'
import { buildPluginsListing } from '../input/pluginInstallCommands'
import { formatCostReport, type ModelTokenUsage } from '../engine/usageCost'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import type { ActivePlugin, PluginScan } from '../pluginHost/pluginModel'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import { processUserInput } from '../input/submitUserInput'
import type { NoticeRow } from '../runtime/RuntimeTypes'

/**
 * The listings render as structure, not one paragraph: asserted on the DOM through `StaticMarkdown`, which shares
 * the message renderer's components and remark plugins (a single newline is a soft break).
 */

afterEach(() => cleanup())

function renderMarkdown(markdown: string): HTMLElement {
  const { container } = render(
    createElement(StaticMarkdown, { content: markdown }),
  )
  return container
}

function skill(
  overrides: Partial<ChromiumPromptCommand> = {},
): ChromiumPromptCommand {
  return {
    type: 'prompt',
    name: 'echo',
    description: 'Echo something back',
    source: 'project',
    loadedFrom: 'project',
    getPromptForCommand: async () => [],
    ...overrides,
  } as ChromiumPromptCommand
}

function usage(overrides: Partial<ModelTokenUsage> = {}): ModelTokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, ...overrides }
}

function plugin(overrides: Partial<ActivePlugin> = {}): ActivePlugin {
  return {
    name: 'linter',
    source: 'user:/home/plugins',
    manifest: { name: 'linter', version: '1.2.0' },
    commandFolder: 'commands',
    ...overrides,
  } as ActivePlugin
}

/** Dispatch a slash command and hand back the English text it composed. */
async function dispatch(input: string, commands: string[]): Promise<string> {
  const out = await processUserInput(
    {
      input,
      context: createNoopToolUseContext({
        tools: [],
        platformCapabilities: new NoopPlatformCapabilities(),
        appState: createEmptyAppState(),
        setAppState: () => {},
        sessionId: 'sess',
        cwd: '/w',
        commands: [],
      }),
    },
    {
      hostBridge: {} as unknown as BrowserHostBridge,
      runtimeConfig: new BrowserRuntimeConfig(),
      supportedSlashCommands: commands,
    },
  )
  const system = out.messages.find(m => m.type === 'system') as NoticeRow
  return system.message as string
}

describe('slash listings render as markdown structure', () => {
  it('/help renders one subheading per command with its hint below', async () => {
    const container = renderMarkdown(
      await dispatch('/help', ['help', 'clear', 'status']),
    )

    // One `<h4>` per command — the "subtitle" — each followed by its own
    // paragraph of hint text. Before this, the whole listing was a single
    // paragraph of bare names with no descriptions at all.
    const headings = [...container.querySelectorAll('h4')].map(h => h.textContent)
    expect(headings).toContain('/help')
    expect(headings).toContain('/clear')
    expect(headings).toContain('/status')
    // The hidden `/debug` gets a heading too, under its own section.
    expect(headings).toContain('/debug')
    expect(
      [...container.querySelectorAll('h3')].map(h => h.textContent).join(' '),
    ).toContain('Hidden commands')

    for (const heading of container.querySelectorAll('h4')) {
      const hint = heading.nextElementSibling
      expect(hint?.tagName.toLowerCase()).toBe('p')
      expect(hint?.textContent?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('/skills renders a heading, a lead-in and one list item per skill', () => {
    const markdown = renderPartsEnglish(
      buildSkillsListing([
        skill({ name: 'alpha' }),
        skill({ name: 'beta' }),
        skill({ name: 'gamma', source: 'bundled', loadedFrom: 'bundled' }),
      ]),
    )
    const container = renderMarkdown(markdown)

    // The title is a real heading, not the first words of a paragraph.
    expect(container.querySelector('h3')?.textContent).toContain('Skills: 3 loaded')
    // Two source buckets, each its own bold lead-in and its own list.
    expect(container.querySelectorAll('ul')).toHaveLength(2)
    // Every skill is its own row. This is the assertion that fails when the
    // layout collapses: they all end up inside one <p>.
    const items = [...container.querySelectorAll('li')].map(li => li.textContent)
    expect(items).toHaveLength(3)
    expect(items.some(t => t?.includes('/alpha'))).toBe(true)
    expect(items.some(t => t?.includes('/beta'))).toBe(true)
    expect(items.some(t => t?.includes('/gamma'))).toBe(true)
    // …and none of them are glued to a neighbour.
    for (const item of items) {
      expect(item).not.toContain('/beta /gamma')
    }
  })

  it('/agents renders one list item per agent, plus the reserved route', () => {
    const container = renderMarkdown(
      renderPartsEnglish(
        buildAgentsListing({
          enabledAgents: [
            { name: 'explorer', description: 'Search', source: 'built-in' },
            { name: 'reviewer', description: 'Review', source: 'project' },
          ],
          allAgents: [],
        }),
      ),
    )

    expect(container.querySelector('h3')?.textContent).toContain('Agents: 2')
    const items = [...container.querySelectorAll('li')].map(li => li.textContent)
    // two agents + the reserved `fork` route
    expect(items).toHaveLength(3)
    expect(items.some(t => t?.includes('fork'))).toBe(true)
  })

  it('/permissions renders every rule as its own row', () => {
    const state = createEmptyAppState()
    state.permissionRules.ruleLists = {
      allow: ['Read', 'Grep', 'Glob'],
      ask: [],
      deny: ['Bash(rm:*)'],
    }
    const container = renderMarkdown(
      renderPartsEnglish(buildPermissionsListing(state)),
    )

    expect(container.querySelector('h3')?.textContent).toContain('Permission mode')
    // The posture bullet comes first: with no kill switch, bypass is available.
    expect([...container.querySelectorAll('li')].map(li => li.textContent)).toEqual([
      'Bypass mode: available',
      'Read',
      'Grep',
      'Glob',
      'Bash(rm:*)',
    ])
  })

  it('/cost separates the session totals from the per-model list', () => {
    // A blank line between bullets does NOT start a second list — it makes the
    // same list loose. Pushing the totals as `\n\n- ` therefore left "Total:"
    // and the pricing caveat sitting in the per-model <ul>, reading as two
    // more models, and loosened every row into its own <p>. The totals are a
    // bold lead-in now, which genuinely ends the list.
    const container = renderMarkdown(
      renderPartsEnglish(
        formatCostReport(
          new Map([
            ['model-a', usage({ input: 1000, output: 200 })],
            ['model-b', usage({ input: 30, output: 5 })],
          ]),
        ),
      ),
    )

    const lists = container.querySelectorAll('ul')
    const modelItems = [...lists[0]!.querySelectorAll('li')].map(li => li.textContent)
    expect(modelItems).toHaveLength(2)
    expect(modelItems.join(' ')).not.toContain('Total')
    // A tight list: the rows are bare text, not each wrapped in its own <p>.
    expect(lists[0]!.querySelectorAll('p')).toHaveLength(0)
    // The total is its own block, outside every list.
    const strong = [...container.querySelectorAll('strong')].map(s => s.textContent)
    expect(strong.some(t => t?.includes('Total'))).toBe(true)
    expect(
      [...container.querySelectorAll('li')].some(li =>
        li.textContent?.includes('Total'),
      ),
    ).toBe(false)
  })

  it('/plugins keeps the capability list as text, not a link', () => {
    // `[commands, hooks] (user)` is markdown LINK syntax — the facets used to
    // render as an <a href="user">. The scope now trails the name instead.
    const result: PluginScan = {
      enabled: [plugin({ hooksConfig: { PreToolUse: [] } })],
      disabled: [],
      errors: [],
    }
    const container = renderMarkdown(
      renderPartsEnglish(buildPluginsListing(result)),
    )

    expect(container.querySelectorAll('a')).toHaveLength(0)
    const item = container.querySelector('li')?.textContent
    expect(item).toContain('linter')
    expect(item).toContain('commands, hooks')
  })
})
