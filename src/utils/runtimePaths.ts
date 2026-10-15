function hasWindowsDrivePrefix(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
}

function isWindowsStylePath(value: string): boolean {
  return hasWindowsDrivePrefix(value) || value.startsWith('\\\\')
}

type RuntimePathStyle = 'posix' | 'win32'

type ParsedRuntimePath = {
  style: RuntimePathStyle
  root: string
  isAbsolute: boolean
  segments: string[]
}

function getPathStyle(reference: string): RuntimePathStyle {
  return isWindowsStylePath(reference) ? 'win32' : 'posix'
}

function getSeparator(style: RuntimePathStyle): '/' | '\\' {
  return style === 'win32' ? '\\' : '/'
}

function normalizeSeparators(value: string, style: RuntimePathStyle): string {
  return style === 'win32' ? value.replace(/\//g, '\\') : value.replace(/\\/g, '/')
}

function splitRoot(
  value: string,
  style: RuntimePathStyle,
): { root: string; remainder: string; isAbsolute: boolean } {
  if (style === 'win32') {
    const normalized = normalizeSeparators(value, style)
    const uncMatch = normalized.match(/^\\\\[^\\]+\\[^\\]+(?:\\|$)/)
    if (uncMatch) {
      const root = uncMatch[0].endsWith('\\') ? uncMatch[0] : `${uncMatch[0]}\\`
      return {
        root,
        remainder: normalized.slice(root.length),
        isAbsolute: true,
      }
    }

    const driveMatch = normalized.match(/^[A-Za-z]:\\/)
    if (driveMatch) {
      return {
        root: driveMatch[0],
        remainder: normalized.slice(driveMatch[0].length),
        isAbsolute: true,
      }
    }

    if (normalized.startsWith('\\')) {
      return {
        root: '\\',
        remainder: normalized.slice(1),
        isAbsolute: true,
      }
    }

    return {
      root: '',
      remainder: normalized,
      isAbsolute: false,
    }
  }

  const normalized = normalizeSeparators(value, style)
  if (normalized.startsWith('/')) {
    return {
      root: '/',
      remainder: normalized.slice(1),
      isAbsolute: true,
    }
  }

  return {
    root: '',
    remainder: normalized,
    isAbsolute: false,
  }
}

function parseRuntimePath(value: string): ParsedRuntimePath {
  const style = getPathStyle(value)
  const { root, remainder, isAbsolute } = splitRoot(value, style)
  const separator = getSeparator(style)
  const segments: string[] = []

  for (const rawSegment of remainder.split(separator)) {
    if (!rawSegment || rawSegment === '.') {
      continue
    }

    if (rawSegment === '..') {
      const lastSegment = segments[segments.length - 1]
      if (lastSegment && lastSegment !== '..') {
        segments.pop()
      } else if (!isAbsolute) {
        segments.push(rawSegment)
      }
      continue
    }

    segments.push(rawSegment)
  }

  return {
    style,
    root,
    isAbsolute,
    segments,
  }
}

function formatRuntimePath(parsed: ParsedRuntimePath): string {
  if (parsed.root) {
    return parsed.segments.length === 0
      ? parsed.root
      : `${parsed.root}${parsed.segments.join(getSeparator(parsed.style))}`
  }

  if (parsed.segments.length === 0) {
    return parsed.isAbsolute ? getSeparator(parsed.style) : '.'
  }

  return parsed.segments.join(getSeparator(parsed.style))
}

/**
 * A path as compared for "the same one": one separator, no trailing separator
 * (a lone root keeps its own), a drive letter in one case. Dedup and
 * containment keys only — never display or hand it to the fs.
 */
export function pathCompareKey(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/(?<=.)\/+$/, '')
  return /^[A-Za-z]:/.test(slashed)
    ? slashed[0]!.toLowerCase() + slashed.slice(1)
    : slashed
}

export function normalizeRuntimePath(value: string): string {
  if (!value) {
    return '.'
  }

  return formatRuntimePath(parseRuntimePath(value))
}

function sameRoot(left: ParsedRuntimePath, right: ParsedRuntimePath): boolean {
  if (left.style !== right.style) {
    return false
  }

  if (left.style === 'win32') {
    return left.root.toLowerCase() === right.root.toLowerCase()
  }

  return left.root === right.root
}

function sameSegment(
  style: RuntimePathStyle,
  left: string,
  right: string,
): boolean {
  return style === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

export function isAbsoluteRuntimePath(value: string): boolean {
  if (!value) {
    return false
  }

  return parseRuntimePath(value).isAbsolute
}

export function resolveRuntimePath(cwd: string, targetPath: string): string {
  if (!targetPath) {
    return normalizeRuntimePath(cwd)
  }

  if (isAbsoluteRuntimePath(targetPath)) {
    return normalizeRuntimePath(targetPath)
  }

  return joinRuntimePath(cwd, targetPath)
}

export function relativeRuntimePath(fromPath: string, toPath: string): string {
  const fromParsed = parseRuntimePath(normalizeRuntimePath(fromPath))
  const toParsed = parseRuntimePath(normalizeRuntimePath(toPath))
  if (!sameRoot(fromParsed, toParsed)) {
    return toPath
  }

  let sharedPrefixLength = 0
  while (
    sharedPrefixLength < fromParsed.segments.length
    && sharedPrefixLength < toParsed.segments.length
    && sameSegment(
      fromParsed.style,
      fromParsed.segments[sharedPrefixLength],
      toParsed.segments[sharedPrefixLength],
    )
  ) {
    sharedPrefixLength += 1
  }

  const relativeSegments = [
    ...new Array(fromParsed.segments.length - sharedPrefixLength).fill('..'),
    ...toParsed.segments.slice(sharedPrefixLength),
  ]

  return relativeSegments.length === 0
    ? '.'
    : relativeSegments.join(getSeparator(fromParsed.style))
}

export function joinRuntimePath(
  basePath: string,
  ...segments: string[]
): string {
  const style = getPathStyle(basePath)
  const separator = getSeparator(style)
  const combined = [
    normalizeSeparators(basePath, style),
    ...segments.map(segment => normalizeSeparators(segment, style)),
  ]
    .filter(segment => segment.length > 0)
    .join(separator)

  return normalizeRuntimePath(combined)
}

export function dirnameRuntimePath(targetPath: string): string {
  const normalized = normalizeRuntimePath(targetPath)
  if (normalized === '.') {
    return '.'
  }

  const parsed = parseRuntimePath(normalized)
  if (parsed.segments.length === 0) {
    return parsed.root || '.'
  }

  return formatRuntimePath({
    ...parsed,
    segments: parsed.segments.slice(0, -1),
  })
}

export function basenameRuntimePath(targetPath: string): string {
  const normalized = normalizeRuntimePath(targetPath)
  if (normalized === '.') {
    return '.'
  }

  const parsed = parseRuntimePath(normalized)
  return parsed.segments[parsed.segments.length - 1] ?? ''
}

export function extnameRuntimePath(targetPath: string): string {
  const basename = basenameRuntimePath(targetPath)
  const extensionIndex = basename.lastIndexOf('.')
  if (extensionIndex <= 0) {
    return ''
  }

  return basename.slice(extensionIndex)
}

export function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session'
}
