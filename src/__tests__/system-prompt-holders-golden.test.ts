// Golden byte check: the `loadSystemPromptHolders` sections, joined the way
// the host joins them (each non-empty section, blank line between), must
// reproduce the system prompt byte-for-byte. The golden snapshots were frozen
// from the original literal assembly, then held through the symbolic `{ h }`
// holder era (host-resolved) and its removal — the snapshots are
// unchanged across both, which is the proof the removal is wire-neutral.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetProductNameForTest } from '../branding/productName'
import { __resetPromptCacheForTest } from '../prompting/systemPromptFetcher'
import { loadSystemPromptHolders } from '../prompting/systemPromptLoader'
import { renderPromptSection } from '../prompting/sections/promptSectionRenderer'
import type { ToolContractList } from '../toolkit/toolContract'

function tool(name: string): ToolContractList[number] {
  return { name } as unknown as ToolContractList[number]
}
const BROWSER_TOOLS = [tool('BrowserNavigate'), tool('BrowserClick')] as ToolContractList
const BROWSER_PLUS_AGENT = [tool('BrowserNavigate'), tool('BrowserClick'), tool('Agent')] as ToolContractList
const NO_TOOLS = [] as ToolContractList

type RenderCall = { name: string; enabledToolNames: string[] }

// Mirrors the C++ RenderPromptSection output shape closely enough to
// exercise gating. `calls` records every render the loader asked for.
function fakeCatalogRenderer(calls: RenderCall[] = []): (params: {
  name: 'using-your-tools' | 'system-prompt-tools'
  enabledToolNames: string[]
}) => { text: string } {
  return ({ name, enabledToolNames }) => {
    calls.push({ name, enabledToolNames: [...enabledToolNames] })
    if (name === 'system-prompt-tools') {
      return { text: '- cross-cutting native-tool prose' }
    }
    const hasBrowser = enabledToolNames.some(n => n.startsWith('Browser'))
    const sections: string[] = []
    if (hasBrowser) sections.push('## Browser tools\n\nOne call per turn.\n- click { index }')
    sections.push('## Parallelism\n\nCall multiple tools at once.')
    return { text: ['# Using your tools', '', ...sections].join('\n') }
  }
}

const FAKE_TEMPLATE = [
  'You are {{AGENT_NAME}} — an agent.',
  '',
  '# Doing tasks',
  '- act',
  '{{system-prompt-tools}}',
  '- report',
  '',
  '{{TOOL_CATALOG}}',
  '',
  '# Tone and style',
  '- be concise',
].join('\n')

function withFetchMock(template: string = FAKE_TEMPLATE): void {
  const mock = vi.fn(async () =>
    new Response(template, {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    }) as unknown as Response,
  )
  vi.stubGlobal('fetch', mock as unknown as typeof fetch)
}

beforeEach(() => {
  __resetPromptCacheForTest()
  __resetProductNameForTest()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// The host's join (C++ BuildSystemInstruction): each element verbatim, empty
// ones dropped, a blank line between.
function hostJoin(elements: readonly string[]): string {
  return elements.filter(e => e.length > 0).join('\n\n')
}

async function resolvedHoldersText(tools: ToolContractList): Promise<string> {
  const elements = await loadSystemPromptHolders({
    tools,
    promptSectionRenderer: fakeCatalogRenderer(),
  })
  return hostJoin(elements)
}

describe('system-prompt holders golden', () => {
  for (const [label, tools] of [
    ['browser tools (catalog non-empty)', BROWSER_TOOLS],
    ['no tools (catalog empty)', NO_TOOLS],
    ['browser + Agent (session guidance folded)', BROWSER_PLUS_AGENT],
  ] as const) {
    it(`resolves to the golden system prompt — ${label}`, async () => {
      __resetPromptCacheForTest()
      withFetchMock()
      const viaHolders = await resolvedHoldersText(tools)
      // Frozen golden == the retired `loadSystemPrompt` bytes (see header).
      expect(viaHolders).toMatchSnapshot()
    })
  }

  it('emits only finished text: pre, rendered catalog, post', async () => {
    withFetchMock()
    const elements = await loadSystemPromptHolders({
      tools: BROWSER_TOOLS,
      promptSectionRenderer: fakeCatalogRenderer(),
    })
    expect(elements.every(e => typeof e === 'string')).toBe(true)
    expect(elements).toHaveLength(3)
    expect(elements[0]).toContain('# Doing tasks')
    expect(elements[1]).toContain('# Using your tools')
    expect(elements[1]).toContain('## Browser tools')
    expect(elements[2]).toContain('# Tone and style')
  })

  it('renders the catalog for the VISIBLE tool set (deferral-aware)', async () => {
    withFetchMock()
    const calls: RenderCall[] = []
    // Browser tools are configured but NOT visible (deferred-inactive).
    const elements = await loadSystemPromptHolders({
      tools: BROWSER_TOOLS,
      visibleToolNames: [],
      promptSectionRenderer: fakeCatalogRenderer(calls),
    })
    const catalogCall = calls.find(c => c.name === 'using-your-tools')!
    expect(catalogCall.enabledToolNames).toEqual([])
    expect(elements.join('\n')).not.toContain('## Browser tools')
  })

  it('renders the catalog for all tools when visibleToolNames is absent', async () => {
    withFetchMock()
    const calls: RenderCall[] = []
    await loadSystemPromptHolders({
      tools: BROWSER_TOOLS,
      promptSectionRenderer: fakeCatalogRenderer(calls),
    })
    const catalogCall = calls.find(c => c.name === 'using-your-tools')!
    expect(catalogCall.enabledToolNames).toContain('BrowserNavigate')
  })

  it('renders the runtime\'s own sections when no renderer is injected', async () => {
    // The runtime renders both sections itself — there is no
    // host round-trip whose absence could drop them.
    withFetchMock()
    const elements = await loadSystemPromptHolders({ tools: BROWSER_TOOLS })
    const enabledToolNames = ['BrowserNavigate', 'BrowserClick']
    expect(elements).toContain(
      renderPromptSection({ name: 'using-your-tools', enabledToolNames }).text,
    )
    expect(elements[0]).toContain(
      renderPromptSection({ name: 'system-prompt-tools', enabledToolNames }).text,
    )
    expect(elements.every(e => e.length > 0)).toBe(true)
  })
})
