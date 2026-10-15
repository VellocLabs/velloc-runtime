/**
 * Frontmatter parser: the leading `---` block, parsed as YAML via `./yamlText`.
 * A parse failure warns and degrades to empty frontmatter (whole file is body);
 * `descriptionAsText` drops non-scalar descriptions.
 */
import { parseYaml } from './yamlText'

export type HeaderFields = {
  description?: string | null
  'allowed-tools'?: string | string[] | null
  'argument-hint'?: string | null
  when_to_use?: string | null
  version?: string | null
  model?: string | null
  'user-invocable'?: string | boolean | null
  'disable-model-invocation'?: string | boolean | null
  hooks?: unknown
  paths?: string | string[] | null
  arguments?: string | string[] | null
  [key: string]: unknown
}

export type SplitMarkdownDoc = {
  frontmatter: HeaderFields
  content: string
}

// Characters that require quoting in YAML values when unquoted. The `: `
// pattern (not bare `:`) keeps `12:34` times and `https://` URLs unquoted.
const YAML_NEEDS_QUOTES_RE = /[{}[\]*&#!|>%@`]|: /

/**
 * Pre-process frontmatter text to quote values containing special YAML
 * characters, so glob patterns like `**\/*.{ts,tsx}` parse on the retry.
 */
function quoteRiskyScalars(headerYaml: string): string {
  const lines = headerYaml.split('\n')
  const result: string[] = []

  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_-]+):\s+(.+)$/)
    if (match) {
      const [, key, value] = match
      if (!key || !value) {
        result.push(line)
        continue
      }
      // Skip if already quoted
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        result.push(line)
        continue
      }
      if (YAML_NEEDS_QUOTES_RE.test(value)) {
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        result.push(`${key}: "${escaped}"`)
        continue
      }
    }
    result.push(line)
  }

  return result.join('\n')
}

export const HEADER_FENCE_RE = /^---\s*\n([\s\S]*?)---\s*\n?/

/**
 * Parse markdown content into frontmatter + the remaining body. The `\s*`
 * around the delimiters tolerates CRLF (`---\r\n`) and trailing whitespace.
 */
export function readMarkdownHeader(
  markdown: string,
  sourcePath?: string,
): SplitMarkdownDoc {
  const match = markdown.match(HEADER_FENCE_RE)
  if (!match) {
    return { frontmatter: {}, content: markdown }
  }

  const frontmatterText = match[1] || ''
  const content = markdown.slice(match[0].length)

  let frontmatter: HeaderFields = {}
  try {
    const parsed = parseYaml(frontmatterText) as HeaderFields | null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed
    }
  } catch {
    // Retry after quoting problematic values (e.g. unquoted glob patterns).
    try {
      const quotedText = quoteRiskyScalars(frontmatterText)
      const parsed = parseYaml(quotedText) as HeaderFields | null
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed
      }
    } catch (retryError) {
      const location = sourcePath ? ` in ${sourcePath}` : ''
      console.warn(
        `[skills] Failed to parse YAML frontmatter${location}: ${
          retryError instanceof Error ? retryError.message : retryError
        }`,
      )
    }
  }

  return { frontmatter, content }
}

/**
 * Split a comma-separated string (or YAML list) and expand brace patterns.
 * Commas inside braces are not separators.
 */
export function headerGlobList(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    return input.flatMap(headerGlobList)
  }
  if (typeof input !== 'string') {
    return []
  }

  const parts: string[] = []
  let current = ''
  let braceDepth = 0

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '{') {
      braceDepth++
      current += char
    } else if (char === '}') {
      braceDepth--
      current += char
    } else if (char === ',' && braceDepth === 0) {
      const trimmed = current.trim()
      if (trimmed) {
        parts.push(trimmed)
      }
      current = ''
    } else {
      current += char
    }
  }

  const trimmed = current.trim()
  if (trimmed) {
    parts.push(trimmed)
  }

  return parts.filter(p => p.length > 0).flatMap(pattern => braceVariants(pattern))
}

/** Expand brace patterns in a glob string (`src/*.{ts,tsx}` → two globs). */
function braceVariants(pattern: string): string[] {
  const braceMatch = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/)
  if (!braceMatch) {
    return [pattern]
  }

  const prefix = braceMatch[1] || ''
  const alternatives = braceMatch[2] || ''
  const suffix = braceMatch[3] || ''

  const parts = alternatives.split(',').map(alt => alt.trim())
  const expanded: string[] = []
  for (const part of parts) {
    expanded.push(...braceVariants(prefix + part + suffix))
  }
  return expanded
}

/**
 * Validate and coerce a description value. Strings are trimmed; numbers and
 * booleans are stringified; null/undefined/empty and non-scalar values return
 * null so the caller can fall back to a derived description.
 */
export function descriptionAsText(
  value: unknown,
  _componentName?: string,
): string | null {
  if (value == null) {
    return null
  }
  if (typeof value === 'string') {
    return value.trim() || null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

/**
 * Parse a boolean frontmatter value. Only literal `true` / `"true"` is true —
 * everything else (including YAML's `yes`/`no`/`1`/`0`, which parse as strings
 * under the 1.2 core schema) is false.
 */
export function headerFlag(value: unknown): boolean {
  return value === true || value === 'true'
}
