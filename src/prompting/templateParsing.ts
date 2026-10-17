// Pure parse logic for the per-session templates (`readMarkdownHeader`, the
// parsers, `buildRegistry`). Run at build time for the bundled registry, and
// loaded dynamically only for a local overlay and in the SharedWorker, so the
// page never imports `yaml`. No `import.meta.glob` or browser-only API.

import {
  headerFlag,
  readMarkdownHeader,
} from '../utils/frontmatter'

/** The `skills:` frontmatter value: every skill, or an exact id allowlist. */
export type SkillAllowlist = 'all' | readonly string[]

/** The namespaces a stable skill id may name — `ChromiumSkillSource`. */
export const SKILL_ID_NAMESPACES = ['bundled', 'project', 'user', 'plugin'] as const

/** `<source>:<name>` — the id is the STABLE identity, never the display name. */
const SKILL_ID_RE = new RegExp(
  `^(?:${SKILL_ID_NAMESPACES.join('|')}):[A-Za-z0-9][A-Za-z0-9_.:-]*$`,
)

/**
 * Parse `skills:`, validation stage one (syntax and namespace); stage two
 * (does the skill exist) runs at session skill resolution. A malformed id
 * throws; no id is silently dropped.
 */
function parseSkillAllowlist(value: unknown, type: string): SkillAllowlist | undefined {
  if (value === undefined) return undefined
  // A PRESENT key with no value (`skills:` / `skills: ~` — YAML null) is not
  // "absent". Reading it as allow-all made a half-written deny-all fail open;
  // it is refused like any other malformed value.
  if (value === null) {
    throw new Error(
      `template "${type}": skills: has no value — write [] to deny every skill, ` +
        'a list of "<source>:<name>" ids, or "all" (or remove the key)',
    )
  }
  if (value === 'all') return 'all'
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || !SKILL_ID_RE.test(entry.trim())) {
        throw new Error(
          `template "${type}": skills: ${JSON.stringify(entry)} is not a skill id — ` +
            `use "<source>:<name>" with source one of ${SKILL_ID_NAMESPACES.join(', ')} ` +
            '(the stable identity, not the display name), or "all"',
        )
      }
      out.push(entry.trim())
    }
    return out
  }
  throw new Error(
    `template "${type}": skills: must be "all" or a list of "<source>:<name>" ids, ` +
      `got ${JSON.stringify(value)}`,
  )
}

export type PromptElement =
  /**
   * `profile`: the optional `@lean` / `@standard` gate (absent ⇒ both), so one
   * manifest can give each profile different sections and order. `render`: the
   * optional `=standard` / `=lean` pin, rendering that profile's prose under
   * every admitted profile.
   */
  | {
      kind: 'holder'
      name: string
      profile?: HolderProfileGate
      render?: HolderProfileGate
    }
  | { kind: 'dynamic'; name: string }
  | { kind: 'literal'; text: string }

export interface TemplateConfig {
  type: string
  /** Explicit tool allowlist over the host tool set; absent ⇒ full set. */
  description?: string
  tools?: string[]
  /** Skills/tools deferred until Skill()/ToolSearch activates them. */
  deferredTools?: string[]
  /** Skills/tools SEALED: registered in the runtime set (so an internal
   *  dispatcher — e.g. the `exec` tool's Bash gate — can reach them) but never
   *  model-visible, never listed in ToolSearch's catalog, and never
   *  activatable. A stronger tier than `deferredTools`: deferral is
   *  progressive disclosure, sealing is a hard boundary. */
  sealedTools?: string[]
  /** Security: this type may never RUN anything outside its sandboxes
   *  (`safe_code`). Read only by `templateAllowsMcp`, since MCP tools join after
   *  the `tools:` allowlist and stdio servers spawn processes. Not passed to
   *  tools: `run_js` runs in the hardened realm either way. */
  noExecution?: boolean
  /** Security: SKILLS this type may use: `'all'` (default) or an exact list of
   *  `<source>:<name>` ids (empty = deny-all). A capability boundary over
   *  `$skill_listing`, `Skill()` and `/name`, enforced where the command list is
   *  built. Not the Skill tool itself, nor `Skill('mcp__<server>')`. */
  skills?: SkillAllowlist
  /** This session type records per-turn file snapshots (session-scoped
   *  before/after images of every mutated file — the git replacement for
   *  types without a shell). Read in two places, both in
   *  createAgentRuntime via `templateWantsFileSnapshots`
   *  (templateRegistry.ts): a `FileSnapshotRecorder` is built for the
   *  session, and the read-only `WorkspaceDiff` tool is appended to its
   *  tool set. Absent/false ⇒ no recorder, no tool, zero new IO — today's
   *  behaviour for every other type. First (only) user: `safe_code`. */
  fileSnapshots?: boolean
  model?: string
}

