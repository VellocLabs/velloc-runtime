// Per-skill tool gating (progressive disclosure): a deferred unit's tools are
// omitted from tools[] until activated (Skill('<name>') / ToolSearch), uniformly
// across providers. Defaults come from the session template's `deferredTools`.
// The registry is per-runtime, keyed by RuntimeConfig identity.

import type {
  WorkingState,
  InvokedSkillsAttachment,
  Message,
} from '../../runtime/RuntimeTypes'
import { MSG_TYPE_ATTACHMENT } from '../../runtime/VercelModelConstants'
import type { ToolContract } from '../toolContract'

// ── per-RUNTIME deferral registries (keyed by RuntimeConfig identity) ──────
/** A deferrable UNIT (a skill or a tool group) + whether it defaults to
 *  deferred (hidden). `toolNames` is present for GROUP units (the gate matches
 *  their tools by name); omit it for SKILL units (matched by `tool.skill`).
 *  `sealed` marks the stronger tier (template `sealedTools`): the unit's tools
 *  are registered but can NEVER be surfaced or activated — not listed in
 *  ToolSearch's catalog, refused by `activateSkills`, permanently hidden. */
export type DeferrableSkill = {
  name: string
  defaultDeferred: boolean
  toolNames?: readonly string[]
  sealed?: boolean
}

// One registry per runtime: every runtime shares one SharedWorker realm, so a
// module-global registry would let a new session replace a sibling's config.
type DeferralRegistry = {
  // `defaultDeferred` per registered deferral UNIT (a skill OR a tool group) —
  // whether its tools defer by default. The session template's `deferredTools`
  // is the SOLE source; there is NO per-skill override switch.
  skillDefaults: Map<string, boolean>
  // Units registered as SEALED (template `sealedTools`) — a subset of the
  // deferred units that can never activate.
  sealedUnits: Set<string>
  // Tools that belong to a GROUP unit (group tools have no `tool.skill`, so
  // the gate matches them by name): tool name → owning group-unit name.
  groupToolUnits: Map<string, string>
}

const EMPTY_REGISTRY: DeferralRegistry = {
  skillDefaults: new Map(),
  sealedUnits: new Set(),
  groupToolUnits: new Map(),
}

/** Per-runtime registries, keyed by RuntimeConfig identity (WeakMap — dies
 *  with the runtime). */
const keyedRegistries = new WeakMap<object, DeferralRegistry>()
/** The KEYLESS slot: the most recent registration. Served ONLY to keyless
 *  reads — (a) tests that register without a key, and (b) the synchronous
 *  construction-time window in `createAgentRuntime` where tool `isEnabled()`
 *  (ToolSearch's `isAnySkillDeferred`) runs with no context, immediately
 *  after that runtime's own registration (no await between them, so a
 *  sibling cannot interleave). Every PER-TURN read passes its runtime's key
 *  and never touches this slot. */
let lastRegistry: DeferralRegistry = EMPTY_REGISTRY

/** The opaque per-runtime identity the deferral registry is keyed by. */
export type DeferralKey = object | undefined

/** Resolve the deferral key from a tool-use-context-shaped object — its
 *  `options.runtimeConfig` (per-runtime, shared by reference; absent in test
 *  contexts that don't set it → keyless slot). */
export function deferralKeyFromContext(
  context: { options?: { runtimeConfig?: unknown } } | undefined,
): DeferralKey {
  const rc = context?.options?.runtimeConfig
  return typeof rc === 'object' && rc !== null ? (rc as object) : undefined
}

/** The registry a read resolves against: the caller's keyed registry, or the
 *  keyless slot when no key is supplied. A keyed MISS returns the empty
 *  registry — never a sibling's (fail-open: nothing deferred, tools visible),
 *  because falling back to the last writer is exactly the cross-session bug
 *  this keying removes. */
function registryFor(key?: DeferralKey): DeferralRegistry {
  if (key) return keyedRegistries.get(key) ?? EMPTY_REGISTRY
  return lastRegistry
}

/**
 * Register the deferrable UNITS + their defaults (a unit with `toolNames` is a
 * GROUP, without is a SKILL). Replaces wholesale for THIS key only; keyless
 * registration serves tests.
 */
