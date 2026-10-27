import { getProductName } from '../../../branding/productName'
import type { MessageKey, Messages } from './messages/en'

/**
 * The pure runtime half of i18n: registry, loader, translator — no React, no DOM, so
 * the SharedWorker can import it. Catalogs ship as content-hashed JSON assets
 * (`localeAssetsPlugin`) fetched at boot. Contract: nothing under `messages/` may be
 * imported for its VALUE by runtime code; `import type` is fine.
 */
export type Locale = 'en' | 'zh' | 'es' | 'fr' | 'de' | 'ja' | 'ko'

export const LOCALES: readonly Locale[] = [
  'en',
  'zh',
  'es',
  'fr',
  'de',
  'ja',
  'ko',
]

export type TranslateFn = (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string

/** DOM id of the locale→URL map injected into index.html at build time. */
export const LOCALE_MAP_ELEMENT_ID = 'nexus-locales'

/**
 * English readable with NO catalog loaded: `thread.crashed*` (a render crash before
 * boot) and `slash.*` (rendered into the transcript and the model's context, and
 * picker hints that travel as keys). `i18n-catalog-loading.test.ts` asserts each
 * equals `messages/en.ts`. Editing one re-hashes many assets: add a key only when
 * code must render it with no catalog loaded.
 */
export const BOOTSTRAP_MESSAGES: Partial<Record<MessageKey, string>> = {
  'thread.crashedTitle': 'Conversation crashed',
  'thread.crashedBody':
    'The thread hit a render error. Other sessions are unaffected.',
  'thread.crashedRetry': 'Retry',

  // The chunk-load failure overlay: it can fire before any catalog loads.
  'chunkLoad.failedTitle': "The app couldn't load",
  'chunkLoad.failedBody': 'Part of the app failed to load. Reload to continue.',
  'chunkLoad.offlineTitle': "You're offline",
  'chunkLoad.offlineBody': "Part of the app isn't available offline. Reconnect, then reload.",
  'chunkLoad.reload': 'Reload',

  'slash.builtin.help': 'Show available slash commands',
  'slash.builtin.tabs': 'List the open browser tabs',
  'slash.builtin.context':
    'Attach the current browser context to the conversation',
  'slash.builtin.clear': 'Clear the conversation',
  'slash.builtin.model': 'Switch provider/model for the next turn',
  'slash.builtin.compact':
    'Compact the conversation now (optional: /compact <instructions>)',
  'slash.builtin.autocompact':
    'Set the auto-compact window for the current model (/autocompact <size>|auto)',
  'slash.builtin.status': 'Show session info (host, tabs, locale)',
  'slash.builtin.plan':
    'Enter plan mode — read/search only, design before coding',
  'slash.builtin.exit-plan': 'Exit plan mode (optional: /exit-plan <plan text>)',
  'slash.builtin.plugins':
    'Manage plugins: list, enable/disable/update/uninstall <name>, install <git-url>',
  'slash.builtin.plugin':
    'Marketplace plugin management: list, install/uninstall/enable/disable <name>@<marketplace>',
  'slash.builtin.marketplace':
    'Plugin marketplaces: list, add <github-url|owner/repo>, remove/update/info <name>',
  'slash.builtin.mcp': 'Open the MCP servers settings page',
  'slash.builtin.rename':
    'Rename this session (optional: /rename <name> — omit to auto-name)',
  'slash.builtin.cost': 'Show session token usage and estimated cost',
  'slash.builtin.agents': 'List the agents the Agent tool can run (subagent_type)',
  'slash.builtin.skills': 'List loaded skills and how each can be invoked',
  'slash.builtin.hooks': 'List the hooks registered for this session, by event',
  'slash.builtin.permissions': 'Show the permission mode and the rules in force',
  'slash.builtin.debug':
    'Diagnose the {product} runtime; subcommands: transcript, log [on|off], verbose [on|off], trace [on|off], inspect [on|off]',
  'slash.out.unknownCommand': 'Unknown slash command: /{command}',
  'slash.out.availableCommands': 'Available: {commands}',
  'slash.out.helpHeader': '{product} slash commands',
  'slash.out.helpHiddenHeading': 'Hidden commands',
  'slash.out.helpHiddenNote':
    'These run when you type the full name, but stay out of the command picker so it is not cluttered.',
  'slash.out.helpFooter': 'Type a message to send a prompt to {product}.',
  'slash.out.statusBrowser': 'Host: {browser}',
  'slash.out.statusTabs': 'Tabs: {count}',
  'slash.out.statusActiveTab': 'Active tab: {id}',
  'slash.out.statusLocale': 'Locale: {locale}',
  'slash.out.statusTimezone': 'Timezone: {timezone}',
  'slash.out.statusUnknown': 'unknown',
  'slash.out.statusNone': 'none',
  'slash.out.cleared': 'Conversation cleared. Start a new prompt.',
  'slash.out.renamed': 'Session renamed to: {title}',
  'slash.out.renameUsage':
    'Could not generate a name (no conversation yet). Usage: /rename <name>',
  'slash.out.modelSwitched': 'Model switched to: {model}',
  'slash.out.modelUsage':
    'Usage: /model <model-name> or /model <provider-id> <model-name>',
  'slash.out.autoCompactStatusAuto':
    'Auto-compact window for {model}: auto (compacts at about {threshold} tokens).',
  'slash.out.autoCompactStatusFixed':
    'Auto-compact window for {model}: compacts at {window} tokens.',
  'slash.out.autoCompactUsage':
    'Use /autocompact <size> (100k to 1M, for example 400k) or /autocompact auto.',
  'slash.out.autoCompactOff':
    'Auto-compact is turned off in settings (autoCompaction). /compact still works.',
  'slash.out.autoCompactSetAuto': 'Auto-compact window for {model} set to auto',
  'slash.out.autoCompactSetFixed': 'Auto-compact window for {model} set to {window} tokens',
  'slash.out.autoCompactCapped':
    '{model} can compact at most at {limit} tokens (its context window less room for the summary), so auto-compact uses {limit}.',
  'slash.out.autoCompactShadowed':
    'Another settings file sets the window for this model to {window} tokens; that value applies.',
  'slash.out.autoCompactInvalid':
    'Invalid auto-compact window "{input}". Use a size from 100k to 1M (for example 400k, 1M or 200000) or auto.',
  'slash.out.autoCompactNoSettings':
    'The auto-compact window cannot be saved: this host has no settings file.',
  'slash.out.autoCompactNoModel': 'No model is selected. Choose a model first.',
  'slash.out.autoCompactSaveFailed': 'Could not save the auto-compact window: {error}',
  'slash.out.mcpOpening': 'Opening MCP server settings…',
  'slash.out.noTabs': 'No browser tabs are currently available.',
  'slash.out.tabUntitled': '(untitled)',
  'slash.out.tabNoUrl': '(no url)',
  'slash.out.compactUnavailable': 'Compaction is not available in this runtime.',
  'slash.out.compactNoMessages': 'No messages to compact.',
  'slash.out.modPromptDropped': 'A plugin stopped this prompt: {reason}',
  'slash.out.modPromptDroppedNoReason': 'A plugin stopped this prompt.',
  'slash.out.modPromptInterrupted': 'Stopped while a plugin was checking this prompt, so it was not sent.',
  'slash.out.modPromptUnreachable': 'This prompt was not sent: {name} could not check it (its hooks are restarting or were unloaded).',
  'slash.out.modCommandUnanswered': 'No plugin answered /{command}.',
  'slash.out.helpModsHeading': 'Plugin commands',
  'slash.out.helpModCommand': '{description} (from the plugin {plugin})',
  'slash.out.compactSkipped': 'Compaction skipped by a plugin — {reason}. The transcript is unchanged.',
  'slash.out.compactFailed': 'Compaction failed — {reason}. The transcript is unchanged.',
  'slash.out.compactBlockedByHook': 'Compaction blocked by a hook — {reason}. The transcript is unchanged.',
  'slash.out.compactBlockedByHookNoReason': 'Compaction blocked by a hook. The transcript is unchanged.',
  'slash.out.skillDenied': 'Skill /{name} is not available in this session type.',
  'slash.out.skillNotUserInvocable':
    'Skill /{name} cannot be invoked via slash. The model can still call it via the Skill tool.',
  'slash.out.agents.forkNote':
    '{route} (reserved) — inherit this session’s full context (system prompt, tools, conversation) instead of starting isolated.',
  'slash.out.agents.empty': 'No agents are registered for this session.',
  'slash.out.agents.authorHint':
    'Author one as markdown with `name`/`description`/`tools`/`model` frontmatter in any of:',
  'slash.out.agents.userScope': '~/{dir}/agents/  (user scope)',
  'slash.out.agents.projectScope': '<cwd>/{dir}/agents/  (project scope)',
  'slash.out.agents.pluginScope': 'a plugin’s agents/ directory',
  'slash.out.agents.alwaysAvailable': 'Always available regardless:',
  'slash.out.agents.header': 'Agents: {count} registered (Agent tool `subagent_type`)',
  'slash.out.agents.reservedHeading': 'Reserved:',
  'slash.out.skills.empty':
    'No skills are loaded. Author one as `SKILL.md` (with a `description` frontmatter field) under ~/{dir}/skills/<name>/ or <cwd>/{dir}/skills/<name>/, or install a plugin that ships skills (`/plugin install <name>@<marketplace>`).',
  'slash.out.skills.header': 'Skills: {loaded} loaded',
  'slash.out.skills.headerWithWithheld': 'Skills: {loaded} loaded, {withheld} withheld',
  'slash.out.skills.withheldHeading': 'Withheld — path-gated ({count}):',
  'slash.out.skills.withheldExplanation':
    'Loaded and valid, but held out of the active set until file-touch activation. Not invocable yet, by slash or by the model.',
  'slash.out.hooks.noSession': 'No session is active, so no hooks are registered.',
  'slash.out.hooks.matcherLabel': 'matcher',
  'slash.out.hooks.matchAll': '* (match all)',
  'slash.out.hooks.empty':
    'No hooks are registered for this session. Declare them under `hooks` in settings.json, or in a skill’s frontmatter (those register when the skill is invoked).',
  'slash.out.hooks.header': 'Hooks: {hooks} across {matchers} matchers',
  'slash.out.hooks.headerOneMatcher': 'Hooks: {hooks} across {matchers} matcher',
  'slash.out.permissions.mode': 'Permission mode: {mode}',
  'slash.out.permissions.modeBeforePlan': 'Mode before plan mode: {mode}',
  'slash.out.permissions.bypassDisabled': 'Bypass mode: disabled by settings',
  'slash.out.permissions.bypassAvailable': 'Bypass mode: available',
  'slash.out.permissions.allowHeading': 'Allow ({count}):',
  'slash.out.permissions.askHeading': 'Ask ({count}):',
  'slash.out.permissions.denyHeading': 'Deny ({count}):',
  'slash.out.permissions.noRules':
    'No allow/ask/deny rules are configured — the rule gate is a no-op. Add them under `permissions` in settings.json.',
  'slash.out.permissions.alwaysAllowHeading': 'Always allow ({count}):',
  'slash.out.permissions.alwaysAskHeading': 'Always ask ({count}):',
  'slash.out.permissions.alwaysDenyHeading': 'Always deny ({count}):',
  'slash.out.permissions.strippedHeading': 'Stripped for the current mode ({count}):',
  'slash.out.permissions.workingDirsHeading': 'Additional working directories ({count}):',
  'slash.out.permissions.noContext': 'No permission context is available for this session.',
  'slash.out.debug.internal.statusOn':
    'Internal-user mode is on — sub-agents may spawn nested agents.',
  'slash.out.debug.internal.statusOff':
    'Internal-user mode is off — sub-agents cannot spawn nested agents.',
  'slash.out.debug.internal.statusHint':
    'Use /debug internal on|off to change it; applies to the next agent spawn.',
  'slash.out.debug.internal.enabled':
    'Internal-user mode enabled — sub-agents may spawn nested agents. Applies to the next agent spawn; saved to settings.json.',
  'slash.out.debug.internal.disabled':
    'Internal-user mode disabled — sub-agents cannot spawn nested agents (the default). Applies to the next agent spawn.',
  'slash.out.debug.notPersisted':
    'Note: no settings home directory on this host — the change is not persisted and lasts only until the next reload.',
  'slash.out.debug.persistFailed':
    'Warning: failed to persist to settings.json ({error}) — the change lasts only until the next reload.',
  'slash.out.debug.skillUnavailable':
    'The debug skill is not available in this session.',
  'slash.out.debug.usage.title':
    '{command} usage',
  'slash.out.debug.usage.issueArg':
    'issue description',
  'slash.out.debug.usage.issue':
    'diagnose the {product} runtime (model-driven debug skill)',
  'slash.out.debug.usage.transcript':
    'transcript diagnostics: per-compaction-segment sizes, tool + token stats',
  'slash.out.debug.usage.status':
    'one-glance summary of all debug switches + ring buffer state',
  'slash.out.debug.usage.log':
    'show/set live debug capture into the worker log ring (this session)',
  'slash.out.debug.usage.name':
    'set the product name the model sees in prompts (saved to settings.json); bare /debug name (or "") cancels it',
  'slash.out.debug.usage.verbose':
    'show/set verbose model logging (applies next reload)',
  'slash.out.debug.usage.trace':
    'show/set the trace overlay (applies next reload)',
  'slash.out.debug.usage.inspect':
    'show/set the panel right-click "Inspect" menu (opens DevTools)',
  'slash.out.debug.usage.internal':
    'show/set internal-user mode: on = sub-agents may spawn nested agents, off = they cannot (default); saved to settings.json, applies to the next spawn',
  'slash.out.plugins.empty':
    'No plugins discovered. Place a plugin under ~/{dir}/plugins/<name>/ or <cwd>/{dir}/plugins/<name>/ (with .claude-plugin/plugin.json), then enable it with `/plugins enable <name>` — which records the choice in ~/{dir}/enabled-plugins.json for a user-scope plugin, or <cwd>/{dir}/enabled-plugins.json for a project-scope one.',
  'slash.out.plugins.header': 'Plugins: {enabled} enabled, {disabled} disabled',
  'slash.out.plugins.enabledHeading': 'Enabled:',
  'slash.out.plugins.disabledHeading':
    'Disabled (present on disk but not in the enabled allowlist):',
  'slash.out.plugins.errorsHeading': 'Load errors:',
  'slash.out.plugin.usage.list':
    '  list                                show installed plugins',
  'slash.out.plugin.usage.install':
    '  install <name>@<marketplace>        install from a known marketplace',
  'slash.out.plugin.usage.installFrom':
    '  install <name> --marketplace <owner/repo>  add the marketplace if needed, then install',
  'slash.out.plugin.usage.uninstall':
    '  uninstall <name>@<marketplace>      remove an installed plugin',
  'slash.out.plugin.usage.enable':
    '  enable <name>@<marketplace>         enable an installed plugin',
  'slash.out.plugin.usage.disable':
    '  disable <name>@<marketplace>        disable without uninstalling',
  'slash.out.plugin.usage.identifierFormat': 'Identifier format: <plugin>@<marketplace>',
  'slash.out.plugin.usage.example': 'Example: /plugin install superpowers@claude-plugins-official',
  'slash.out.plugin.usage.seeAvailable': 'To see what plugins are available in a marketplace:',
  'slash.out.plugin.usage.legacyNote':
    'For the legacy git-clone install (project-scoped), use /plugins (plural).',
  'slash.out.plugin.unknownSubcommand': 'Unknown subcommand: /plugin {sub}',
  'slash.out.plugin.error': 'Error running /plugin {sub}: {error}',
  'slash.out.plugin.install.usage': 'Usage: /plugin install <name>@<marketplace>',
  'slash.out.plugin.invalidIdentifier': 'Invalid identifier: {message}',
  'slash.out.plugin.install.success': 'Installed {identifier} (v{version})',
  'slash.out.plugin.install.fileCount': '{count} files → `{path}`',
  'slash.out.plugin.install.liveNote':
    'New plugins are enabled by default and take effect in this session now. Other open sessions, and any MCP servers a plugin adds, pick it up in a new session.',
  'slash.out.plugin.uninstall.usage': 'Usage: /plugin uninstall <name>@<marketplace>',
  'slash.out.plugin.uninstall.notInstalled': 'Not installed: {id} (nothing to remove)',
  'slash.out.plugin.uninstall.success': 'Uninstalled {id}',
  'slash.out.plugin.uninstall.cacheNote':
    '(cache dir left at `{path}` — manual delete OK; will be reused on reinstall)',
  'slash.out.plugin.enableDisable.usage': 'Usage: /plugin {verb} <name>@<marketplace>',
  'slash.out.plugin.enabledConfirm': 'Enabled {id}',
  'slash.out.plugin.disabledConfirm': 'Disabled {id}',
  'slash.out.plugin.effectNow':
    'Takes effect in this session now. Other open sessions, and MCP server changes, pick it up in a new session.',
  'slash.out.plugin.list.empty': 'No plugins installed via the marketplace pipeline.',
  'slash.out.plugin.list.installHint': 'To install one: /plugin install <name>@<marketplace>',
  'slash.out.plugin.list.marketplacesHint':
    'To see what marketplaces are available: /marketplace list',
  'slash.out.plugin.list.scopeNote':
    'Note: this list shows plugins installed via /plugin (marketplace). Project-scoped git-clone installs (via /plugins, plural) live in a separate registry — run /plugins to see those.',
  'slash.out.plugin.list.header': 'Installed plugins: {count}',
  'slash.out.plugin.state.disabled': 'disabled',
  'slash.out.plugin.state.enabledExplicit': 'enabled (explicit)',
  'slash.out.plugin.state.enabledDefault': 'enabled (default)',
  'slash.out.marketplace.usage.list':
    '  list                            show known marketplaces',
  'slash.out.marketplace.usage.add':
    '  add <github-url|owner/repo>    register + fetch a marketplace',
  'slash.out.marketplace.usage.remove':
    '  remove <name>                  unregister (non-official only)',
  'slash.out.marketplace.usage.update':
    '  update <name>                  re-fetch a marketplace’s contents',
  'slash.out.marketplace.usage.info':
    '  info <name>                    list available plugins in a marketplace',
  'slash.out.marketplace.usage.defaultsHeading': 'Default-installed marketplaces:',
  'slash.out.marketplace.usage.officialLine':
    '  claude-plugins-official  — Anthropic-curated, SHA-pinned',
  'slash.out.marketplace.usage.communityLine':
    '  claude-plugins-community — Anthropic-mirrored community submissions',
  'slash.out.marketplace.usage.exampleHeading': 'Example:',
  'slash.out.marketplace.unknownSubcommand': 'Unknown subcommand: /marketplace {sub}',
  'slash.out.marketplace.error': 'Error running /marketplace {sub}: {error}',
  'slash.out.marketplace.list.emptyUnexpected':
    'No marketplaces registered (this should not happen — officials are pre-seeded).',
  'slash.out.marketplace.list.header': 'Known marketplaces: {count}',
  'slash.out.marketplace.list.footer': 'For what’s in each: /marketplace info <name>',
  'slash.out.marketplace.officialTag': '(official)',
  'slash.out.marketplace.builtinTag': '(built in)',
  'slash.out.marketplace.notYetFetched': ', not yet fetched',
  'slash.out.marketplace.lastUpdated': ', last updated {time}',
  'slash.out.marketplace.add.usage': 'Usage: /marketplace add <github-url|owner/repo>',
  'slash.out.marketplace.add.parseError':
    'Could not parse ‘{value}’ as a github URL or owner/repo identifier.',
  'slash.out.marketplace.add.registerFailed': 'Failed to register marketplace: {error}',
  'slash.out.marketplace.add.fetchFailed':
    'Fetched {source} but couldn’t load marketplace.json: {error}',
  'slash.out.marketplace.add.renameCleanupFailed':
    'Renamed to ‘{name}’ but cleanup failed: {error}',
  'slash.out.marketplace.add.success': 'Added marketplace ‘{name}’',
  'slash.out.marketplace.add.sourceLine': 'source: {source}',
  'slash.out.marketplace.add.pluginsAvailable': 'plugins available: {count}',
  'slash.out.marketplace.add.browseHint': 'Browse plugins: /marketplace info {name}',
  'slash.out.marketplace.add.installHint': 'Install one: /plugin install <name>@{name}',
  'slash.out.marketplace.remove.usage': 'Usage: /marketplace remove <name>',
  'slash.out.marketplace.remove.official':
    'Cannot remove ‘{name}’ — it is an official Anthropic marketplace.',
  'slash.out.marketplace.remove.builtin':
    'Cannot remove ‘{name}’ — it is {product}’s built-in marketplace.',
  'slash.out.marketplace.remove.success': 'Removed marketplace ‘{name}’.',
  'slash.out.marketplace.update.usage': 'Usage: /marketplace update <name>',
  'slash.out.marketplace.update.success': 'Refreshed ‘{name}’{sha}',
  'slash.out.marketplace.info.usage': 'Usage: /marketplace info <name>',
  'slash.out.marketplace.info.notFetched':
    'Marketplace ‘{name}’ has not been fetched yet (no local manifest).',
  'slash.out.marketplace.info.runUpdateHint': 'Run: /marketplace update {name}',
  'slash.out.marketplace.info.zeroPlugins': 'Marketplace ‘{name}’ contains 0 plugins.',
  'slash.out.marketplace.info.noDescription': '(no description)',
  'slash.out.marketplace.info.header': '{name} — {description}',
  'slash.out.marketplace.info.countLine': '{count} plugins:',
  'slash.out.marketplace.info.moreCount': '  … and {count} more',
  'slash.out.cost.empty': 'No model usage recorded in this session yet.',
  'slash.out.cost.header': 'Session token usage',
  'slash.out.cost.modelLine':
    '{model}: {input} in, {output} out, {cacheRead} cache read, {cacheCreate} cache write  {cost}',
  'slash.out.cost.pricingUnavailable': '— (pricing unavailable)',
  'slash.out.cost.total':
    'Total: {total} tokens ({input} in, {output} out, {cacheRead} cache read, {cacheCreate} cache write)',
  'slash.out.cost.estimated': 'Estimated cost (priced models): {cost}',
  'slash.out.cost.unpricedNote':
    '(Dollar cost is shown only for models with published Anthropic pricing; token counts above are exact for every model.)',
}

/** Map a BCP-47 tag (e.g. `zh-CN`, `en-US`) to a supported catalog. */
export function resolveLocale(raw: string | undefined | null): Locale {
  const lang = (raw ?? '').toLowerCase()
  if (lang.startsWith('zh')) return 'zh'
  if (lang.startsWith('es')) return 'es'
  if (lang.startsWith('fr')) return 'fr'
  if (lang.startsWith('de')) return 'de'
  if (lang.startsWith('ja')) return 'ja'
  // `kr` is NOT a language code — it is the ISO 3166 country code for Korea
  // (ISO 639-1 assigns `kr` to Kanuri), so no standard blesses this mapping
  // and it is not a deprecated-alias case like `iw`/`in`/`ji`. It is here
  // because `kr` turns up in hand-written locale settings meaning Korean, and
  // the alternative for such a user is English — also wrong, and further from
  // what they meant. Velloc ships no Kanuri catalog for it to collide with.
  // Delete this clause if that ever stops being true.
  if (lang.startsWith('ko') || lang.startsWith('kr')) return 'ko'
  return 'en'
}

export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    if (params && key in params) return String(params[key])
    // `{product}` is an implicit token available to every message: catalogs
    // must never hard-code the visible product name (it follows the build's
    // branding via getProductName()), so it is injected here instead of at
    // each call site.
    if (key === 'product') return getProductName()
    return `{${key}}`
  })
}