/**
 * A launcher-catalog entry from `index.md` — the lightweight per-type metadata
 * the sidebar needs to render the type list (name + title + icon) WITHOUT
 * loading the type's heavy `template.md`.
 */
export interface LauncherMeta {
  type: string
  /** Launcher label (literal). Fallback when `titleI18n` is absent / its key
   *  has no message. */
  title?: string
  /** i18n key for the label — the FIRST choice; falls back to `title`, then the
   *  bare `type`. From `title-i18n`. */
  titleI18n?: string
  /** Inline icon as an SVG **data URI** (`data:image/svg+xml;base64,…`), rendered
   *  as `<img src>`. ONLY an SVG data URI is accepted — any other value is ignored
   *  (→ `iconLucide`). Overrides `iconLucide`. (No icon files.) */
  icon?: string
  /** A lucide-react icon name (e.g. 'bot'); used when no `icon` data URI is set.
   *  From `icon_lucide`. */
  iconLucide?: string
  /** `launcherHidden` — the type stays in the catalog (a full, creatable
   *  type: `openNewSession(type)` / `?templateType=` work) but is not OFFERED
   *  on the given surface(s):
   *    `'both'`     — sidebar AND project menu (unless the UI unhides it, see
   *                     `filterLaunchers`);
   *    `'sidebar'`  — sidebar only; the project menu still offers it.
   *  Absent ⇒ offered on both. */
  launcherHidden?: 'both' | 'sidebar'
  /** `launcherMenu: false` — still in the sidebar launcher (subject to
   *  `launcherHidden`) but NOT offered in the project folder's `+`/`⋯` menu.
   *  Strict `false` only; absent ⇒ offered (today's behaviour). Inverted
   *  polarity vs `launcherHidden` on purpose: absence must change nothing. */
  launcherMenu?: false
}

/** One welcome-page suggestion chip (a prompt starter) from `welcome.md`. */
export interface WelcomeSuggestion {
  /** The chip's main text. */
  title: string
  /** Optional subtitle shown under the title. */
  description?: string
  /** Text sent when the chip is clicked; defaults to `title`. */
  prompt?: string
}

/**
 * A type's welcome page (from `<type>/welcome.md`, or a `welcome-<locale>.md`
 * variant): optional greeting/subtitle overrides + the suggestion chips.
 */
export interface WelcomeContent {
  /** Greeting shown above the suggestion chips for this type. No greeting
   *  renders if unset (there is no global i18n fallback). */
  greeting?: string
  /** Optional subtitle beneath the greeting for this type. */
  subtitle?: string
  suggestions: WelcomeSuggestion[]
}

export interface ParsedTemplate {
  config: TemplateConfig
  prompt: PromptElement[]
  begin: PromptElement[]
}

export interface HolderFile {
  name: string
  /**
   * '' = the base file (the STANDARD profile rendering); `'lean'` = the file
   * carries the `-lean` suffix. Deliberately NOT `PromptProfile`: a file is
   * never tagged `'standard'` (the base file is the standard rendering), so
   * the type cannot admit a value `getHolderProse` would not match. See
   * `parseHolderFilename` and `prompting/promptProfile.ts`.
   */
  profile: '' | 'lean'
  content: string
}

export interface RegistryData {
  sharedHolders: HolderFile[]
  typeHolders: Map<string, HolderFile[]>
  templates: Map<string, ParsedTemplate>
  /** `<type>/template-beta.md` manifests — what `getTemplate` returns on the
   *  beta channel for a type that has one (`templateRegistry.ts`). A type
   *  with no beta manifest uses `templates` on both channels. */
  betaTemplates: Map<string, ParsedTemplate>
  launcherCatalog: LauncherMeta[]
  launcherByType: Map<string, LauncherMeta>
  /** `index-beta.md` — the WHOLE launcher catalog on the beta channel, or
   *  `null` when the file does not exist (beta then uses `launcherCatalog`).
   *  Replace, not merge: a type the beta catalog omits is not offered there. */
  betaLauncherCatalog: LauncherMeta[] | null
  // type -> locale ('' = the default `welcome.md`) -> parsed welcome page.
  welcomeByType: Map<string, Map<string, WelcomeContent>>
}

