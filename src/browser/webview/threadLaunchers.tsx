import { type ComponentType } from 'react'
import {
  BotIcon,
  CodeIcon,
  FolderIcon,
  ListChecksIcon,
  MessageCircleIcon,
  ShieldCheckIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react'
import type { MessageKey } from './i18n/messages/en'
import type { TranslateFn } from './i18n'
import {
  getLauncherCatalog,
  getTemplateIcon,
  getTemplateTitle,
} from '../../prompting/templateCatalog'
import type { LauncherMeta } from '../../prompting/templateParsing'

/** A launcher icon component — a lucide-react icon OR an <img> wrapper (for a
 *  template `icon` path / https URL). Both accept `className` for sizing, so
 *  the render sites (`<Icon className=… />`) treat them identically. */
export type IconComponent = ComponentType<{ className?: string }>

/**
 * Thread-launcher items at the top of the sidebar; `type` selects the new session's template.
 * `type: undefined` is the generic "New Thread" (boot default, empty-session reuse); any other `type` must be
 * a registered template type (an unknown one falls back to the default). Title and icon come from the
 * `index.md` launcher catalog, with the values here as fallbacks.
 */
export type ThreadLauncher = {
  /** templateType for the new session; `undefined` = boot default. */
  type?: string
  /** i18n key for the visible label. Optional: a LOCAL (on-disk) type has no
   *  i18n key — its label comes from the `index.md` `title`/`title-i18n`. */
  titleKey?: MessageKey
  /** i18n key for a new session's placeholder title ("New {type}"), shown until
   *  the session has a real title. Optional for local types (→ the catalog
   *  title is used; see `launcherDefaultTitle`). */
  defaultTitleKey?: MessageKey
  /** Icon shown before the title (launcher row AND each session row): a
   *  lucide-react component or an <img> wrapper (template `icon` url/path). */
  Icon: IconComponent
  /** Stable selector for e2e (`[data-testid="…"]`). */
  testId: string
  /** From the catalog's `launcherHidden`: not OFFERED on the given surface(s)
   *  — `'both'` hides from sidebar AND menu; `'sidebar'` hides the sidebar
   *  only (menu-only, e.g. `team`). Nothing unhides a hidden type: it stays
   *  creatable by `openNewSession(type)` / `?templateType=`, just not listed. */
  launcherHidden?: 'both' | 'sidebar'
  /** From the catalog's `launcherMenu: false`: not offered in the project
   *  folder's `+`/`⋯` menu (the sidebar launcher is unaffected). */
  launcherMenu?: false
}

// The boot-default template type (the `type: undefined` "New Thread" launcher
// resolves its title/icon from this). Mirrors createBrowserRuntime's default.
const DEFAULT_TYPE = 'agent'

// lucide-react components keyed by the name a template's `icon_lucide` uses.
// Extend when a template references a different icon.
const LUCIDE_BY_NAME: Record<string, LucideIcon> = {
  bot: BotIcon,
  'message-circle': MessageCircleIcon,
  code: CodeIcon,
  'shield-check': ShieldCheckIcon,
  'list-checks': ListChecksIcon,
  folder: FolderIcon,
  users: UsersIcon,
}

// An <img> wrapper for a template `icon` (an SVG data URI), with the same
// `className` (sizing) API as a lucide icon — so the rail/rows render it the
// same way (`<Icon className=… />`).
export function makeImageIcon(src: string): IconComponent {
  const ImageIcon = ({ className }: { className?: string }) => (
    <img src={src} className={className} alt="" aria-hidden />
  )
  ImageIcon.displayName = 'TemplateImageIcon'
  return ImageIcon
}

// A type's launcher icon, from the `index.md` catalog (templateCatalog
// getTemplateIcon): an `icon` SVG data URI → an <img>; else `icon_lucide` → the
// mapped lucide component; else `fallback`. So `icon` / `icon_lucide` in
// index.md drive the launcher icon (no icon files).
function iconForType(type: string, fallback: IconComponent): IconComponent {
  const icon = getTemplateIcon(type)
  if (icon?.kind === 'url') return makeImageIcon(icon.src)
  if (icon?.kind === 'lucide') {
    const Component = LUCIDE_BY_NAME[icon.name]
    if (Component) return Component
  }
  return fallback
}

// Built-in launcher affordances by type: the e2e testId, the i18n title/
// default-title keys, the boot-default `type: undefined` reuse (agent), and a
// fallback icon. A catalog entry for one of these types reuses its affordance;
// any other (LOCAL) type gets a generated testId + its title/icon from index.md.
interface BuiltinAffordance {
  type?: string
  titleKey: MessageKey
  defaultTitleKey: MessageKey
  testId: string
  fallbackIcon: IconComponent
}
const BUILTIN_AFFORDANCES: Record<string, BuiltinAffordance> = {
  // type undefined → createBrowserRuntime default 'agent'; keeps empty-session
  // reuse + the `clickNewThreadInSidebar` ('sidebar-new-thread') e2e testId.
  agent: {
    type: undefined,
    titleKey: 'launcher.agent',
    defaultTitleKey: 'launcher.newAgent',
    testId: 'sidebar-new-thread',
    fallbackIcon: BotIcon,
  },
  chat: {
    type: 'chat',
    titleKey: 'launcher.chat',
    defaultTitleKey: 'launcher.newChat',
    testId: 'launcher-chat',
    fallbackIcon: MessageCircleIcon,
  },
  code: {
    type: 'code',
    titleKey: 'launcher.code',
    defaultTitleKey: 'launcher.newCode',
    testId: 'launcher-code',
    fallbackIcon: CodeIcon,
  },
  // Capability-controlled coding agent (read tools to observe, SuperEdit to
  // mutate, exec for approved commands — no general shell). UI display
  // "SafeCode", serialized type `safe_code`. `index.md` marks it
  // `launcherHidden: both` — never offered as a launcher; it exists for
  // derived sessions (an untrusted team child) and `?templateType=` only.
  safe_code: {
    type: 'safe_code',
    titleKey: 'launcher.safeCode',
    defaultTitleKey: 'launcher.newSafeCode',
    testId: 'launcher-safe-code',
    fallbackIcon: ShieldCheckIcon,
  },
  // A team lead: `code` plus real child sessions. Listed only in the beta
  // catalog (`index-beta.md`), where it is offered on the sidebar and the
  // project folder's menu alike; stable's `index.md` has no entry for it.
  team: {
    type: 'team',
    titleKey: 'launcher.team',
    defaultTitleKey: 'launcher.newTeam',
    testId: 'launcher-team',
    fallbackIcon: UsersIcon,
  },
}

/**
 * The launchers to offer: `launcherHidden` `'both'` drops an entry everywhere, `'sidebar'` from the
 * sidebar only; a hidden type stays creatable. Order is preserved; `launchers` is already the channel's list.
 */
export type LauncherSurface = 'sidebar' | 'projectMenu'

export function filterLaunchers(
  launchers: readonly ThreadLauncher[],
  surface: LauncherSurface = 'sidebar',
): ThreadLauncher[] {
  return launchers.filter(l => {
    // `launcherHidden` scope: `'sidebar'` hides the sidebar only; `'both'`
    // hides both surfaces.
    const hidden = l.launcherHidden
    if (hidden === 'sidebar') return surface === 'projectMenu'
    if (hidden) return false
    return surface !== 'projectMenu' || l.launcherMenu !== false
  })
}

/** The default launcher (agent) — the fallback for sessions whose templateType
 *  doesn't match any catalog entry (including the `undefined` boot default). */
export const DEFAULT_LAUNCHER: ThreadLauncher = {
  type: undefined,
  titleKey: 'launcher.agent',
  defaultTitleKey: 'launcher.newAgent',
  Icon: iconForType('agent', BotIcon),
  testId: 'sidebar-new-thread',
}

// Memoized derivation: rebuilt only when the catalog ARRAY IDENTITY changes
// (once, if a `template=local` overlay replaced it at boot — the channel of a
// realm is settled before the shell renders, a remote's included, so
// `getLauncherCatalog` keeps returning one array), so the Icon components stay
// stable across renders.
let cachedCatalog: readonly LauncherMeta[] | null = null
let cachedLaunchers: ThreadLauncher[] = []

/**
 * The launcher list, DERIVED from the `index.md` launcher catalog
 * (`getLauncherCatalog`) — so a boot overlay (a local `index.md` via
 * `template=local`) is reflected. Built-in types (agent/chat/code) keep their
 * testIds + the agent `type: undefined` boot-default; any other (local) type is
 * added with a generated testId and its title/icon from the catalog.
 */
export function getThreadLaunchers(): ThreadLauncher[] {
  const catalog = getLauncherCatalog()
  if (catalog === cachedCatalog) return cachedLaunchers
  cachedCatalog = catalog
  cachedLaunchers = catalog.map(meta => {
    const builtin = BUILTIN_AFFORDANCES[meta.type]
    return builtin
      ? {
          type: builtin.type,
          titleKey: builtin.titleKey,
          defaultTitleKey: builtin.defaultTitleKey,
          Icon: iconForType(meta.type, builtin.fallbackIcon),
          testId: builtin.testId,
          ...(meta.launcherHidden ? { launcherHidden: meta.launcherHidden } : {}),
          ...(meta.launcherMenu === false ? { launcherMenu: false as const } : {}),
        }
      : {
          type: meta.type,
          Icon: iconForType(meta.type, BotIcon),
          testId: `launcher-${meta.type}`,
          ...(meta.launcherHidden ? { launcherHidden: meta.launcherHidden } : {}),
          ...(meta.launcherMenu === false ? { launcherMenu: false as const } : {}),
        }
  })
  return cachedLaunchers
}

/**
 * The concrete template type a launcher creates: `launcher.type`, with the agent launcher's `undefined`
 * resolved to its catalog type. Use it wherever a type must be named explicitly (project launches).
 */
export function launcherTemplateType(launcher: ThreadLauncher): string {
  return launcher.type ?? DEFAULT_TYPE
}

/**
 * Resolve the launcher (→ icon + default title) for a session's templateType.
 * `undefined` (the boot default) maps to the agent launcher; an unknown type
 * also falls back to it.
 */
export function getLauncherForType(type: string | undefined): ThreadLauncher {
  const launchers = getThreadLaunchers()
  return (
    launchers.find(launcher => launcher.type === type) ??
    launchers.find(launcher => launcher.type === undefined) ??
    DEFAULT_LAUNCHER
  )
}

/**
 * The launcher's display title, from the `index.md` catalog: the `title-i18n`
 * message (FIRST choice) → the literal `title` → the launcher's own i18n
 * `titleKey` (fallback for a type with no template title). A key with no
 * message makes `t` echo the key, which we treat as "not found" so the literal
 * `title` fallback applies (matching the template-frontmatter contract).
 */
export function launcherTitle(launcher: ThreadLauncher, t: TranslateFn): string {
  const translate = (key: string): string | undefined => {
    const value = t(key as MessageKey)
    return value === key ? undefined : value
  }
  const type = launcher.type ?? DEFAULT_TYPE
  const title = getTemplateTitle(type, translate)
  if (title !== type) return title
  // No catalog title resolved → the launcher's own i18n key (built-in) or the
  // bare type (a local type with neither a title nor a key — unusual).
  return launcher.titleKey ? t(launcher.titleKey) : title
}

/**
 * A new session's placeholder title for `launcher` ("New {type}"). Built-in
 * launchers use their i18n `defaultTitleKey`; a local type (no key) falls back
 * to its catalog title (`index.md` `title`/`title-i18n`, else the bare type).
 */
export function launcherDefaultTitle(
  launcher: ThreadLauncher,
  t: TranslateFn,
): string {
  if (launcher.defaultTitleKey) return t(launcher.defaultTitleKey)
  return getTemplateTitle(launcher.type ?? DEFAULT_TYPE)
}