type LoadedCatalog = { url: string; messages: Messages }

const registry = new Map<Locale, LoadedCatalog>()
const inflight = new Map<Locale, { url: string; promise: Promise<void> }>()

/** Test seam: drop all loaded/in-flight state. */
export function resetCatalogs(): void {
  registry.clear()
  inflight.clear()
}

/**
 * Install a catalog directly, bypassing the network. For unit tests and for
 * any host that already holds the parsed messages.
 */
export function setCatalog(
  locale: Locale,
  messages: Messages,
  url = `memory:${locale}`,
): void {
  registry.set(locale, { url, messages })
}

export function isCatalogLoaded(locale: Locale): boolean {
  return registry.has(locale)
}

/**
 * Fetch and install a catalog. Idempotent per (locale, url) — the url carries the
 * content hash, so a redeploy reloads. Rejects on failure after clearing the
 * in-flight entry; `t()` degrades on its own.
 */
export async function ensureCatalog(
  locale: Locale,
  url: string,
  init?: { signal?: AbortSignal },
): Promise<void> {
  const loaded = registry.get(locale)
  if (loaded?.url === url) return

  const pending = inflight.get(locale)
  if (pending?.url === url) return pending.promise

  const promise = (async () => {
    const res = await fetch(url, {
      // The url is content-hashed and served `immutable`, so after the first
      // load this resolves from the HTTP cache with no network and no
      // revalidation — including offline.
      cache: 'force-cache',
      credentials: 'same-origin',
      signal: init?.signal,
    })
    if (!res.ok) {
      throw new Error(`locale ${locale}: HTTP ${res.status} for ${url}`)
    }
    const messages = (await res.json()) as Messages
    if (!messages || typeof messages !== 'object') {
      throw new Error(`locale ${locale}: malformed catalog at ${url}`)
    }
    registry.set(locale, { url, messages })
  })().finally(() => {
    // Never cache a settled promise: a rejected one would make every later
    // attempt fail without retrying.
    if (inflight.get(locale)?.promise === promise) inflight.delete(locale)
  })

  inflight.set(locale, { url, promise })
  return promise
}