/** The catalog file on the stable channel, and its beta replacement. */
export const INDEX_FILE = 'index.md'
export const BETA_INDEX_FILE = 'index-beta.md'
/** A type's manifest on the stable channel, and its beta replacement. */
export const TEMPLATE_FILE = 'template.md'
export const BETA_TEMPLATE_FILE = 'template-beta.md'

// Holder names are snake_case, so ANY `-<suffix>` on a holder filename is a
// variant marker, and the only variant is the lean profile (`-lean`). The
// base file IS the standard rendering, so `-standard` is not a suffix; and
// the retired `-<provider>` suffixes (`-anthropic`, `-openai`, …) are not
// either — prompt prose varies by model profile, never by provider. Every other suffix is rejected loudly rather than silently filed as an
// unreferenced holder named `foo-bar`: for the bundled tree that fails the
// vite build; for a plugin's template the session does not start.
export const LEAN_SUFFIX = 'lean'

// `intro.md` → { name:'intro', profile:'' }
// `intro-lean.md` → { name:'intro', profile:'lean' }
function parseHolderFilename(file: string): {
  name: string
  profile: '' | typeof LEAN_SUFFIX
} {
  const base = file.replace(/\.md$/i, '')
  const dash = base.lastIndexOf('-')
  if (dash > 0) {
    const suffix = base.slice(dash + 1)
    if (suffix === LEAN_SUFFIX) {
      return { name: base.slice(0, dash), profile: LEAN_SUFFIX }
    }
    throw new Error(
      `template holder "${file}": "-${suffix}" is not a variant suffix — ` +
        'holder names are snake_case and the only variant is "-lean" (the ' +
        'base file is the standard rendering; there are no provider variants)',
    )
  }
  return { name: base, profile: '' }
}

function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((x): x is string => typeof x === 'string')
    return out.length > 0 ? out : undefined
  }
  if (typeof value === 'string') {
    const out = value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    return out.length > 0 ? out : undefined
  }
  return undefined
}

/** Trim a frontmatter scalar to a non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

// `icon` accepts ONLY an SVG data URI (`data:image/svg+xml[;...],...`) — any
// other value (other URLs, non-SVG data URIs) is IGNORED so it never reaches the
// launcher `<img>`. Resolution then falls through to `icon_lucide`.
const SVG_DATA_URI = /^data:image\/svg\+xml[;,]/i

function svgDataUri(v: unknown): string | undefined {
  const s = str(v)
  return s && SVG_DATA_URI.test(s) ? s : undefined
}

// Lines under a `## <name>` heading, until the next `## ` heading or EOF.
function extractSectionLines(body: string, name: string): string[] {
  const lines = body.split(/\r?\n/)
  const out: string[] = []
  let inSection = false
  for (const line of lines) {
    const heading = line.match(/^##\s+(\S+)/)
    if (heading) {
      inSection = heading[1] === name
      continue
    }
    if (inSection) out.push(line)
  }
  return out
}

/** The prompt profiles a `!holder @<profile>` line may name. */
export type HolderProfileGate = typeof LEAN_SUFFIX | 'standard'
const HOLDER_PROFILE_GATES: readonly HolderProfileGate[] = [LEAN_SUFFIX, 'standard']

function parseSkeleton(lines: string[]): PromptElement[] {
  const out: PromptElement[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    // Blank lines and `#`-prefixed comment lines are ignored.
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('!')) {
      const [name, ...rest] = trimmed.slice(1).split(/\s+/)
      if (!name) continue
      // `@<profile>` gates WHEN the holder is emitted; `=<profile>` pins
      // WHICH rendering it emits. A misspelt token of either kind must not
      // degrade into "emitted under both profiles" / "rendered per turn" —
      // that is a silent prompt change. Same rule as the holder file
      // suffixes (`-lean` or nothing).
      const readProfileToken = (
        marker: '@' | '=',
        what: string,
      ): HolderProfileGate | undefined => {
        const token = rest.find(t => t.startsWith(marker))
        if (token === undefined) return undefined
        const profile = token.slice(1)
        if (!(HOLDER_PROFILE_GATES as readonly string[]).includes(profile)) {
          throw new Error(
            `template skeleton: "!${name} ${token}" — the ${what} must be ` +
              `${marker}${HOLDER_PROFILE_GATES.join(` or ${marker}`)}`,
          )
        }
        return profile as HolderProfileGate
      }
      const profile = readProfileToken('@', 'profile gate')
      const render = readProfileToken('=', 'render pin')
      out.push({
        kind: 'holder',
        name,
        ...(profile !== undefined ? { profile } : {}),
        ...(render !== undefined ? { render } : {}),
      })
    } else if (trimmed.startsWith('$')) {
      const name = trimmed.slice(1).split(/\s/)[0]
      if (name) out.push({ kind: 'dynamic', name })
    } else {
      out.push({ kind: 'literal', text: trimmed })
    }
  }
  return out
}

