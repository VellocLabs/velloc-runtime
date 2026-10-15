/**
 * Model ids → family, version, snapshot (overridable per `ProviderDefinition`), e.g.
 * `claude-haiku-4-5-20251001` → family `claude-haiku-*`, version 4.5, snapshot
 * 20251001. A variant is its own family. A PREVIEW is never "latest" but can be
 * pinned (`5.2-preview`).
 */

export type ModelVersionInfo = {
  /** The family key: the id with the version replaced by `*`, vendor prefix
   *  and variant kept. */
  family: string
  /** Numeric version, compared element-wise; `[]` for a family of one. */
  version: number[]
  /** What a user pins and sees: `5.1`, `2.5-preview`, `''` for no version. */
  versionLabel: string
  /** A dated build of the version (`20250123`, `2026-09-01`, `05-20`). */
  snapshot?: string
  preview: boolean
}

const PREVIEW_TOKEN = /^(preview|exp|experimental|beta|alpha|rc\d*)$/i
const NUMERIC = /^\d+(?:\.\d+)*$/
// A version glued to a name: `qwen3.8`, `k3`, `v4`, `o4`.
const GLUED = /^([a-z]+)(\d+(?:\.\d+)*)$/i

function isSnapshotTail(tokens: string[], at: number): number {
  // Returns how many trailing tokens from `at` form a date snapshot (0 = none).
  const rest = tokens.slice(at)
  if (rest.length === 1 && /^\d{8}$/.test(rest[0]!)) return 1
  if (rest.length === 1 && /^\d{4}$/.test(rest[0]!) && !/^(19|20)\d{2}$/.test(rest[0]!)) return 1 // MMDD
  if (rest.length === 3 && /^\d{4}$/.test(rest[0]!) && /^\d{2}$/.test(rest[1]!) && /^\d{2}$/.test(rest[2]!)) return 3
  if (rest.length === 2 && /^\d{2}$/.test(rest[0]!) && /^\d{2}$/.test(rest[1]!)) return 2 // MM-DD
  return 0
}

/** The provider-neutral reading. Never throws; an unreadable id is a family of one. */
export function parseModelVersion(id: string): ModelVersionInfo {
  const slash = id.lastIndexOf('/')
  const prefix = slash >= 0 ? id.slice(0, slash + 1) : ''
  let name = slash >= 0 ? id.slice(slash + 1) : id
  let variantSuffix = ''
  const colon = name.indexOf(':')
  if (colon >= 0) {
    variantSuffix = name.slice(colon)
    name = name.slice(0, colon)
  }
  const tokens = name.split('-')

  // Trailing date snapshot.
  let snapshot: string | undefined
  for (let at = Math.max(1, tokens.length - 3); at < tokens.length; at += 1) {
    const n = isSnapshotTail(tokens, at)
    if (n > 0 && at > 0) {
      snapshot = tokens.slice(at).join('-')
      tokens.length = at
      break
    }
  }

  // Preview tag: the first preview token and everything after it.
  let previewTokens: string[] = []
  const previewAt = tokens.findIndex((t, i) => i > 0 && PREVIEW_TOKEN.test(t))
  if (previewAt > 0) {
    previewTokens = tokens.slice(previewAt)
    tokens.length = previewAt
  }

  // The version: the first numeric token after the first (joined with
  // single-/double-digit numeric tokens that follow: `4-8` → 4.8), else a
  // version glued to a name token.
  let versionAt = -1
  let versionTokens = 1
  let versionText = ''
  let gluedName = ''
  for (let i = 1; i < tokens.length; i += 1) {
    if (NUMERIC.test(tokens[i]!)) {
      versionAt = i
      versionText = tokens[i]!
      while (
        !versionText.includes('.') &&
        i + versionTokens < tokens.length &&
        /^\d{1,2}$/.test(tokens[i + versionTokens]!)
      ) {
        versionText += `.${tokens[i + versionTokens]}`
        versionTokens += 1
      }
      break
    }
  }
  if (versionAt < 0) {
    for (let i = 0; i < tokens.length; i += 1) {
      const glued = GLUED.exec(tokens[i]!)
      if (glued) {
        versionAt = i
        gluedName = glued[1]!
        versionText = glued[2]!
        break
      }
    }
  }

  const preview = previewTokens.length > 0
  if (versionAt < 0) {
    // A family of one — still a preview when tagged, still a snapshot base.
    const base = [...tokens, ...previewTokens].join('-')
    return {
      family: `${prefix}${base}${variantSuffix}`,
      version: [],
      versionLabel: '',
      ...(snapshot ? { snapshot } : {}),
      preview,
    }
  }
  const familyTokens = [
    ...tokens.slice(0, versionAt),
    gluedName ? `${gluedName}*` : '*',
    ...tokens.slice(versionAt + versionTokens),
  ]
  return {
    family: `${prefix}${familyTokens.join('-')}${variantSuffix}`,
    version: versionText.split('.').map(Number),
    versionLabel: preview ? [versionText, ...previewTokens].join('-') : versionText,
    ...(snapshot ? { snapshot } : {}),
    preview,
  }
}

/** Newest first: by version, element-wise numerically (4.10 > 4.9). */
export function compareVersionsDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (b[i] ?? 0) - (a[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The id to send for one version among its listed ids: the undated alias
 * when the vendor lists one (the vendor keeps it on the version's newest
 * build), else the newest snapshot.
 */
export function pickVersionId(
  ids: readonly string[],
  parse: (id: string) => ModelVersionInfo = parseModelVersion,
): string | undefined {
  let best: { id: string; snapshot?: string } | undefined
  for (const id of ids) {
    const info = parse(id)
    if (!info.snapshot) return id
    if (!best || (best.snapshot ?? '') < info.snapshot) best = { id, snapshot: info.snapshot }
  }
  return best?.id
}
