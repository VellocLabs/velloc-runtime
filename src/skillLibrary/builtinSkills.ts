/**
 * Registry for skills shipped in the bundle, registered at module load with a
 * static `content` body or a `dynamicContent(args, context)` callback (kept in
 * a private map, since command metadata must stay serializable). Appended after
 * disk skills, so a disk skill with the same name wins.
 */

import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import type { WorkingState } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { HookTableByEvent } from '../lifecycleHooks/hookTypes'

// Feature registry: features are bundled-skill toggles, auto-registered by
// `addStockSkill` when the skill sets `default:`.

/** Feature id namespace for bundled skills. A skill named `foo` registered
 *  with a `default:` field auto-registers `bundled-skills.foo` so the
 *  WebUI Features page picks it up. The prefix is part of the public
 *  contract — the WebUI's bundled-skill detection (badge auto-derivation,
 *  catalog grouping) keys on it, and it lands in `~/.velloc/settings.json`
 *  user overrides. Do not change. */
export const BUNDLED_SKILL_FEATURE_PREFIX = 'bundled-skills.'

/** Bumped when the catalog's schema changes (new required fields, etc.).
 *  The WebUI's settings page uses this to invalidate its cached catalog.
 *  v2: added `modelInvocable` / `name` / `argumentHint` so the Features page
 *  can render model-invocable skills as toggles and slash-only skills as
 *  display-only rows. */
export const FEATURE_CATALOG_VERSION = '2'

/**
 * Definition of a togglable feature surfaced in the WebUI Features page
 * AND used as an `isEnabled` gate by its consumer (today, always a
 * bundled skill). Persisted user overrides live at
 * `~/.velloc/settings.json` keyed by `id` (e.g. `bundled-skills.simplify`).
 */
export type FeatureDefinition = {
  /** Stable namespaced id, e.g. `bundled-skills.tidy-memory`. Never changes
   *  once shipped; renaming a feature means a migration. */
  id: string
  /** Short human-readable title for the settings UI. */
  title: string
  /** One-paragraph description shown next to the toggle. */
  description: string
  /** State applied when the user hasn't explicitly toggled this feature.
   *  Lets you ship new features as on-by-default (or opt-in) per-feature. */
  default: boolean
  /** Optional grouping label for the settings UI (e.g. 'Bundled skills',
   *  'Experimental', 'Debug'). Plain string — the UI sorts by category. */
  category?: string
  /** Optional URL to docs / changelog for this feature. */
  docsUrl?: string
  /** When `true`, the WebUI shows a "🔄 restart required" hint next to
   *  the toggle. Consumers that bind their behavior at boot (e.g. choosing
   *  which tools to register) set this; consumers that re-evaluate every
   *  call (e.g. `isEnabled` callbacks on skills) leave it `false`. */
  requiresRestart?: boolean
  /** Session-type whitelist shown as badges on the Features page. For a
   *  `bundled-skills.<name>` feature it is derived from the skill at
   *  `getFeatureCatalog()` time; badges render only for `modelInvocable` rows. */
  sessionTypes?: readonly string[]
  /** Whether the linked bundled skill is model-invocable (the model can
   *  auto-invoke it via the Skill tool). Drives the Features page UX:
   *   - `true` / absent → render an enable/disable TOGGLE + session-type
   *     badges (enabling/disabling controls the model surface).
   *   - `false` → render a DISPLAY-ONLY row (no toggle, no badges); the skill
   *     is slash-only and always available via `/name`, so there is nothing
   *     to toggle. */
  modelInvocable?: boolean
  /** The bare skill name (`id` minus the `bundled-skills.` prefix), so the
   *  UI can show `/name` without re-parsing the id. */
  name?: string
  /** The skill's `argumentHint` (e.g. `<instruction>`), surfaced on
   *  display-only rows so users see how to call the slash command. */
  argumentHint?: string
}

const FEATURE_REGISTRY = new Map<string, FeatureDefinition>()

/**
 * Register a feature. Idempotent on `id` — re-registering replaces the
 * prior entry (matches "last write wins"). Throws on empty id.
 *
 * In practice, callers DON'T call this directly — `addStockSkill`
 * auto-calls it whenever a skill sets `default:`. Exposed for the rare
 * future case of a non-skill feature.
 */