export function registerDeferrableSkills(
  skills: Iterable<DeferrableSkill>,
  key?: DeferralKey,
): void {
  const list = [...skills]
  const registry: DeferralRegistry = {
    skillDefaults: new Map(list.map((s) => [s.name, s.defaultDeferred])),
    sealedUnits: new Set(list.filter((s) => s.sealed).map((s) => s.name)),
    groupToolUnits: new Map(),
  }
  for (const s of list) {
    if (s.toolNames) {
      for (const tool of s.toolNames) registry.groupToolUnits.set(tool, s.name)
    }
  }
  if (key) keyedRegistries.set(key, registry)
  // The keyless slot always tracks the most recent registration — it backs
  // the synchronous construction-time reads (see its doc above). Per-turn
  // reads are keyed and unaffected.
  lastRegistry = registry
}

// ── tools an extension registers while the session runs (F-25) ─────────────
/** Per-runtime: each extension-registered tool is a one-tool group unit named
 *  after the tool; the value says whether it asked to wait behind ToolSearch.
 *  Kept apart from the template registry, which is replaced wholesale. */
const keyedExtensionUnits = new WeakMap<object, ReadonlyMap<string, boolean>>()
let lastExtensionUnits: ReadonlyMap<string, boolean> = new Map()

/** Replaces the extension-registered tool units for THIS key: tool name →
 *  deferred. `loaderTools` is the loop's tool list: a unit waits only when
 *  that list holds ToolSearch, since nothing else could load it. */
export function registerExtensionToolUnits(
  units: ReadonlyMap<string, boolean>,
  key?: DeferralKey,
  loaderTools?: readonly { name: string }[],
): void {
  const offersLoader = loaderTools === undefined || loaderTools.some(tool => tool.name === DEFERRED_TOOL_FINDER)
  const copy = new Map([...units].map(([name, deferred]) => [name, deferred && offersLoader]))
  if (key) keyedExtensionUnits.set(key, copy)
  lastExtensionUnits = copy
}

function extensionUnitsFor(key?: DeferralKey): ReadonlyMap<string, boolean> {
  if (key) return keyedExtensionUnits.get(key) ?? EMPTY_EXTENSION_UNITS
  return lastExtensionUnits
}

const EMPTY_EXTENSION_UNITS: ReadonlyMap<string, boolean> = new Map()

/** Whether a tool name is an extension-registered unit for THIS key. */
export function isExtensionToolUnit(toolName: string, key?: DeferralKey): boolean {
  return extensionUnitsFor(key).has(toolName)
}

/** The group-unit a tool belongs to (for tools with no `tool.skill`), if any. */
export function groupUnitForTool(
  toolName: string,
  key?: DeferralKey,
): string | undefined {
  return (
    registryFor(key).groupToolUnits.get(toolName) ??
    (extensionUnitsFor(key).has(toolName) ? toolName : undefined)
  )
}

/**
 * Whether a unit's switch is currently ON — its tools are deferred (hidden
 * until activated). Decided by the template-derived default; an
 * extension-registered tool waits only while ToolSearch is offered, since
 * nothing else could load it.
 */
export function isSkillDeferred(
  unitName: string | undefined,
  key?: DeferralKey,
): boolean {
  if (!unitName) return false
  const templateDefault = registryFor(key).skillDefaults.get(unitName)
  if (templateDefault !== undefined) return templateDefault
  return extensionUnitsFor(key).get(unitName) === true && isAnySkillDeferred(key)
}

/**
 * Whether a unit is SEALED — registered in the runtime set for internal
 * dispatchers, but permanently invisible: never in ToolSearch's catalog,
 * never activatable, always hidden from the model. The hard tier above
 * plain deferral.
 */
export function isSkillSealed(
  unitName: string | undefined,
  key?: DeferralKey,
): boolean {
  return !!unitName && registryFor(key).sealedUnits.has(unitName)
}

/**
 * Whether a skill name is a registered deferrable skill — i.e. activatable
 * via Skill/ToolSearch and subject to the per-skill switch. (ToolSearch +
 * the resume derivation use this to know a skill is gateable; only
 * `isSkillDeferred` / `shouldHideToolFromModel` decide if it's hidden NOW.)
 */
export function isDeferredSkill(
  skillName: string | undefined,
  key?: DeferralKey,
): boolean {
  return !!skillName && (registryFor(key).skillDefaults.has(skillName) || extensionUnitsFor(key).has(skillName))
}

/** The registered deferrable-skill names (read-only view). */
export function getDeferrableSkills(key?: DeferralKey): ReadonlySet<string> {
  return new Set(registryFor(key).skillDefaults.keys())
}

/** Whether ANY registered skill currently has its switch on (deferred).
 *  Used to decide if ToolSearch is worth surfacing (no hidden tools → no
 *  point). SEALED units don't count: their tools can never be surfaced, so
 *  they alone give ToolSearch nothing to load — a session whose only hidden
 *  unit is sealed correctly drops ToolSearch. */