export function parseManifest(fallbackType: string, raw: string): ParsedTemplate {
  const { frontmatter, content } = readMarkdownHeader(raw)
  const fm = frontmatter as Record<string, unknown>
  const config: TemplateConfig = {
    type: typeof fm.type === 'string' && fm.type.trim() ? fm.type.trim() : fallbackType,
    description: typeof fm.description === 'string' ? fm.description : undefined,
    tools: toStringArray(fm.tools),
    deferredTools: toStringArray(fm.deferredTools),
    sealedTools: toStringArray(fm.sealedTools),
    // Strict `true` only — the same `headerFlag` every other
    // boolean frontmatter key uses, so the spelling rules don't vary per key.
    // A typo therefore reads as `false` (executes like every other type), which
    // is why `templateRegistry.test.ts` asserts safe_code parses with
    // `noExecution === true` rather than trusting the manifest text.
    noExecution: headerFlag(fm.noExecution),
    // Same strict-`true` rule as `noExecution` (and pinned the same way in
    // templateRegistry.test.ts): a typo reads as `false` — no recorder — so
    // the manifest text is not trusted, the parsed value is.
    fileSnapshots: headerFlag(fm.fileSnapshots),
    // `all` / absent ⇒ undefined (every skill); a list ⇒ the exact allowlist.
    // Throws on a malformed id — see `parseSkillAllowlist`.
    skills: parseSkillAllowlist(
      fm.skills,
      typeof fm.type === 'string' && fm.type.trim() ? fm.type.trim() : fallbackType,
    ),
    model: typeof fm.model === 'string' && fm.model.trim() ? fm.model.trim() : undefined,
  }
  return {
    config,
    prompt: parseSkeleton(extractSectionLines(content, 'prompt')),
    begin: parseSkeleton(extractSectionLines(content, 'begin')),
  }
}

/** `launcherHidden` value → its scope. Only the two spellings `'both'` and
 *  `'sidebar'` are honoured; anything else (including a bare `true`) ⇒
 *  `undefined` (offered). */
function parseLauncherHidden(v: unknown): 'both' | 'sidebar' | undefined {
  if (v === 'both') return 'both'
  if (v === 'sidebar') return 'sidebar'
  return undefined
}

// Parse `index.md`'s (or `index-beta.md`'s) `types:` frontmatter list → the
// launcher catalog (the lightweight per-type name/title/icon the sidebar
// renders from, without the heavy `template.md`). Which channel shows which
// catalog is not a per-entry key: a channel that should offer something
// different has its own file (`BETA_INDEX_FILE`).
export function parseLauncherCatalog(raw: string): LauncherMeta[] {
  const { frontmatter } = readMarkdownHeader(raw)
  const types = (frontmatter as Record<string, unknown>).types
  if (!Array.isArray(types)) return []
  const out: LauncherMeta[] = []
  for (const entry of types) {
    const e = entry as Record<string, unknown>
    const type = str(e.type)
    if (!type) continue
    out.push({
      type,
      title: str(e.title),
      titleI18n: str(e['title-i18n']),
      icon: svgDataUri(e.icon),
      iconLucide: str(e.icon_lucide),
      // Scoped hide: `'both'` hides both surfaces, `'sidebar'` the sidebar
      // only. `undefined` when not set so "visible" is absence of the key, as
      // in the file.
      ...(parseLauncherHidden(e.launcherHidden)
        ? { launcherHidden: parseLauncherHidden(e.launcherHidden) }
        : {}),
      // Inverted polarity: only a strict `false` opts out, so an absent key
      // (every template today) keeps the project menu exactly as it was.
      ...(e.launcherMenu === false || e.launcherMenu === 'false'
        ? { launcherMenu: false as const }
        : {}),
    })
  }
  return out
}

