/**
 * `context.breakdown` of `$.session.usage({ breakdown })` (F-25): the rows, the reconciliation to
 * what the model was charged, the buffer and free space, the grid, and the live-window walk.
 */
import { describe, expect, it } from 'vitest'
import { breakdownWindow, tokensOfChars, type WindowBreakdownInput } from '../mods/windowBreakdown'
import { liveWindowRows, measureLiveRows } from '../engine/windowBreakdownInput'
import type { Message } from '../runtime/RuntimeTypes'

const base: WindowBreakdownInput = {
  model: 'model-a',
  window: 200_000,
  systemChars: 8_000,
  tools: [
    { name: 'Read', chars: 4_000 },
    { name: 'mcp__docs__search', chars: 2_000, server: 'docs' },
  ],
  memoryFiles: [{ path: '/work/AGENTS.md', type: 'Project', chars: 1_200 }],
  memorySectionChars: 400,
  skillListings: [{ text: '- review: Reviews a diff\n- deploy', names: ['review', 'deploy'] }],
  messageChars: 20_000,
  compaction: { enabled: true, threshold: 167_000 },
}

const rowsOf = (input: WindowBreakdownInput) => breakdownWindow(input).categories.map(row => [row.name, row.kind, row.tokens])

describe('the rows', () => {
  it('in order, each estimated at four characters a token, the buffer and free space last', () => {
    expect(rowsOf(base)).toEqual([
      ['System prompt', 'used', 2_000],
      ['System tools', 'used', 1_000],
      ['MCP tools', 'used', 500],
      ['Memory files', 'used', 400],
      ['Skills', 'used', tokensOfChars('- review: Reviews a diff\n- deploy'.length)],
      ['Messages', 'used', 5_000],
      ['Autocompact buffer', 'buffer', 33_000],
      ['Free space', 'free', 200_000 - 33_000 - 8_909],
    ])
    expect(breakdownWindow(base).totalTokens).toBe(8_909)
  })

  it('a row with nothing in it is left out; free space never is', () => {
    const empty = breakdownWindow({ ...base, systemChars: 0, tools: [], memoryFiles: [], memorySectionChars: 0, skillListings: [], messageChars: 0 })
    expect(empty.categories.map(row => row.name)).toEqual(['Autocompact buffer', 'Free space'])
    expect(empty.totalTokens).toBe(0)
  })

  it('with compaction off: no buffer, no threshold, the free space is the rest of the window', () => {
    const off = breakdownWindow({ ...base, compaction: { enabled: false, threshold: 167_000 } })
    expect(off.categories.some(row => row.kind === 'buffer')).toBe(false)
    expect(off.autoCompactThreshold).toBeUndefined()
    expect(off.isAutoCompactEnabled).toBe(false)
    expect(off.categories.at(-1)).toMatchObject({ name: 'Free space', tokens: 200_000 - 8_909 })
  })

  it('over the window: the total runs past it, the percentage past 100, the free space stays at 0', () => {
    const over = breakdownWindow({ ...base, messageChars: 1_000_000 })
    expect(over.percentage).toBeGreaterThan(100)
    expect(over.categories.at(-1)!.tokens).toBe(0)
  })
})

describe('reconciled to what the model was charged', () => {
  it('Messages is what the last response read and wrote, plus the rows after it, less the other rows', () => {
    const charged = breakdownWindow({
      ...base,
      charged: {
        counts: { input_tokens: 10_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1_000, output_tokens: 500 },
        tailChars: 400,
      },
    })
    expect(charged.totalTokens).toBe(31_600)
    expect(charged.categories.find(row => row.name === 'Messages')!.tokens).toBe(31_600 - 3_909)
    expect(charged.apiUsage).toEqual({ input_tokens: 10_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1_000, output_tokens: 500 })
  })

  it('never below 0 when the estimates of the other rows run past the charge', () => {
    const small = breakdownWindow({
      ...base,
      charged: { counts: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, tailChars: 0 },
    })
    expect(small.categories.find(row => row.name === 'Messages')).toBeUndefined()
  })

  it('before any response nothing is charged', () => {
    expect(breakdownWindow(base).apiUsage).toBeNull()
  })
})