export function registerFeature(definition: FeatureDefinition): void {
  if (!definition.id) {
    throw new Error('registerFeature: id is required')
  }
  FEATURE_REGISTRY.set(definition.id, { ...definition })
}

/**
 * Every registered feature, sorted by `id`. A `bundled-skills.<name>` feature
 * without explicit `sessionTypes` takes them from the linked skill's `type`.
 */
export function getFeatureCatalog(): readonly FeatureDefinition[] {
  return Array.from(FEATURE_REGISTRY.values())
    .map(def => {
      if (def.sessionTypes !== undefined) return def
      if (!def.id.startsWith(BUNDLED_SKILL_FEATURE_PREFIX)) return def
      const skillName = def.id.slice(BUNDLED_SKILL_FEATURE_PREFIX.length)
      const types = getBundledSkillModelInvocation(skillName)
      // `undefined` (every type) and `[]` (slash-only, so no model surface to
      // badge) both mean there is nothing to show.
      if (!types || types.length === 0) return def
      return { ...def, sessionTypes: types }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Look up a single feature definition. Useful for tests + diagnostic code. */
export function getFeatureDefinition(id: string): FeatureDefinition | undefined {
  return FEATURE_REGISTRY.get(id)
}

/**
 * Whether a feature is enabled: `appState.enabledFeatures`, else the registry
 * `default`. An unknown id returns `false` (fail safe). Cheap per turn.
 */
export function isFeatureEnabled(
  id: string,
  appState: WorkingState | undefined | null,
): boolean {
  const override = appState?.enabledFeatures?.[id]
  if (override !== undefined) return override
  const def = FEATURE_REGISTRY.get(id)
  return def?.default ?? false
}

/** Test-only — wipe the feature registry. */
export function __resetFeatureRegistryForTests(): void {
  FEATURE_REGISTRY.clear()
}

/** Default settings-UI category for bundled-skill features. Used when a
 *  `addStockSkill` call omits `featureCategory`. */
const DEFAULT_BUNDLED_SKILL_FEATURE_CATEGORY = 'Bundled skills'

/** Callback that produces a skill body at invocation time from
 *  `(args, context)`. Returns the FINAL prompt text —
 *  arg substitution etc. is the callback's responsibility (no further
 *  `$ARGUMENTS` pass runs over the result). */
export type BundledSkillDynamicContent = (
  args: string,
  context: ToolCallContext,
) => Promise<string>

/** Predicate evaluated at listing-time to decide whether a bundled skill
 *  should be visible in the command list.
 *  Receives the live `WorkingState`, so skills can gate on
 *  `isFeatureEnabled(id, appState)` (the recommended pattern) or any
 *  other AppState-derived condition. Returning `false` hides the skill —
 *  it doesn't appear in `getModelInvocableCommands`, can't be invoked,
 *  and doesn't show in the slash picker. Omit to leave the skill always
 *  enabled. */
export type BundledSkillIsEnabled = (appState: WorkingState) => boolean

/** A per-surface session-type gate as authored: `templateType` value(s), a
 *  comma string, or `'*'`. Omitted or `'*'` = every type; a list = those types
 *  only; `[]` (or `['']`) = this surface is disabled. */
export type SkillInvocationTypes = string | readonly string[]

/** A normalized {@link SkillInvocationTypes}, as the loader consumes it.
 *  `undefined` = every type; `[]` = disabled; a non-empty list = those
 *  types. Serializable, so it rides on `ChromiumCommandMetadata` across the
 *  worker bridge unchanged. */
export type NormalizedInvocation = readonly string[] | undefined

/**
 * Normalize an authored gate: entries trimmed, blanks dropped (`['']` → `[]`,
 * disabled); `'*'` anywhere → `undefined` (every type). `undefined` only for an
 * omitted field or a wildcard.
 */
export function normalizeInvocation(
  raw: SkillInvocationTypes | undefined,
): NormalizedInvocation {
  if (raw === undefined) return undefined
  const cleaned = (typeof raw === 'string' ? raw.split(',') : Array.from(raw))
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim())
    .filter(t => t.length > 0)
  if (cleaned.includes(INVOCATION_ALL)) return undefined
  // Freeze so consumers cannot mutate the cached membership list.
  return Object.freeze(cleaned)
}

/** The wildcard entry that widens a gate back to every session type. */
export const INVOCATION_ALL = '*'

/**
 * Whether `gate` admits `templateType`: `undefined` yes, `[]` never, a list iff
 * listed. A caller passing no session type is admitted.
 */
export function invocationAllows(
  gate: NormalizedInvocation,
  templateType: string | undefined,
): boolean {
  if (gate === undefined) return true
  if (gate.length === 0) return false
  if (!templateType) return true
  return gate.includes(templateType)
}

/**
 * Whether the session TYPE closed this gate (drop the skill: not available in
 * this session type), as opposed to an explicit `[]` (keep it: that surface is
 * off).
 */
export function invocationExcludedByType(
  gate: NormalizedInvocation,
  templateType: string | undefined,
): boolean {
  return (
    gate !== undefined
    && gate.length > 0
    && !!templateType
    && !gate.includes(templateType)
  )
}

/**
 * Bundled-skill definition. Subset of `ChromiumCommandMetadata` for the
 * fields a register-from-code site would care to set — everything else
 * defaults sensibly. Provide EITHER `content` (static body, runs through
 * the standard `buildSkillBody` substitution pipeline) OR `dynamicContent`
 * (callback computes the final body at invocation time).
 */
export type StockSkillSpec = {
  name: string
  description: string
  /** Static body. `$ARGUMENTS` / `$1` / named-arg substitution still
   *  happens via `buildSkillBody`. Mutually exclusive with
   *  `dynamicContent` — set one or the other. */
  content?: string
  /** Dynamic body callback. Returns the FINAL prompt; bypasses the
   *  `$ARGUMENTS` substitution pass. Used by skills that need to read
   *  runtime state (e.g. `/debug` tails the worker log buffer). Mutually
   *  exclusive with `content`. */
  dynamicContent?: BundledSkillDynamicContent
  useWhen?: string
  argumentHint?: string
  argNames?: string[]
  permittedTools?: string[]
  model?: string
  /**
   * Which session types the MODEL may auto-invoke this skill in, via the
   * Skill tool. Omit for every type; `[]` for a slash-only skill.
   * See {@link SkillInvocationTypes} for the full tri-state.
   */
  modelInvocation?: SkillInvocationTypes
  /**
   * Session types where the USER may invoke this skill via `/<name>`; omit for
   * every type, `[]` for model-only. Closed on both surfaces by type, the skill
   * is absent from that session entirely.
   */
  userInvocation?: SkillInvocationTypes
  /** Default `false`. `true` keeps `/<name>` working when typed but leaves
   *  the skill out of the composer's slash picker — the hidden command style
   *  (see `ChromiumPromptCommand.hiddenFromPicker`). Meaningless together
   *  with `userInvocation: []`. */
  hiddenFromPicker?: boolean
  hooks?: HookTableByEvent
  context?: 'inline' | 'fork'
  agent?: string
  effort?: string
  /** Optional predicate evaluated by `loadLocalPromptCommands` to decide
   *  whether to surface this skill. Provide this to bind to a CUSTOM
   *  condition (e.g. "off in headless mode"). Most bundled skills don't
   *  need this — setting `default` (below) auto-wires a feature-flag
   *  callback that reads the user's settings.json toggle. */
  isEnabled?: BundledSkillIsEnabled
  /**
   * Features-page toggle: `true` on by default, `false` opt-in; omitted = always
   * on, no toggle. Setting it registers a `bundled-skills.<name>` feature and
   * wires `isEnabled`.
   */
  default?: boolean
  /** WebUI title for the feature toggle. Falls back to `name` when
   *  omitted. Has no effect unless `default` is also set. */
  featureTitle?: string
  /** WebUI description for the feature toggle. Falls back to
   *  `description` when omitted — so by default the skill's model-facing
   *  description doubles as the user-facing settings copy. Override when
   *  the audiences need different wording (e.g. user docs mention the
   *  `/<name>` slash command explicitly). Has no effect unless `default`
   *  is also set. */
  featureDescription?: string
  /** Settings-UI grouping label. Falls back to `'Bundled skills'`. Has
   *  no effect unless `default` is also set. */
  featureCategory?: string
  /** When `true`, the WebUI shows a "🔄 restart required" hint next to
   *  the toggle. Set for features that bind at session boot (so a flip
   *  only takes effect on the next session). Has no effect unless
   *  `default` is also set. */
  requiresRestart?: boolean
  /** Optional docs URL surfaced on the toggle. Has no effect unless
   *  `default` is also set. */
  docsUrl?: string
  /**
   * Tool names the skill's body cannot run without. Not a runtime gate: data the
   * invocation gates must agree with, checked per bundled type by a unit test.
   * Read via `getBundledSkillRequiredTools`.
   */
  requiredTools?: readonly string[]
  /**
   * Test-fixture flag: the skill is dropped from every command list unless the
   * runtime is under the e2e trace flag (`?e2eTrace=1`). Real skills never set
   * it.
   */
  e2eOnly?: boolean
}

const REGISTRY = new Map<string, ChromiumCommandMetadata>()
const DYNAMIC_CONTENT = new Map<string, BundledSkillDynamicContent>()
const IS_ENABLED = new Map<string, BundledSkillIsEnabled>()
/** Parallel to `REGISTRY` — the normalized MODEL gate. A name absent from
 *  this map has no restriction at all; a name mapped to `[]` is disabled.
 *  (The same tri-state also rides on the command itself; this map is what
 *  `getBundledSkillModelInvocation` serves to the Features catalog, which
 *  reads the registry rather than a loaded session's command list.) */
const MODEL_INVOCATION = new Map<string, readonly string[]>()
/** Parallel to `REGISTRY` — the tools a skill's body cannot run without.
 *  Absent when the skill declared none. See `StockSkillSpec.requiredTools`. */
const REQUIRED_TOOLS = new Map<string, readonly string[]>()
/** Names of skills registered with `e2eOnly: true` — the loader keeps them
 *  out of every non-e2e command list. See `StockSkillSpec.e2eOnly`. */
const E2E_ONLY = new Set<string>()

/**
 * Register a bundled skill; re-registering a name replaces it. Call from a
 * `registerXyzSkill()` wired into `installStockSkills`.
 */
export function addStockSkill(definition: StockSkillSpec): void {
  // Use `=== undefined` (not falsiness) so a deliberately empty static
  // `content: ''` is allowed — the rare case where an author wants a
  // no-body skill is still legitimate and shouldn't trip this guard.
  if (definition.content === undefined && definition.dynamicContent === undefined) {
    throw new Error(
      `addStockSkill: '${definition.name}' must set either content or dynamicContent`,
    )
  }
  if (definition.content !== undefined && definition.dynamicContent !== undefined) {
    throw new Error(
      `addStockSkill: '${definition.name}' must set ONLY ONE of content or dynamicContent, not both`,
    )
  }
  // Invocation kind drives the Features-page treatment (see the feature
  // registration below). Computed once, reused by the typo-guard + registration.
  // "Model-invocable" here means "in at least one session type" — a gate
  // narrowed to specific types still earns a toggle; only `[]` forfeits it.
  const modelGate = normalizeInvocation(definition.modelInvocation)
  const userGate = normalizeInvocation(definition.userInvocation)
  const modelInvocable = modelGate === undefined || modelGate.length > 0
  const userVisible = userGate === undefined || userGate.length > 0

  // Catch the most common typo: a MODEL-INVOCABLE skill setting feature-UI
  // fields without `default`. Model-invocable skills need `default` to get a
  // toggle; without it those fields would be silently ignored (almost
  // certainly an author bug — forgot `default`, or typed `defualt`). Slash-only
  // skills register a display-only row regardless of `default`, so the guard
  // doesn't apply to them.
  if (
    modelInvocable
    && definition.default === undefined
    && (definition.featureTitle !== undefined
      || definition.featureDescription !== undefined
      || definition.featureCategory !== undefined
      || definition.requiresRestart !== undefined
      || definition.docsUrl !== undefined)
  ) {
    throw new Error(
      `addStockSkill: '${definition.name}' sets feature-UI fields (featureTitle / featureDescription / featureCategory / requiresRestart / docsUrl) but no \`default\`. Set \`default: true|false\` to make the skill user-toggleable, or remove the unused feature fields.`,
    )
  }

  REGISTRY.set(definition.name, toCommand(definition))
  if (definition.dynamicContent) {
    DYNAMIC_CONTENT.set(definition.name, definition.dynamicContent)
  } else {
    DYNAMIC_CONTENT.delete(definition.name)
  }
  if (modelGate) {
    MODEL_INVOCATION.set(definition.name, modelGate)
  } else {
    MODEL_INVOCATION.delete(definition.name)
  }
  if (definition.e2eOnly) {
    E2E_ONLY.add(definition.name)
  } else {
    E2E_ONLY.delete(definition.name)
  }
  const requiredTools = definition.requiredTools
    ?.map(t => t.trim())
    .filter(t => t.length > 0)
  if (requiredTools && requiredTools.length > 0) {
    REQUIRED_TOOLS.set(definition.name, Object.freeze([...requiredTools]))
  } else {
    REQUIRED_TOOLS.delete(definition.name)
  }

  // Model-invocable skills get a real toggle feature (when `default` is set) and
  // type badges; slash-only skills get a display-only feature.
  const featureId = BUNDLED_SKILL_FEATURE_PREFIX + definition.name
  let isEnabled = definition.isEnabled
  if (modelInvocable && definition.default !== undefined) {
    registerFeature({
      id: featureId,
      title: definition.featureTitle ?? definition.name,
      description: definition.featureDescription ?? definition.description,
      default: definition.default,
      category: definition.featureCategory
        ?? DEFAULT_BUNDLED_SKILL_FEATURE_CATEGORY,
      modelInvocable: true,
      name: definition.name,
      ...(definition.argumentHint !== undefined
        ? { argumentHint: definition.argumentHint }
        : {}),
      ...(definition.requiresRestart !== undefined
        ? { requiresRestart: definition.requiresRestart }
        : {}),
      ...(definition.docsUrl !== undefined
        ? { docsUrl: definition.docsUrl }
        : {}),
    })
    // Author-supplied callback wins. Otherwise auto-wire a predicate that
    // reads the feature flag — the toggle gates the model surface.
    if (!isEnabled) {
      isEnabled = appState => isFeatureEnabled(featureId, appState)
    }
  } else if (!modelInvocable && userVisible) {
    // Display-only: shown but never gated (always available via `/name`). Do
    // NOT auto-wire `isEnabled` — a row the user can't toggle must not hide the
    // skill behind a flag.
    registerFeature({
      id: featureId,
      title: definition.featureTitle ?? definition.name,
      description: definition.featureDescription ?? definition.description,
      default: definition.default ?? true,
      category: definition.featureCategory
        ?? DEFAULT_BUNDLED_SKILL_FEATURE_CATEGORY,
      modelInvocable: false,
      name: definition.name,
      ...(definition.argumentHint !== undefined
        ? { argumentHint: definition.argumentHint }
        : {}),
      ...(definition.docsUrl !== undefined
        ? { docsUrl: definition.docsUrl }
        : {}),
    })
  }
  if (isEnabled) {
    IS_ENABLED.set(definition.name, isEnabled)
  } else {
    IS_ENABLED.delete(definition.name)
  }
}

/** Prefix of every bundled skill's synthetic `path` (`bundled:<name>`).
 *  There is no on-disk file behind such a path — consumers that render a
 *  skill body (the Right Panel Skills tab) must detect it via
 *  {@link isBundledSkillPath} and fetch the body from the worker registry
 *  (`worker.getSkillBody`) instead of the fs bridge. */
export const BUNDLED_SKILL_PATH_PREFIX = 'bundled:'

/** Is `path` a bundled skill's synthetic path (no on-disk file)? */
export function isBundledSkillPath(path: string): boolean {
  return path.startsWith(BUNDLED_SKILL_PATH_PREFIX)
}

function toCommand(d: StockSkillSpec): ChromiumCommandMetadata {
  const modelInvocation = normalizeInvocation(d.modelInvocation)
  const userInvocation = normalizeInvocation(d.userInvocation)
  return {
    type: 'prompt',
    name: d.name,
    description: d.description,
    // Dynamic-body skills stash an empty string for `content` — the live
    // body comes from the callback at invocation time. The placeholder is
    // never sent to the model: the skill-invocation path replaces it before
    // `buildSkillBody` ever sees it.
    content: d.content ?? '',
    // Synthetic path — there is no on-disk file. `buildSkillBody` reads
    // `baseDir` (not `path`) for the "Base directory for this skill: …"
    // prefix, so leaving `baseDir` undefined cleanly skips that header.
    path: `${BUNDLED_SKILL_PATH_PREFIX}${d.name}`,
    useWhen: d.useWhen,
    argumentHint: d.argumentHint,
    argNames: d.argNames,
    permittedTools: d.permittedTools,
    model: d.model,
    // The booleans are the "no session type known" resolution — what a caller
    // that never runs the loader (a test, the Skills panel) sees. The loader
    // overwrites both from the gates below, per session type.
    hiddenFromModel: modelInvocation?.length === 0,
    userCallable: userInvocation?.length !== 0,
    ...(d.hiddenFromPicker ? { hiddenFromPicker: true } : {}),
    ...(modelInvocation ? { modelInvocation: [...modelInvocation] } : {}),
    ...(userInvocation ? { userInvocation: [...userInvocation] } : {}),
    source: 'bundled',
    loadedFrom: 'bundled',
    hooks: d.hooks,
    context: d.context,
    agent: d.agent,
    effort: d.effort,
  }
}

/**
 * Snapshot of every registered bundled skill, as `ChromiumCommandMetadata`
 * entries ready to merge into the command list. Order is registration order
 * (`Map` insertion-ordered).
 */
export function getBundledSkillCommands(): ChromiumCommandMetadata[] {
  return Array.from(REGISTRY.values())
}

/**
 * One registered bundled skill's command entry, or `undefined` when no
 * bundled skill of that name exists. Consumed by `resolveBundledSkillBody`
 * (the Skills-tab body lookup) — a static skill's displayable body is the
 * entry's `content`.
 */
export function getBundledSkillCommand(
  name: string,
): ChromiumCommandMetadata | undefined {
  return REGISTRY.get(name)
}

/**
 * The dynamic-content callback for a bundled skill, or `undefined` if the
 * skill ships a static body (or isn't a bundled skill at all). Consumed by
 * `SkillRunTool.call` and `dispatchSkillSlashCommand` to compute the live body
 * before `buildSkillBody` runs. The callback is stashed in a parallel map
 * rather than on the command because `ChromiumCommandMetadata` is
 * data-only / serializable across the worker bridge.
 */
export function getBundledSkillDynamicContent(
  name: string,
): BundledSkillDynamicContent | undefined {
  return DYNAMIC_CONTENT.get(name)
}

/**
 * The `isEnabled` predicate for a bundled skill, or `undefined` when the
 * skill ships with no gate (always enabled). Consumed by
 * `loadLocalPromptCommands` to filter the merged command list before the
 * model-invocable / slash-picker views are built.
 */
export function getBundledSkillIsEnabled(
  name: string,
): BundledSkillIsEnabled | undefined {
  return IS_ENABLED.get(name)
}

/**
 * The normalized MODEL-invocation gate for a bundled skill: `undefined` for
 * every session type, `[]` for a slash-only skill, otherwise the whitelisted
 * types. Returned array is frozen — do not mutate. Consumed by the Features
 * catalog, which reads the registry directly rather than a loaded session's
 * command list.
 */
export function getBundledSkillModelInvocation(
  name: string,
): NormalizedInvocation {
  return MODEL_INVOCATION.get(name)
}

/**
 * The tools a bundled skill's body cannot run without (frozen), or
 * `undefined` when it declared none. See `StockSkillSpec.requiredTools`.
 */
export function getBundledSkillRequiredTools(
  name: string,
): readonly string[] | undefined {
  return REQUIRED_TOOLS.get(name)
}

/**
 * Convenience: may the MODEL auto-invoke this bundled skill in a session of
 * `templateType`? The registry-side counterpart of the resolved
 * `hiddenFromModel` boolean the loader stamps onto a command, for
 * callers (the Features catalog, tests) holding only a name.
 */
export function isBundledSkillModelInvocableIn(
  name: string,
  templateType: string | undefined,
): boolean {
  return invocationAllows(MODEL_INVOCATION.get(name), templateType)
}

/**
 * Is this bundled skill an e2e-only fixture (registered with `e2eOnly: true`)?
 * `loadLocalPromptCommands` consults this to keep the skill out of every
 * command list unless the runtime is under the e2e trace flag. Unknown /
 * non-bundled names return `false`. See `StockSkillSpec.e2eOnly`.
 */
export function isBundledSkillE2eOnly(name: string): boolean {
  return E2E_ONLY.has(name)
}

/** Test-only — wipe the registry between tests so registrations don't leak. */
export function __resetBundledSkillsForTests(): void {
  REGISTRY.clear()
  DYNAMIC_CONTENT.clear()
  IS_ENABLED.clear()
  MODEL_INVOCATION.clear()
  REQUIRED_TOOLS.clear()
  E2E_ONLY.clear()
}
