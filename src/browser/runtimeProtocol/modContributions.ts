/**
 * The `mods/contributions` topic and `mods.pressTopbar` — what the person's
 * plugins add to the launcher list and the topbar (F-25). Read from plugin
 * manifests by the runtime; no mod code runs to fill it. Snapshot and every
 * `state` delta carry the whole state.
 */
import type { TopicId } from './frames'

export const MODS_CONTRIBUTIONS_TOPIC: TopicId = 'mods/contributions'
/** The event `type` of the snapshot and every delta. */
export const MODS_CONTRIBUTIONS_EVENT = 'state'

/** A plugin's own text: one string, or one per locale tag. */
export type ContributionText = string | { readonly [locale: string]: string }

/**
 * An icon. `ref` / `dark` name an entry of `ModContributionsState.icons`
 * (checked SVG text, keyed by content hash); `mask` draws its shape in the
 * text colour. `lucide` names an icon of Velloc's own set.
 */
export type ContributionIcon =
  | { ref: string; dark?: string; mask?: true }
  | { lucide: string }

export type ContributionWelcome = {
  greeting?: string
  subtitle?: string
  suggestions: Array<{ title: string; description?: string; prompt?: string }>
}

export type ContributedTemplate = {
  /** `<plugin>:<key>` — the session's `templateType`. */
  type: string
  plugin: string
  /** The install identifier that offers it (`<name>@<catalog>`, `<name>@inline`). */
  owner: string
  title: ContributionText
  description?: ContributionText
  icon?: ContributionIcon
  launcher: 'both' | 'sidebar' | 'menu' | 'hidden'
  /** `required`: the session must be bound to a project folder, as `code`. */
  projectFolder?: 'required'
  /** Welcome chips by locale (`''` = the default file). */
  welcome?: Record<string, ContributionWelcome>
}

export type ContributedTopbarItem = {
  /** `<plugin>:<key>`; what a press runs is the runtime's to decide. */
  id: string
  plugin: string
  title: ContributionText
  icon?: ContributionIcon
}

/** A plugin the person switched on whose `requires` is not met. */
export type WaitingPlugin = {
  plugin: string
  owner: string
  /** The providers to set up first, by id; a word this Velloc does not know
   *  is listed in `unknown`. */
  providers: Array<{ id?: string; key: string }>
  unknown?: string[]
}

export type ModContributionsState = {
  templates: ContributedTemplate[]
  topbar: ContributedTopbarItem[]
  /** Content hash → SVG text: one copy of each icon however often it is used. */
  icons: Record<string, string>
  waiting: WaitingPlugin[]
}

export const EMPTY_MOD_CONTRIBUTIONS: ModContributionsState = Object.freeze({
  templates: [],
  topbar: [],
  icons: {},
  waiting: [],
}) as ModContributionsState

export type ModsPressTopbarPayload = { sessionId: string; id: string }
export type ModsPressTopbarResult =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'waiting' | 'no-session' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function isModsPressTopbarPayload(value: unknown): value is ModsPressTopbarPayload {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    value.sessionId !== '' &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    value.id.length <= 200
  )
}
