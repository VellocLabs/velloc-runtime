/**
 * `context.breakdown` of `$.session.usage({ breakdown })` (F-25): the live window split into
 * rows, estimated locally at four characters a token, with the grid a mod draws. Field names and
 * row labels are the plugin API's; the counting is Velloc's. Pure.
 */

/** The four counts of one response, absent ones read as 0. */
export type ResponseCounts = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type WindowRowKind = 'used' | 'free' | 'buffer' | 'deferred'

export type WindowRow = { name: string; tokens: number; color: string; isDeferred: boolean; kind: WindowRowKind }

export type WindowSquare = {
  color: string
  isFilled: boolean
  categoryName: string
  tokens: number
  percentage: number
  squareFullness: number
}

export type WindowBreakdown = {
  categories: WindowRow[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  autocompactSource: 'auto'
  percentage: number
  gridRows: WindowSquare[][]
  model: string
  memoryFiles: { path: string; type: string; tokens: number }[]
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  agents: { agentType: string; source: string; tokens: number }[]
  skills?: {
    totalSkills: number
    includedSkills: number
    tokens: number
    skillFrontmatter: { name: string; source: string; tokens: number }[]
  }
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
  apiUsage: ResponseCounts | null
}

/** What the engine gathers for one breakdown; sizes in characters. */
export type WindowBreakdownInput = {
  model: string
  /** The model's window in tokens. */
  window: number
  /** System-prompt sections and ambient context, instruction files excluded. */
  systemChars: number
  /** Each tool definition the model is sent; `server` marks an MCP tool. */
  tools: readonly { name: string; chars: number; server?: string }[]
  memoryFiles: readonly { path: string; type: string; chars: number }[]
  /** The auto-memory section of the system prompt. */
  memorySectionChars: number
  /** Each skill-listing note in the live window, as the model reads it. */
  skillListings: readonly { text: string; names: readonly string[] }[]
  /** Every other row of the live window. */
  messageChars: number
  /** The live window's last response with usage, and the rows after it. */
  charged?: { counts: ResponseCounts; tailChars: number }
  compaction: { enabled: boolean; threshold?: number }
  /** The width the caller draws in; under 80 narrows the grid. */
  columns?: number
}

const LABEL = {
  system: 'System prompt',
  tools: 'System tools',
  mcp: 'MCP tools',
  memory: 'Memory files',
  skills: 'Skills',
  messages: 'Messages',
  buffer: 'Autocompact buffer',
  free: 'Free space',
} as const

/** Theme keys the mod renderer resolves. */
const COLOR = {
  system: 'promptBorder',
  tools: 'inactive',
  mcp: 'ide',
  memory: 'claude',
  skills: 'warning',
  messages: 'permission',
  buffer: 'inactive',
  free: 'promptBorder',
} as const

const GRID_HEIGHT = 10
const NARROW_COLUMNS = 80
const LARGE_WINDOW = 1_000_000

export function tokensOfChars(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 4) : 0
}

/** The window as of that response: what it read plus what it wrote. */
function chargedWindow(counts: ResponseCounts): number {
  return counts.input_tokens + counts.cache_creation_input_tokens + counts.cache_read_input_tokens + counts.output_tokens
}

function wholePercent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

/** The listing's line for `name`: `- name: …` or a bare `- name`. */
function listingLineOf(text: string, name: string): string | undefined {
  return text.split('\n').find(line => line === `- ${name}` || line.startsWith(`- ${name}:`))
}

function gridOf(rows: readonly WindowRow[], window: number, columns: number | undefined): WindowSquare[][] {
  const width = columns !== undefined && columns < NARROW_COLUMNS ? 5 : window >= LARGE_WINDOW ? 20 : 10
  const total = width * GRID_HEIGHT
  if (window <= 0) return []
  const perSquare = window / total
  const squares: WindowSquare[] = []
  const place = (row: WindowRow, count: number, exact: number): void => {
    let left = exact
    for (let i = 0; i < count && squares.length < total; i++) {
      const fullness = row.kind === 'used' ? Math.min(1, Math.max(0, left)) : 1
      left -= 1
      squares.push({
        color: row.color,
        isFilled: row.kind !== 'free',
        categoryName: row.name,
        tokens: row.tokens,
        percentage: wholePercent(row.tokens, window),
        squareFullness: fullness > 0 ? fullness : 1,
      })
    }
  }
  const used = rows.filter(row => row.kind === 'used')
  const buffer = rows.find(row => row.kind === 'buffer')
  const free = rows.find(row => row.kind === 'free')
  for (const row of used) {
    const exact = row.tokens / perSquare
    place(row, Math.max(1, Math.round(exact)), exact)
  }
  const bufferCount = buffer ? Math.round(buffer.tokens / perSquare) : 0
  if (free) place(free, Math.max(0, total - squares.length - bufferCount), 0)
  if (buffer) place(buffer, total - squares.length, 0)
  const grid: WindowSquare[][] = []
  for (let i = 0; i < squares.length; i += width) grid.push(squares.slice(i, i + width))
  return grid
}