// Parse a `welcome.md` (or `welcome-<locale>.md`) → greeting/subtitle/suggestions.
export function parseWelcome(raw: string): WelcomeContent {
  const { frontmatter } = readMarkdownHeader(raw)
  const fm = frontmatter as Record<string, unknown>
  const suggestions: WelcomeSuggestion[] = []
  if (Array.isArray(fm.suggestions)) {
    for (const entry of fm.suggestions) {
      const e = entry as Record<string, unknown>
      const title = str(e.title)
      if (!title) continue
      // Preserve `prompt` verbatim — a trailing ": " in a fill-in starter (e.g.
      // "Research this topic … summary: ") is intentional, so it is NOT trimmed
      // (unlike title/description). Only a blank/whitespace-only prompt → undefined
      // (then the chip falls back to `title`).
      const prompt =
        typeof e.prompt === 'string' && e.prompt.trim().length > 0
          ? e.prompt
          : undefined
      suggestions.push({
        title,
        description: str(e.description),
        prompt,
      })
    }
  }
  return { greeting: str(fm.greeting), subtitle: str(fm.subtitle), suggestions }
}

// `welcome.md` → '' (default); `welcome-zh.md` → 'zh'. The locale suffix is the
// UI locale code (see browser/webview/i18n) — Chinese is `zh`, not `cn`.
const WELCOME_FILE = /^welcome(?:-([a-z][a-z-]*))?\.md$/i

/**
 * Parse template files (`relativePath → raw content`, relative to `template/`)
 * into the registry maps, for the bundle and a local overlay alike.
 * `index-beta.md` and `<type>/template-beta.md` fill the beta maps; holders
 * and welcome pages have no beta variant.
 */
export function buildRegistry(
  source: Iterable<readonly [string, string]>,
): RegistryData {
  const sharedHolders: HolderFile[] = []
  const typeHolders = new Map<string, HolderFile[]>()
  const templates = new Map<string, ParsedTemplate>()
  const betaTemplates = new Map<string, ParsedTemplate>()
  const launcherCatalog: LauncherMeta[] = []
  const launcherByType = new Map<string, LauncherMeta>()
  let betaLauncherCatalog: LauncherMeta[] | null = null
  const welcomeByType = new Map<string, Map<string, WelcomeContent>>()
  for (const [rel, raw] of source) {
    if (rel === INDEX_FILE) {
      for (const meta of parseLauncherCatalog(raw)) {
        launcherCatalog.push(meta)
        launcherByType.set(meta.type, meta)
      }
      continue
    }
    if (rel === BETA_INDEX_FILE) {
      betaLauncherCatalog = parseLauncherCatalog(raw)
      continue
    }
    const segs = rel.split('/')
    if (segs[0] === 'shared_includes' && segs.length === 2) {
      const { name, profile } = parseHolderFilename(segs[1])
      sharedHolders.push({ name, profile, content: raw })
    } else if (segs.length === 2 && segs[1] === TEMPLATE_FILE) {
      templates.set(segs[0], parseManifest(segs[0], raw))
    } else if (segs.length === 2 && segs[1] === BETA_TEMPLATE_FILE) {
      betaTemplates.set(segs[0], parseManifest(segs[0], raw))
    } else if (segs.length === 3 && segs[1] === 'includes') {
      const { name, profile } = parseHolderFilename(segs[2])
      const arr = typeHolders.get(segs[0]) ?? []
      arr.push({ name, profile, content: raw })
      typeHolders.set(segs[0], arr)
    } else if (segs.length === 2 && WELCOME_FILE.test(segs[1])) {
      const locale = (segs[1].match(WELCOME_FILE)?.[1] ?? '').toLowerCase()
      const byLocale =
        welcomeByType.get(segs[0]) ?? new Map<string, WelcomeContent>()
      byLocale.set(locale, parseWelcome(raw))
      welcomeByType.set(segs[0], byLocale)
    }
  }
  return {
    sharedHolders,
    typeHolders,
    templates,
    betaTemplates,
    launcherCatalog,
    launcherByType,
    betaLauncherCatalog,
    welcomeByType,
  }
}