export function isAnySkillDeferred(key?: DeferralKey): boolean {
  for (const name of registryFor(key).skillDefaults.keys()) {
    if (isSkillDeferred(name, key) && !isSkillSealed(name, key)) return true
  }
  return false
}

// ── per-session active-skill state (appState) ──────────────────────
/** Skills activated this session (from the JSONL-friendly array). */
export function getActiveSkills(appState: WorkingState | undefined): Set<string> {
  const names = appState?.activeSkills
  return new Set(Array.isArray(names) ? names : [])
}

/** Whether a specific skill has been activated this session. */
export function isSkillActive(
  appState: WorkingState | undefined,
  skillName: string,
): boolean {
  return getActiveSkills(appState).has(skillName)
}

/**
 * The decision the serializer and the dispatch guard share: hide this
 * tool from the model right now? True when the tool's skill switch is ON
 * (deferred) and that skill is not yet active this session.
 */
export function shouldHideToolFromModel(
  tool: Pick<ToolContract, 'name' | 'skill'>,
  appState: WorkingState | undefined,
  key?: DeferralKey,
): boolean {
  // Owning deferral units: the tool's skill, plus its group-unit (group tools
  // carry no `tool.skill`, so they're matched by name). Hidden unless one of
  // its owning DEFERRED units has been activated this session. A SEALED unit
  // never counts as active — even a (buggy or transcript-derived) entry in
  // `activeSkills` cannot surface a sealed unit's tools.
  const units = [tool.skill, groupUnitForTool(tool.name, key)].filter(
    (u): u is string => isSkillDeferred(u, key),
  )
  if (units.length === 0) return false
  return units.every((u) => isSkillSealed(u, key) || !isSkillActive(appState, u))
}

/**
 * The recoverable tool-result text for a call to a hidden tool. The hint names a
 * route that actually surfaces it: `Skill('<skill>')` or ToolSearch `select:` for a
 * skill, `select:` only for a group, and none when every owning unit is sealed.
 */
export function hiddenToolCallMessage(
  tool: Pick<ToolContract, 'name' | 'skill'>,
  key?: DeferralKey,
): string {
  const name = tool.name
  const skill = tool.skill
  const group = groupUnitForTool(name, key)
  const activatable = (unit: string | undefined): unit is string =>
    isSkillDeferred(unit, key) && !isSkillSealed(unit, key)
  const selectable = !isSkillSealed(skill, key) && !isSkillSealed(group, key)
  if (activatable(skill)) {
    const viaToolSearch = selectable ? ` (or ToolSearch "select:${name}")` : ''
    return (
      `Tool "${name}" belongs to the "${skill}" skill, which is not ` +
      `active yet, so its parameter schema is not loaded. Activate it first — ` +
      `call Skill with skill "${skill}"${viaToolSearch}, ` +
      `then call "${name}" again.`
    )
  }
  if (activatable(group) && selectable) {
    return (
      `Tool "${name}" belongs to the "${group}" tool group, which is not ` +
      `active yet, so its parameter schema is not loaded. Load it first — ` +
      `call ToolSearch "select:${name}", then call "${name}" again.`
    )
  }
  return (
    `Tool "${name}" is not available in this session type. It cannot be ` +
    `loaded or activated — neither Skill nor ToolSearch can surface it — so ` +
    `do not call it again; use the tools you already have instead.`
  )
}

/**
 * `appState` with `activeSkills` augmented from transcript activations. Both
 * deferral gates (tool visibility and the dispatch guard) MUST use this, not the
 * raw `getAppState()`, so a resumed session keeps its activated tools.
 */
export function augmentedAppStateForDeferral(context: {
  readAppState: () => WorkingState | undefined
  messages?: readonly Message[]
  options: {
    tools: ReadonlyArray<Pick<ToolContract, 'name' | 'skill'>>
    runtimeConfig?: unknown
  }
}): WorkingState | undefined {
  const base = context.readAppState()
  // Resolve against the CALLER's runtime registry (options.runtimeConfig) —
  // never the last-registered sibling's.
  const key = deferralKeyFromContext(context)
  if (!isAnySkillDeferred(key)) return base // nothing gated → gate is a no-op
  const messages = Array.isArray(context.messages) ? context.messages : []
  if (messages.length === 0) return base
  const derived = deriveActivatedSkillsFromMessages(
    messages,
    name => context.options.tools.find(t => t.name === name)?.skill,
    key,
  )
  if (derived.length === 0) return base
  const existing = Array.isArray(base?.activeSkills) ? base!.activeSkills : []
  const merged = [...new Set([...existing, ...derived])]
  if (merged.length === existing.length) return base // nothing new
  return { ...(base as WorkingState), activeSkills: merged }
}