let enCatalogReady: Promise<void> | null = null

/**
 * Start loading the English catalog (the SharedWorker gets `enCatalogUrl` in its
 * init payload); {@link whenEnCatalogReady} awaits it. Never rejects.
 */
export function primeEnCatalog(url: string | undefined): void {
  if (!url || registry.get('en')?.url === url) return
  enCatalogReady = ensureCatalog('en', url).catch(() => {
    // Swallowed on purpose: callers await readiness, not success. Slash output
    // would render its raw keys, which is worse than nothing but not fatal,
    // and `ensureCatalog` has already cleared the in-flight entry so a later
    // call retries.
  })
}

export function whenEnCatalogReady(): Promise<void> {
  return enCatalogReady ?? Promise.resolve()
}

/**
 * A standalone `t()` for a resolved locale, without the React context. Reads the
 * registry on EVERY call, so a module-scope translator sees catalogs loaded later.
 */
export function createTranslate(locale: Locale): TranslateFn {
  return (key, params) =>
    interpolate(lookup(locale, key) ?? key, params)
}

function lookup(locale: Locale, key: MessageKey): string | undefined {
  // Active catalog → English catalog → bootstrap. The raw key is the caller's
  // last resort (handled above) so a string never renders blank.
  return (
    registry.get(locale)?.messages[key] ??
    registry.get('en')?.messages[key] ??
    BOOTSTRAP_MESSAGES[key]
  )
}