describe('the details beside the rows', () => {
  it('memory files, MCP tools and the listed skills, each with its tokens', () => {
    const breakdown = breakdownWindow(base)
    expect(breakdown.memoryFiles).toEqual([{ path: '/work/AGENTS.md', type: 'Project', tokens: 300 }])
    expect(breakdown.mcpTools).toEqual([{ name: 'mcp__docs__search', serverName: 'docs', tokens: 500, isLoaded: true }])
    expect(breakdown.skills).toEqual({
      totalSkills: 2,
      includedSkills: 2,
      tokens: tokensOfChars('- review: Reviews a diff\n- deploy'.length),
      skillFrontmatter: [
        { name: 'review', source: 'listing', tokens: tokensOfChars('- review: Reviews a diff'.length) },
        { name: 'deploy', source: 'listing', tokens: tokensOfChars('- deploy'.length) },
      ],
    })
    expect(breakdown.agents).toEqual([])
    expect(breakdown).toMatchObject({ model: 'model-a', rawMaxTokens: 200_000, maxTokens: 200_000, autocompactSource: 'auto', autoCompactThreshold: 167_000 })
  })

  it('no listing in the window: no skills entry', () => {
    expect(breakdownWindow({ ...base, skillListings: [] }).skills).toBeUndefined()
  })
})

describe('the grid', () => {
  it('10 by 10; each used row at least one square, then free space, the buffer at the end', () => {
    const grid = breakdownWindow(base).gridRows
    expect(grid).toHaveLength(10)
    expect(grid.every(row => row.length === 10)).toBe(true)
    const names = grid.flat().map(square => square.categoryName)
    expect(names.slice(0, 7)).toEqual(['System prompt', 'System tools', 'MCP tools', 'Memory files', 'Skills', 'Messages', 'Messages'])
    expect(names.filter(name => name === 'Autocompact buffer')).toHaveLength(17)
    expect(names.at(-1)).toBe('Autocompact buffer')
    expect(grid.flat().filter(square => square.categoryName === 'Free space').every(square => !square.isFilled)).toBe(true)
  })

  it("a row's last square carries the fraction it holds", () => {
    const messages = breakdownWindow({ ...base, messageChars: 4 * 3_000 }).gridRows.flat().filter(square => square.categoryName === 'Messages')
    expect(messages.map(square => square.squareFullness)).toEqual([1, 0.5])
  })

  it('20 wide for a window of a million or more; 5 wide under 80 columns', () => {
    expect(breakdownWindow({ ...base, window: 1_000_000 }).gridRows[0]).toHaveLength(20)
    expect(breakdownWindow({ ...base, columns: 79 }).gridRows[0]).toHaveLength(5)
    expect(breakdownWindow({ ...base, columns: 80 }).gridRows[0]).toHaveLength(10)
  })
})

describe('the live window', () => {
  const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } }) as unknown as Message
  const answer = (text: string, usage?: Record<string, number>) =>
    ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], ...(usage ? { usage } : {}) } }) as unknown as Message
  const listing = { type: 'attachment', attachment: { type: 'skill_listing', content: '- review', skillNames: ['review'] } } as unknown as Message
  const boundary = { type: 'system', subtype: 'compact_boundary', message: '' } as unknown as Message

  it('starts at the last compaction', () => {
    const rows = [user('old'), boundary, user('new')]
    expect(liveWindowRows(rows)).toEqual([boundary, user('new')])
  })

  it('skill listings apart, the last charged response and the size of the rows after it', () => {
    const measured = measureLiveRows([
      user('aaaa'),
      listing,
      answer('bb', { input_tokens: 50, output_tokens: 5 }),
      user('cccccc'),
    ])
    expect(measured.skillListings).toEqual([{ text: '- review', names: ['review'] }])
    expect(measured.messageChars).toBe(12)
    expect(measured.charged).toEqual({
      counts: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tailChars: 6,
    })
  })

  it('a response before the last compaction is not charged', () => {
    expect(measureLiveRows([answer('x', { input_tokens: 50 }), boundary, user('y')]).charged).toBeUndefined()
  })
})
