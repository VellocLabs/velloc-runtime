// The template catalog: what a page shows about the session types — the
// launcher list (titles, icons) and each type's welcome page. Backed by
// `virtual:bundled-template-catalog`, which carries only these, so the shell
// does not ship the template bodies; `templateRegistry.ts` owns those and
// re-exports these getters. Plugin types' launchers come from the runtime
// (`mods/contributions`), not from here.
import { createBundledCatalog } from 'virtual:bundled-template-catalog'
import type { LauncherMeta, WelcomeContent } from './templateParsing'
import {
  currentTemplateChannel,
  type UpdateChannel,
} from '../branding/updateChannels'

const { launcherCatalog, launcherByType, betaLauncherCatalog, welcomeByType } =
  createBundledCatalog()

// Test-only pin for the channel; `null` reads the realm.
let channelForTest: UpdateChannel | null = null

/**
 * The channel whose catalog and templates this realm serves. Read per call,
 * never cached at module load: it is a property of the realm (its origin, or
 * an off-channel preview). A remote client takes its runtime's channel off
 * the connection (`adoptRuntimeChannel`) before its shell renders.
 */
export function templateChannel(): UpdateChannel {
  return channelForTest ?? currentTemplateChannel()
}

/** Test-only: pin the channel (`null` = read the realm). */
export function setTemplateChannelForTest(channel: UpdateChannel | null): void {
  channelForTest = channel
}

/**
 * The launcher catalog for the channel without loading any `template.md`:
 * beta uses `index-beta.md` when bundled, else `index.md`. The array is stable
 * per channel (`getThreadLaunchers` memoizes on it).
 */
export function getLauncherCatalog(): readonly LauncherMeta[] {
  return templateChannel() === 'beta' && betaLauncherCatalog
    ? betaLauncherCatalog
    : launcherCatalog
}

/** The launcher metadata for one type in the current channel's catalog. */
export function getLauncherMeta(type: string): LauncherMeta | undefined {
  return activeLauncherByType().get(type)
}

/**
 * A launcher's display title: `title-i18n` via `translate` (which must
 * return undefined for a missing key), else `title`, else `type`.
 */
export function getTemplateTitle(
  type: string,
  translate?: (key: string) => string | undefined,
): string {
  const meta = activeLauncherByType().get(type)
  if (meta?.titleI18n && translate) {
    const localized = translate(meta.titleI18n)
    if (localized) return localized
  }
  return meta?.title ?? type
}

/** A resolved launcher icon: an SVG data URI (or image URL) for an `<img>`, or a
 *  lucide-react component name. */
export type TemplateIcon =
  | { kind: 'url'; src: string }
  | { kind: 'lucide'; name: string }

/**
 * The launcher icon for a type, from the `index.md` catalog. Resolution order:
 *   1. `icon` — an inline SVG **data URI** (`data:image/svg+xml;…`) → `<img src>`.
 *   2. `icon_lucide` — a lucide-react icon name → a component.
 * undefined when none is set (the caller keeps its own fallback icon). There are
 * NO icon files; the icon is inlined in `index.md`.
 */
export function getTemplateIcon(type: string): TemplateIcon | undefined {
  const meta = activeLauncherByType().get(type)
  if (meta?.icon) return { kind: 'url', src: meta.icon }
  if (meta?.iconLucide) return { kind: 'lucide', name: meta.iconLucide }
  return undefined
}

/**
 * A type's welcome page for the active UI `locale` (e.g. 'zh'), from
 * `<type>/welcome-<locale>.md`, falling back to the default `<type>/welcome.md`.
 * undefined when the type ships no welcome.md.
 */
export function getWelcome(
  type: string,
  locale = '',
): WelcomeContent | undefined {
  const byLocale = welcomeByType.get(type)
  if (!byLocale) return undefined
  return byLocale.get(locale) ?? byLocale.get('')
}

// `launcherByType` for the beta catalog, built on first use.
let betaByTypeFor: readonly LauncherMeta[] | null = null
let betaByType = new Map<string, LauncherMeta>()

function activeLauncherByType(): ReadonlyMap<string, LauncherMeta> {
  const catalog = getLauncherCatalog()
  if (catalog === launcherCatalog) return launcherByType
  if (betaByTypeFor !== catalog) {
    betaByTypeFor = catalog
    betaByType = new Map(catalog.map(m => [m.type, m]))
  }
  return betaByType
}