/**
 * Whether a runtime string is a key of THIS build's catalog — gate keys received over
 * a wire or from persisted data, since `t()` echoes an unknown key verbatim. Answers
 * `false` before the first catalog lands.
 */
export function isMessageKey(key: string): key is MessageKey {
  for (const loaded of registry.values()) {
    if (key in loaded.messages) return true
  }
  return key in BOOTSTRAP_MESSAGES
}

/**
 * The locale→asset-URL map the build injected into index.html.
 *
 * index.html is the deployment root: unhashed, revalidated by the background
 * updater, and referenced by no chunk — so it can name content-hashed locale
 * assets without any of them entering the JS graph. Read synchronously from
 * the already-parsed document; there is no discovery request.
 */
export function readLocaleAssetMap(
  doc?: Pick<Document, 'getElementById'>,
): Partial<Record<Locale, string>> {
  const host = doc ?? (typeof document !== 'undefined' ? document : undefined)
  const raw = host?.getElementById(LOCALE_MAP_ELEMENT_ID)?.textContent
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Partial<Record<Locale, string>> = {}
    for (const locale of LOCALES) {
      const value = (parsed as Record<string, unknown>)[locale]
      if (typeof value === 'string' && value) out[locale] = value
    }
    return out
  } catch {
    return {}
  }
}

/** Absolute URL for a locale's catalog, resolved against the document base. */
export function resolveLocaleAssetUrl(
  locale: Locale,
  map: Partial<Record<Locale, string>>,
  baseUrl?: string,
): string | undefined {
  const relative = map[locale]
  if (!relative) return undefined
  const base =
    baseUrl ??
    (typeof document !== 'undefined' ? document.baseURI : undefined) ??
    (typeof location !== 'undefined' ? location.href : undefined)
  // Absolute from here on: the worker has no document.baseURI, and nothing
  // downstream should have to know about /v<N>/ or the deploy layout.
  return base ? new URL(relative, base).href : relative
}