export function breakdownWindow(input: WindowBreakdownInput): WindowBreakdown {
  const { window } = input
  const systemTools = input.tools.filter(tool => tool.server === undefined)
  const mcpTools = input.tools.filter(tool => tool.server !== undefined)
  const memoryFiles = input.memoryFiles.map(file => ({ path: file.path, type: file.type, tokens: tokensOfChars(file.chars) }))
  const skillTokens = input.skillListings.reduce((sum, listing) => sum + tokensOfChars(listing.text.length), 0)

  const sized: [keyof typeof LABEL, number][] = [
    ['system', tokensOfChars(input.systemChars)],
    ['tools', systemTools.reduce((sum, tool) => sum + tokensOfChars(tool.chars), 0)],
    ['mcp', mcpTools.reduce((sum, tool) => sum + tokensOfChars(tool.chars), 0)],
    ['memory', memoryFiles.reduce((sum, file) => sum + file.tokens, 0) + tokensOfChars(input.memorySectionChars)],
    ['skills', skillTokens],
  ]
  const others = sized.reduce((sum, [, tokens]) => sum + tokens, 0)
  // Reconciled to what the model was charged, so the used rows add up to it.
  const messages = input.charged
    ? Math.max(0, chargedWindow(input.charged.counts) + tokensOfChars(input.charged.tailChars) - others)
    : tokensOfChars(input.messageChars)
  sized.push(['messages', messages])

  const categories: WindowRow[] = sized
    .filter(([, tokens]) => tokens > 0)
    .map(([key, tokens]) => ({ name: LABEL[key], tokens, color: COLOR[key], isDeferred: false, kind: 'used' }))
  const totalTokens = categories.reduce((sum, row) => sum + row.tokens, 0)
  const threshold = input.compaction.enabled ? input.compaction.threshold : undefined
  const reserved = threshold !== undefined ? Math.max(0, window - threshold) : 0
  if (reserved > 0) {
    categories.push({ name: LABEL.buffer, tokens: reserved, color: COLOR.buffer, isDeferred: false, kind: 'buffer' })
  }
  categories.push({
    name: LABEL.free,
    tokens: Math.max(0, window - totalTokens - reserved),
    color: COLOR.free,
    isDeferred: false,
    kind: 'free',
  })

  const listedNames = input.skillListings.flatMap(listing => listing.names.map(name => ({ name, listing })))
  return {
    categories,
    totalTokens,
    maxTokens: window,
    rawMaxTokens: window,
    autocompactSource: 'auto',
    percentage: wholePercent(totalTokens, window),
    gridRows: gridOf(categories, window, input.columns),
    model: input.model,
    memoryFiles,
    mcpTools: mcpTools.map(tool => ({
      name: tool.name,
      serverName: tool.server!,
      tokens: tokensOfChars(tool.chars),
      isLoaded: true,
    })),
    agents: [],
    ...(skillTokens > 0
      ? {
          skills: {
            totalSkills: listedNames.length,
            includedSkills: listedNames.length,
            tokens: skillTokens,
            skillFrontmatter: listedNames.map(({ name, listing }) => ({
              name,
              source: 'listing',
              tokens: tokensOfChars(listingLineOf(listing.text, name)?.length ?? 0),
            })),
          },
        }
      : {}),
    ...(threshold !== undefined ? { autoCompactThreshold: threshold } : {}),
    isAutoCompactEnabled: input.compaction.enabled,
    apiUsage: input.charged ? { ...input.charged.counts } : null,
  }
}