/**
 * Additively mark skills as active for the rest of the session.
 * Idempotent, order-preserving, de-duped. Activation is sticky (never
 * removed) so a skill's tools only re-enter tools[] once — bounding
 * prompt-cache churn to one miss per activated skill.
 *
 * Call from a trigger's `call()` with the tool context's `setAppState`.
 */
export function activateSkills(
  writeAppState: (f: (prev: WorkingState) => WorkingState) => void,
  skillNames: readonly string[],
  key?: DeferralKey,
): void {
  // Sealed units are not activatable — filtered here as defense in depth, on
  // top of ToolSearch/Skill excluding them from their surfaces. (Even if a
  // sealed name slipped through, `shouldHideToolFromModel` ignores activation
  // for sealed units — three independent layers.)
  skillNames = skillNames.filter(name => !isSkillSealed(name, key))
  if (skillNames.length === 0) return
  writeAppState(prev => {
    const existing = Array.isArray(prev.activeSkills) ? prev.activeSkills : []
    const merged = [...existing]
    for (const name of skillNames) {
      if (!merged.includes(name)) merged.push(name)
    }
    if (merged.length === existing.length) return prev
    return { ...prev, activeSkills: merged }
  })
}

// ── resume rehydration (transcript-derived gate) ───────────────────
//
// Tool names inlined as literals (= the `name` fields in toolkit/builtin/skill.ts and
// tools/toolSearch/) to avoid a deferredTools ⇄ {SkillRunTool,toolSearch}
// import cycle — both of those import `activateSkills` from this module.
const DEFERRED_SKILL_RUNNER = 'Skill'
const DEFERRED_TOOL_FINDER = 'ToolSearch'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Tool names a `ToolSearch` call brought online via its `select:` form
 * (`select:Name` or `select:A,B,C`). The keyword form lists matches only in the
 * RESULT (a separate tool-result message), so it is not covered here — but the
 * model reaches a known skill's tools via `select:` (the discovery reminder
 * names the exact `a2ui_*` tools), which is the path that matters for resume.
 */
function toolSearchSelectedNames(query: unknown): string[] {
  if (typeof query !== 'string') return []
  const m = query.match(/^\s*select:(.+)$/is)
  if (!m) return []
  return m[1]!
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * Skills activated earlier in the conversation, from three transcript signals:
 * `Skill('<name>')` calls, `ToolSearch` `select:<tool>` calls (via
 * `resolveToolSkill`), and `invoked_skills` attachments. Not filtered to deferred
 * skills.
 */
export function deriveActivatedSkillsFromMessages(
  messages: readonly Message[],
  resolveToolSkill?: (toolName: string) => string | undefined,
  key?: DeferralKey,
): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    // (1)+(2) Skill / ToolSearch tool-calls in assistant turns.
    if (message.type === 'assistant') {
      const content = asRecord(message.message)?.content
      if (Array.isArray(content)) {
        for (const part of content) {
          const record = asRecord(part)
          if (!record || record.type !== 'tool-call') continue
          const toolName =
            typeof record.toolName === 'string'
              ? record.toolName
              : typeof record.name === 'string'
                ? record.name
                : undefined
          const args = asRecord(record.args) ?? asRecord(record.input) ?? {}
          if (toolName === DEFERRED_SKILL_RUNNER) {
            const skill =
              typeof args.skill === 'string' ? args.skill.trim() : ''
            if (skill) names.add(skill)
          } else if (toolName === DEFERRED_TOOL_FINDER) {
            for (const loaded of toolSearchSelectedNames(args.query)) {
              // The loaded tool's owning unit: its skill (resolveToolSkill) or
              // its group-unit (group tools have no skill).
              const unit = resolveToolSkill?.(loaded) ?? groupUnitForTool(loaded, key)
              if (unit) names.add(unit)
            }
          }
        }
      }
    }
    // (3) invoked_skills attachments (survive compaction).
    if (message.type === MSG_TYPE_ATTACHMENT) {
      const attachment = asRecord(
        (message as { attachment?: unknown }).attachment,
      )
      if (attachment && attachment.type === 'invoked_skills') {
        const skills = (attachment as unknown as InvokedSkillsAttachment).skills
        if (Array.isArray(skills)) {
          for (const skill of skills) {
            if (skill && typeof skill.name === 'string' && skill.name) {
              names.add(skill.name)
            }
          }
        }
      }
    }
  }
  return [...names]
}
