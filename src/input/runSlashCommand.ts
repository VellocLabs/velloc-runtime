/**
 * Built-in slash-command dispatch for a plain-string prompt starting with `/`:
 * hidden built-ins (exact name) → visible built-ins → the loaded skill registry
 * → "unknown command".
 */

import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import type {
  ProcessUserInputParams,
  ProcessUserInputResult,
} from '../runtime/interfaces/UserInputPipeline'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import { getProductName } from '../branding/productName'
import { accumulateSessionUsage, formatCostReport } from '../engine/usageCost'
import { pluginBlockReason } from '../pluginHost/blocklist'
import { PlanOnTool } from '../toolkit/builtin/planEnter'
import { ExitPlanModeTool } from '../toolkit/builtin/planExit'
import { createBrowserContextAttachment } from '../messages/contextAttachments'
import { runAutoCompactCommand } from './autoCompactCommand'
import {
  makeContextRow,
  createLocalizedSystemMessage,
  makeNoticeRow,
  makeUserRow,
} from '../messages/messageFactories'
import type { SystemMessagePart } from '../runtime/RuntimeTypes'
import {
  BLOCK,
  bulletLines,
  key,
  paragraph,
  renderPartsEnglish,
  section,
  text,
  title,
} from './systemMessageParts'
import {
  loadEnabledPlugins,
  patchEnabledPlugin,
  patchUserEnabledPlugin,
} from '../pluginHost/enabledStore'
import { allowlistNameOf, allowlistOf } from '../pluginHost/loadPlugins'
import { setPluginEnabled } from '../pluginHost/enabledPlugins'
import {
  handleMarketplaceSlashCommand,
  handlePluginSlashCommand,
} from './pluginMarketplaceCommands'
import { getProjectPluginsRoot } from '../pluginHost/pluginPaths'
import type { PluginScan } from '../pluginHost/pluginModel'
import { SHELL_TOOL_ID } from '../prompting/processToolNames'
import { dirnameRuntimePath, joinRuntimePath } from '../utils/runtimePaths'
import { traceLine } from '../utils/debugLog'
import { fsForContext } from '../utils/fs/runtimeFs'
import { proposeSessionTitle } from '../sessions/sessionTitles'
import {
  getConditionalSkills,
  resolveInvocationForSession,
} from '../skillLibrary/skillDiscovery'
import { getTemplate, templateAllowsSkill } from '../prompting/templateRegistry'
import {
  type BrowserSlashCommand,
  BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS,
  HIDDEN_BROWSER_SLASH_COMMANDS,
  HIDDEN_BROWSER_SLASH_COMMAND_SET,
  HIDDEN_SLASH_COMMAND_DESCRIPTION_KEYS,
  type HiddenBrowserSlashCommand,
  splitCommandWord,
  resolveSupportedSlashCommands,
} from './slashCommandCatalog'
import {
  dispatchSkillSlashCommand,
  SLASH_DISPATCH_CAN_USE_TOOL,
} from './skillSlashCommand'
import { handleHiddenSlashCommand } from './debugCommands'
import {
  buildAgentsListing,
  buildHooksListing,
  buildPermissionsListing,
  buildSkillsListing,
} from './introspectionCommands'
import {
  buildPluginsListing,
  copyLocalPluginDirectory,
  fileUrlToPath,
  mkdirParents,
  normalizeGitUrl,
  pluginNameFromUrl,
  readBashEnvelope,
  shArg,
} from './pluginInstallCommands'

/** Everything the dispatcher needs from the runtime that isn't in `params`. */
export type ProcessSlashCommandOptions = {
  hostBridge: BrowserHostBridge
  runtimeConfig: RuntimeConfig
  supportedSlashCommands?: readonly string[]
  pluginLoadResult?: PluginScan
  /** Discover the plugins on disk again (`/plugins enable` of a name the
   *  snapshot lacks). Discovery only: loads and enables nothing. */
  rescanPlugins?: () => Promise<PluginScan>
  settingsHomeDir?: string
  marketplaceFetch?: typeof fetch
}

/**
 * "Unknown command" plus the list of the ones that do exist.
 *
 * One helper because this was two byte-identical literals — the pre-switch
 * guard and the switch's `default:` — which is one edit away from drifting
 * apart.
 */
function unknownCommandMessage(
  runtimeConfig: RuntimeConfig,
  command: string,
  supportedSlashCommands: readonly string[],
) {
  return createLocalizedSystemMessage(runtimeConfig, [
    key('slash.out.unknownCommand', { command }),
    text('\n'),
    key('slash.out.availableCommands', {
      commands: supportedSlashCommands.map(name => `/${name}`).join(', '),
    }),
  ])
}

export async function dispatchCommandInput(
  params: ProcessUserInputParams,
  options: ProcessSlashCommandOptions,
): Promise<ProcessUserInputResult> {
  // NOT awaiting the English catalog here on purpose. Slash output is
  // composed from English (it rides into the next LLM request as a
  // `role:"system"` turn), so this used to block on `whenEnCatalogReady()` —
  // but every `slash.*` key is now resident in `BOOTSTRAP_MESSAGES` and a
  // unit test pins that, so the catalog buys no correctness the fallback
  // ladder does not already give. Waiting only added a way for a hung fetch
  // to stall every slash command indefinitely, which is the failure boot
  // bounds at 2s for the same reason.
  const rawInput = String(params.input).trim()
  const { command, args } = splitCommandWord(rawInput)
  const supportedSlashCommands = resolveSupportedSlashCommands(
    options.supportedSlashCommands,
  )

  // Hidden command style: dispatchable by exact name but never listed in the
  // picker or `/help`. Checked before the visible-command guard so a hidden
  // built-in wins over the skill-registry fallback for the same name.
  if (HIDDEN_BROWSER_SLASH_COMMAND_SET.has(command)) {
    return await handleHiddenSlashCommand(
      command as HiddenBrowserSlashCommand,
      args,
      rawInput,
      params,
      options,
    )
  }

  if (!supportedSlashCommands.includes(command)) {
    // Built-in dispatch missed — try the loaded skill registry next.
    // This is the user-typed `/<skill-name>` path; the model-invoked
    // path is `SkillRunTool` and shares `buildSkillBody`.
    const skillResult = await dispatchSkillSlashCommand({
      command,
      args,
      rawInput,
      context: params.context,
      runtimeConfig: options.runtimeConfig,
    })
    if (skillResult) {
      traceLine(`[slash] /${command} dispatched to skill registry`)
      return skillResult
    }

    traceLine(`[slash] unknown command /${command}`, { level: 'info' })
    return {
      messages: [
        unknownCommandMessage(
          options.runtimeConfig,
          command,
          supportedSlashCommands,
        ),
      ],
      shouldQuery: false,
      resultText: rawInput,
    }
  }

  switch (command as BrowserSlashCommand) {
    case 'help': {
      // One entry per command: a `####` heading with the untranslated name and the
      // picker hint under it. `{product}` is resolved by `t()`.
      const parts: SystemMessagePart[] = title(key('slash.out.helpHeader'))
      for (const name of supportedSlashCommands) {
        // Command names are protocol: verbatim in every locale, because a
        // translated `/help` would not dispatch.
        parts.push(...section(`/${name}`))
        const blurbKey =
          BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS[name as BrowserSlashCommand]
        if (blurbKey) parts.push(...paragraph(key(blurbKey)))
      }

      // Hidden built-ins are withheld from the composer's picker (they would
      // clutter the auto-prompt), but `/help` is an explicit request for the
      // whole command surface — and a command that answers when typed while
      // appearing in no list at all reads as a bug, not as a design. They get
      // their own section, labelled as what they are.
      if (HIDDEN_BROWSER_SLASH_COMMANDS.length > 0) {
        parts.push(
          // `title` opens a listing, so it carries no leading separator — this
          // one starts a second section mid-document and needs its own.
          text(BLOCK),
          ...title(key('slash.out.helpHiddenHeading')),
          ...paragraph(key('slash.out.helpHiddenNote')),
        )
        for (const name of HIDDEN_BROWSER_SLASH_COMMANDS) {
          parts.push(
            ...section(`/${name}`),
            ...paragraph(key(HIDDEN_SLASH_COMMAND_DESCRIPTION_KEYS[name])),
          )
        }
      }

      // Commands a plugin's hooks module registered (`$.command.register`,
      // F-25): served by the plugin, listed under its name. The description
      // is the author's own text, verbatim.
      const modCommands = params.context.options.mods?.listRegisteredCommands?.() ?? []
      if (modCommands.length > 0) {
        parts.push(text(BLOCK), ...title(key('slash.out.helpModsHeading')))
        for (const command of modCommands) {
          parts.push(
            ...section(`/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`),
            ...paragraph(
              key('slash.out.helpModCommand', {
                description: command.description,
                plugin: command.plugin,
              }),
            ),
          )
        }
      }

      parts.push(...paragraph(key('slash.out.helpFooter')))
      return {
        messages: [createLocalizedSystemMessage(options.runtimeConfig, parts)],
        shouldQuery: false,
        resultText: rawInput,
      }
    }

    case 'plugins': {
      const sys = (text: string): ProcessUserInputResult => ({
        messages: [makeNoticeRow(options.runtimeConfig, text)],
        shouldQuery: false,
        resultText: rawInput,
      })

      const trimmed = args.trim()
      if (!trimmed) {
        return {
          messages: [
            createLocalizedSystemMessage(
              options.runtimeConfig,
              buildPluginsListing(options.pluginLoadResult),
            ),
          ],
          shouldQuery: false,
          resultText: rawInput,
        }
      }

      const spaceIndex = trimmed.indexOf(' ')
      const action = (
        spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
      ).toLowerCase()
      const name = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim()

      // `/plugins install <git-url|owner/repo>` — git clone into the project
      // plugins root via the host Bash tool, then enable + live-reload.
      if (action === 'install') {
        if (!name) {
          return sys('Usage: /plugins install <git-url | owner/repo>')
        }
        const browser = params.context.platformCapabilities?.browser
        if (!browser?.callTool) {
          return sys(
            `/plugins install needs the Bash tool (run in the ${getProductName()} host). `
              + 'Alternatively copy a plugin directory into '
              + `<project>/${RUNTIME_DIR_NAME}/plugins/<name>/ and run /plugins enable <name>.`,
          )
        }
        // The project folder, not cwd: a worktree-isolated sub-agent runs in
        // its worktree, but the plugins are the project's (the loader reads
        // `<projectRoot>/.velloc/plugins`).
        const projectRoot = params.context.options.projectRoot
        const cloneUrl = normalizeGitUrl(name)
        const pluginName = pluginNameFromUrl(name)
        // Security gate: refuse a blocklisted plugin before cloning + enabling.
        const blockReason = pluginBlockReason(pluginName)
        if (blockReason) {
          return sys(blockReason)
        }
        const targetDir = joinRuntimePath(getProjectPluginsRoot(projectRoot), pluginName)
        let raw: unknown
        let installedFromLocalFile = false
        const localPluginPath = fileUrlToPath(cloneUrl)
        if (localPluginPath) {
          try {
            installedFromLocalFile = await copyLocalPluginDirectory(
              localPluginPath,
              targetDir,
              fsForContext(params.context),
            )
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return sys(`local plugin copy failed: ${message}`)
          }
        }
        if (!installedFromLocalFile) {
          await mkdirParents(
            dirnameRuntimePath(targetDir),
            fsForContext(params.context),
          )
          try {
            raw = await browser.callTool({
              name: SHELL_TOOL_ID,
              args: {
                // `--` ends option parsing so a clone target that survives shArg
                // quoting but starts with `-` (e.g. `--upload-pack=…`, `-c …`)
                // cannot be read by git as an option (a clone-time exec vector).
                command: `git clone --depth 1 -- ${shArg(cloneUrl)} ${shArg(targetDir)}`,
              },
              executionContext: {
                sessionId: params.context.options.sessionId || undefined,
              },
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return sys(`git clone failed: ${message}`)
          }
          const { output, exitCode } = readBashEnvelope(raw)
          if (exitCode !== 0) {
            return sys(
              `git clone failed (exit ${exitCode}) for ${cloneUrl}:\n${output.trim().slice(0, 500)}`,
            )
          }
        }
        // The allowlist names FOLDERS (`allowlistOf`): the clone's folder is
        // `pluginName`, whatever its manifest calls it.
        const installEnabled = allowlistOf(options.pluginLoadResult?.enabled ?? [])
        const installList = installEnabled.includes(pluginName)
          ? installEnabled
          : [...installEnabled, pluginName]
        try {
          await patchEnabledPlugin(projectRoot, pluginName, true, fsForContext(params.context))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return sys(`Cloned "${pluginName}" but failed to enable it: ${message}`)
        }
        return {
          messages: [
            makeNoticeRow(
              options.runtimeConfig,
              `Installed plugin "${pluginName}" from ${cloneUrl} into `
                + `${RUNTIME_DIR_NAME}/plugins/ and enabled it. Reloaded skills, agents, and `
                + 'hooks. MCP servers apply on the next session reload.',
            ),
          ],
          shouldQuery: false,
          action: 'reload-plugins',
          enabledPlugins: installList,
          resultText: rawInput,
        }
      }

      // `/plugins uninstall <name>` — remove the plugin directory (fs.rm),
      // drop it from the enabled list, and reload. Works without the Bash
      // tool (fs.rm is available in every host).
      if (action === 'uninstall') {
        if (!name) {
          return sys('Usage: /plugins uninstall <name>')
        }
        const pl = options.pluginLoadResult
        const plugin = [
          ...(pl?.enabled ?? []),
          ...(pl?.disabled ?? []),
        ].find(p => p.name === name)
        if (!plugin) {
          return sys(`Unknown plugin "${name}". Run /plugins to see what's installed.`)
        }
        try {
          await fsForContext(params.context).rm(plugin.path, {
            recursive: true,
            force: true,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return sys(`Failed to remove ${plugin.path}: ${message}`)
        }
        const folder = allowlistNameOf(plugin)
        const remaining = allowlistOf(pl?.enabled ?? []).filter(n => n !== folder)
        try {
          if (folder) {
            if (plugin.source.startsWith('user:') && options.settingsHomeDir) {
              await patchUserEnabledPlugin(options.settingsHomeDir, folder, false, fsForContext(params.context))
            }
            await patchEnabledPlugin(
              params.context.options.projectRoot,
              folder,
              false,
              fsForContext(params.context),
            )
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return sys(`Removed "${name}" but failed to update the enabled list: ${message}`)
        }
        return {
          messages: [
            makeNoticeRow(
              options.runtimeConfig,
              `Uninstalled plugin "${name}" (removed ${plugin.path}). `
                + 'Reloaded skills, agents, and hooks.',
            ),
          ],
          shouldQuery: false,
          action: 'reload-plugins',
          enabledPlugins: remaining,
          resultText: rawInput,
        }
      }

      // `/plugins update <name>` — `git -C <dir> pull` via the host Bash tool,
      // then reload to pick up the new content. The enabled set is unchanged.
      if (action === 'update') {
        if (!name) {
          return sys('Usage: /plugins update <name>')
        }
        const pl = options.pluginLoadResult
        const plugin = [
          ...(pl?.enabled ?? []),
          ...(pl?.disabled ?? []),
        ].find(p => p.name === name)
        if (!plugin) {
          return sys(`Unknown plugin "${name}". Run /plugins to see what's installed.`)
        }
        const browser = params.context.platformCapabilities?.browser
        if (!browser?.callTool) {
          return sys(`/plugins update needs the Bash tool (run in the ${getProductName()} host).`)
        }
        let raw: unknown
        try {
          raw = await browser.callTool({
            name: SHELL_TOOL_ID,
            args: { command: `git -C ${shArg(plugin.path)} pull --ff-only` },
            executionContext: {
              sessionId: params.context.options.sessionId || undefined,
            },
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return sys(`git pull failed: ${message}`)
        }
        const { output, exitCode } = readBashEnvelope(raw)
        if (exitCode !== 0) {
          return sys(
            `git pull failed (exit ${exitCode}) for "${name}":\n${output.trim().slice(0, 500)}`,
          )
        }
        return {
          messages: [
            makeNoticeRow(
              options.runtimeConfig,
              `Updated plugin "${name}":\n${output.trim().slice(0, 300)}\n`
                + 'Reloaded skills, agents, and hooks.',
            ),
          ],
          shouldQuery: false,
          action: 'reload-plugins',
          enabledPlugins: allowlistOf(pl?.enabled ?? []),
          resultText: rawInput,
        }
      }

      if (action !== 'enable' && action !== 'disable') {
        return sys(
          'Usage: /plugins [enable <name> | disable <name> | '
            + 'install <git-url> | update <name> | uninstall <name>]',
        )
      }
      if (!name) {
        return sys(`Usage: /plugins ${action} <name>`)
      }

      // Match by manifest name OR by full marketplace identifier so a user can
      // toggle a marketplace plugin via either form.
      const findIn = (scan: PluginScan | undefined) =>
        [...(scan?.enabled ?? []), ...(scan?.disabled ?? [])].find(
          p => p.name === name || p.installIdentifier === name,
        )
      let result = options.pluginLoadResult
      let matched = findIn(result)
      // A plugin folder copied in after this session loaded is not in its
      // snapshot: look on disk again before calling the name unknown.
      if (!matched && options.rescanPlugins) {
        try {
          result = await options.rescanPlugins()
          matched = findIn(result)
        } catch {
          // The snapshot stands; the name is reported unknown below.
        }
      }
      const enabledNames = allowlistOf(result?.enabled ?? [])
      const allLoaded = [
        ...(result?.enabled ?? []),
        ...(result?.disabled ?? []),
      ]
      if (!matched) {
        const discovered = allLoaded.map(p => p.name)
        return sys(
          `Unknown plugin "${name}".`
            + (discovered.length > 0
              ? ` Discovered: ${discovered.join(', ')}.`
              : ' No plugins discovered.'),
        )
      }

      const wantEnable = action === 'enable'
      const isEnabled = matched.enabled === true
      if (wantEnable && isEnabled) {
        return sys(`Plugin "${name}" is already enabled.`)
      }
      if (!wantEnable && !isEnabled) {
        return sys(`Plugin "${name}" is already disabled.`)
      }

      // Route by store: a MARKETPLACE plugin (carries an install identifier)
      // lives in the settings `enabledPlugins` map (keyed by `<name>@<mkt>`),
      // NOT the legacy `enabled-plugins.json` directory-name allowlist; marketplace
      // plugins are enabled and disabled on the settings map. The legacy
      // (bare-dir) plugins stay on the PATCHED enabled-store. Either way the
      // live reload re-reads BOTH stores, so we hand back the current legacy
      // enabled set as the directory-walk allowlist.
      let reloadAllowlist = enabledNames
      // What a directory plugin is enabled by: its folder (`allowlistNameOf`).
      const folder = allowlistNameOf(matched) ?? matched.name
      try {
        if (matched.installIdentifier) {
          const homeDir = options.settingsHomeDir
          if (!homeDir) {
            return sys(
              `Cannot ${action} "${name}": managing a marketplace plugin needs `
                + `the settings home directory (run in the ${getProductName()} host).`,
            )
          }
          await setPluginEnabled(
            { homeDir },
            fsForContext(params.context),
            matched.installIdentifier,
            wantEnable,
          )
        } else if (
          matched.source.startsWith('user:')
          && options.settingsHomeDir
        ) {
          // USER-scope plugin (`~/.velloc/plugins/<name>/`): persist to the
          // user allowlist so the choice holds in every session, not just
          // the folder this one happens to be anchored at. The reload
          // allowlist is the union of both scopes — the same rule
          // `loadEffectiveEnabledPlugins` applies at boot.
          const userList = await patchUserEnabledPlugin(
            options.settingsHomeDir,
            folder,
            wantEnable,
            fsForContext(params.context),
          )
          const projectList =
            (await loadEnabledPlugins(
              params.context.options.projectRoot,
              fsForContext(params.context),
            )) ?? []
          reloadAllowlist = [...new Set([...userList, ...projectList])]
          // A disable has to win over a stale project-scope entry of the
          // same name, otherwise the union would re-enable it immediately.
          if (!wantEnable) {
            reloadAllowlist = reloadAllowlist.filter(n => n !== folder)
          }
        } else {
          reloadAllowlist = await patchEnabledPlugin(
            params.context.options.projectRoot,
            folder,
            wantEnable,
            fsForContext(params.context),
          )
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return sys(`Failed to persist plugin change: ${message}`)
      }

      return {
        messages: [
          makeNoticeRow(
            options.runtimeConfig,
            `Plugin "${name}" ${action}d. Reloaded skills, agents, and hooks. `
              + 'MCP server changes apply on the next session reload.',
          ),
        ],
        shouldQuery: false,
        action: 'reload-plugins',
        enabledPlugins: reloadAllowlist,
        resultText: rawInput,
      }
    }

    case 'plugin': {
      // `/plugin` (singular) — the command for the MARKETPLACE
      // install pipeline. Coexists with `/plugins` (plural) above which
      // keeps the legacy project-scoped git-clone flow. Routes every
      // subcommand into `pluginMarketplaceCommands.handlePluginSlashCommand`
      // and wraps the returned parts in a localized system message.
      const pluginParts = await handlePluginSlashCommand(args, {
        runtimeConfig: options.runtimeConfig,
        fs: fsForContext(params.context),
        homeDir: options.settingsHomeDir,
        fetchImpl: options.marketplaceFetch,
      })
      // install / enable / disable / uninstall mutate plugin state on
      // disk (settings `enabledPlugins` map + install registry). Emit the
      // same live-reload signal the plural `/plugins` path uses so the change
      // activates without a session restart. `onReloadPlugins` re-reads both
      // the settings map AND the install registry, so we only need to pass the
      // current legacy directory-walk allowlist (omitting it would reload with
      // an empty allowlist and disable every legacy plugin).
      const pluginSub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      const pluginMutates =
        pluginSub === 'install'
        || pluginSub === 'uninstall'
        || pluginSub === 'enable'
        || pluginSub === 'disable'
      if (pluginMutates) {
        return {
          messages: [createLocalizedSystemMessage(options.runtimeConfig, pluginParts)],
          shouldQuery: false,
          action: 'reload-plugins',
          enabledPlugins: allowlistOf(options.pluginLoadResult?.enabled ?? []),
          resultText: rawInput,
        }
      }
      return {
        messages: [createLocalizedSystemMessage(options.runtimeConfig, pluginParts)],
        shouldQuery: false,
        resultText: rawInput,
      }
    }

    case 'marketplace': {
      // `/marketplace` — manage the registry of marketplaces the
      // install pipeline pulls from. Default-installed officials
      // (claude-plugins-official + claude-plugins-community) are
      // pre-seeded so `/marketplace list` always has at least two
      // entries from a fresh install.
      const marketplaceParts = await handleMarketplaceSlashCommand(args, {
        runtimeConfig: options.runtimeConfig,
        fs: fsForContext(params.context),
        homeDir: options.settingsHomeDir,
        fetchImpl: options.marketplaceFetch,
      })
      return {
        messages: [createLocalizedSystemMessage(options.runtimeConfig, marketplaceParts)],
        shouldQuery: false,
        resultText: rawInput,
      }
    }

    case 'mcp':
      // Jump to the host MCP settings page — the trusted native surface
      // where servers (and their secrets) are configured. `action:
      // 'open-settings'` makes the QueryEngine call the `ui.openNexusSettings`
      // bridge action; the system message is the in-thread confirmation for
      // hosts that can't open settings (mock / dev), where the action is a
      // no-op. Any args are ignored — `/mcp` has a single behavior.
      return {
        messages: [
          createLocalizedSystemMessage(options.runtimeConfig, [
            key('slash.out.mcpOpening'),
          ]),
        ],
        shouldQuery: false,
        resultText: rawInput,
        action: 'open-settings',
        settingsSection: 'mcp',
      }

    case 'tabs': {
      const snapshot = await options.hostBridge.getBrowserContextSnapshot({
        includeDomSnapshot: false,
        includeAccessibilitySnapshot: false,
      })
      const tabs = snapshot.tabs
      // Only the two placeholders are prose. The row itself is a machine-ish
      // record — `[active] host_tab_id=… <url>` — whose field names are
      // protocol the model and the user both read literally.
      const untitled = renderPartsEnglish([key('slash.out.tabUntitled')])
      const noUrl = renderPartsEnglish([key('slash.out.tabNoUrl')])
      const parts: SystemMessagePart[] =
        tabs.length === 0
          ? [key('slash.out.noTabs')]
          : [
              text(
                tabs
                  .map(tab => {
                    const state = tab.active ? 'active' : 'background'
                    const tabId = `host_tab_id=${tab.id}`
                    const windowId = tab.windowId
                      ? ` host_window_id=${tab.windowId}`
                      : ''
                    return `[${state}] ${tabId}${windowId} ${tab.title ?? untitled} <${tab.url ?? noUrl}>`
                  })
                  .join('\n'),
              ),
            ]
      return {
        messages: [
          createLocalizedSystemMessage(options.runtimeConfig, parts),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }
    }

    case 'context':
      return {
        messages: [
          makeContextRow(
            options.runtimeConfig,
            await createBrowserContextAttachment(options.hostBridge),
          ),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }

    case 'clear':
      // Side-effect signal `action: 'clear'` tells QueryEngine to wipe
      // the transcript + per-engine state (and start a new chain in the
      // conversation store) before this result is recorded: the "/clear"
      // echo and this system message are the first rows of the new
      // conversation.
      return {
        messages: [
          createLocalizedSystemMessage(options.runtimeConfig, [
            key('slash.out.cleared'),
          ]),
        ],
        shouldQuery: false,
        resultText: rawInput,
        action: 'clear',
      }

    case 'rename': {
      // `/rename [name]`. With a name → rename now; no
      // arg → auto-generate via the fast model (see proposeSessionTitle). The
      // `action: 'rename'` signal makes QueryEngine persist the title (as a
      // dedicated `custom-title` entry) before this confirmation is recorded,
      // so the sidebar refresh broadcasts the new title.
      let title = args.trim()
      if (!title) {
        const generated = await proposeSessionTitle(
          params.context.messages ?? params.messages ?? [],
          params.context,
        )
        if (!generated) {
          return {
            messages: [
              createLocalizedSystemMessage(options.runtimeConfig, [
                key('slash.out.renameUsage'),
              ]),
            ],
            shouldQuery: false,
            resultText: rawInput,
          }
        }
        title = generated
      }
      return {
        messages: [
          createLocalizedSystemMessage(options.runtimeConfig, [
            key('slash.out.renamed', { title }),
          ]),
        ],
        shouldQuery: false,
        resultText: rawInput,
        action: 'rename',
        renameTitle: title,
      }
    }

    case 'model':
      if (args) {
        const [providerId, ...modelParts] = args.split(/\s+/).filter(Boolean)
        const model = modelParts.join(' ')
        if (providerId && model) {
          return {
            messages: [
              createLocalizedSystemMessage(options.runtimeConfig, [
                // Provider and model ids are matched by string equality
                // everywhere — never translated, never reordered.
                key('slash.out.modelSwitched', {
                  model: `${providerId} ${model}`,
                }),
              ]),
            ],
            shouldQuery: false,
            resultText: rawInput,
            providerId,
            model,
          }
        }

        return {
          messages: [
            createLocalizedSystemMessage(options.runtimeConfig, [
              key('slash.out.modelSwitched', { model: args }),
            ]),
          ],
          shouldQuery: false,
          resultText: rawInput,
          model: args,
        }
      }
      return {
        messages: [
          createLocalizedSystemMessage(options.runtimeConfig, [
            key('slash.out.modelUsage'),
          ]),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }

    case 'autocompact':
      return runAutoCompactCommand(
        args,
        rawInput,
        options.runtimeConfig,
        params.context,
      )

    case 'compact':
      // Side-effect signal `action: 'compact'` tells QueryEngine to run
      // a synchronous compaction pass over the current transcript and
      // inject the resulting boundary + summary messages. Optional
      // trailing text becomes `compactInstructions`, appended verbatim
      // to the compact prompt (`/compact [instructions]`).
      return {
        messages: [],
        shouldQuery: false,
        resultText: rawInput,
        action: 'compact',
        ...(args ? { compactInstructions: args } : {}),
      }

    case 'plan': {
      // Invoke the EnterPlanMode tool directly so the slash path and the
      // model-invoked tool path share the same state mutation + plan
      // directory bootstrap. Validation guards: not-in-subagent, not
      // already in plan mode. `canUseTool` / parent message are unused by
      // the tool body — passed as stubs to satisfy the Tool.call shape.
      const validation = await PlanOnTool.checkInput!(
        {},
        params.context,
      )
      if (!validation.result) {
        return {
          messages: [
            makeNoticeRow(
              options.runtimeConfig,
              `Cannot enter plan mode: ${validation.message}`,
            ),
          ],
          shouldQuery: false,
          resultText: rawInput,
        }
      }
      const result = await PlanOnTool.call(
        {},
        params.context,
        SLASH_DISPATCH_CAN_USE_TOOL,
        makeUserRow(options.runtimeConfig, ''),
      )
      // `data` is now the prose instructions string. The
      // previous `{message, previousMode}` dict shape was replaced
      // with a single string — see EnterPlanModeOutput.
      return {
        messages: [
          makeNoticeRow(options.runtimeConfig, result.data ?? ''),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }
    }

    case 'exit-plan': {
      // Optional trailing text becomes the plan body (persisted to the
      // session plan file). When omitted, ExitPlanMode falls back to the
      // existing plan file if one exists.
      const planArg = args || undefined
      const validation = await ExitPlanModeTool.checkInput!(
        { plan: planArg },
        params.context,
      )
      if (!validation.result) {
        return {
          messages: [
            makeNoticeRow(
              options.runtimeConfig,
              `Cannot exit plan mode: ${validation.message}`,
            ),
          ],
          shouldQuery: false,
          resultText: rawInput,
        }
      }
      const result = await ExitPlanModeTool.call(
        { plan: planArg },
        params.context,
        SLASH_DISPATCH_CAN_USE_TOOL,
        makeUserRow(options.runtimeConfig, ''),
      )
      // `data` is now the prose result string. The
      // previous `{plan, planFilePath, planWasWritten, restoredMode,
      // isAgent}` dict shape was replaced with a single string — see
      // ExitPlanModeOutput. The user-visible system message becomes
      // the same prose the model would have seen.
      return {
        messages: [
          makeNoticeRow(options.runtimeConfig, result.data ?? ''),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }
    }

    case 'cost': {
      // Walk the in-context transcript and report per-model token usage +
      // best-effort USD. No bridge call — the usage blocks are already on the
      // assistant messages (same data the context indicator reads).
      const report = formatCostReport(
        accumulateSessionUsage(params.context.messages),
      )
      return {
        messages: [createLocalizedSystemMessage(options.runtimeConfig, report)],
        shouldQuery: false,
        resultText: rawInput,
      }
    }

    case 'status': {
      const session = await options.hostBridge.describeHostSession()
      // The placeholder words are catalog entries too: "unknown" and "none"
      // are prose a user reads, not values the host sends.
      const unknown = renderPartsEnglish([key('slash.out.statusUnknown')])
      const none = renderPartsEnglish([key('slash.out.statusNone')])
      return {
        messages: [
          createLocalizedSystemMessage(
            options.runtimeConfig,
            bulletLines([
              key('slash.out.statusBrowser', {
                browser:
                  `${session.browserName ?? unknown} ${session.browserVersion ?? ''}`.trim(),
              }),
              key('slash.out.statusTabs', { count: session.tabCount ?? 0 }),
              key('slash.out.statusActiveTab', {
                id: session.activeTabId ?? none,
              }),
              key('slash.out.statusLocale', {
                locale: session.locale ?? unknown,
              }),
              key('slash.out.statusTimezone', {
                timezone: session.timezone ?? unknown,
              }),
            ]),
          ),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }
    }

    // The four read-only introspection listings. Each is a pure function of
    // state the dispatcher already holds (see `introspectionCommands.ts`) —
    // no bridge call, no fs read, no mutation. Args are ignored: these
    // commands have a single behavior, matching `/mcp` and `/context`.
    case 'agents':
      return {
        messages: [
          createLocalizedSystemMessage(
            options.runtimeConfig,
            buildAgentsListing(params.context.options.agentDefinitions),
          ),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }

    case 'skills':
      return {
        messages: [
          createLocalizedSystemMessage(
            options.runtimeConfig,
            // Both halves of one load: `options.commands` and the path-gated
            // `getConditionalSkills()`, filtered here by this session's `skills:` allowlist
            // (the map is module-global).
            buildSkillsListing(
              params.context.options.commands,
              getConditionalSkills().filter(
                command =>
                  templateAllowsSkill(
                    params.context.options.templateType
                      ? getTemplate(params.context.options.templateType)?.config
                      : undefined,
                    command,
                  )
                  // Same reason as the allowlist: the map is module-global,
                  // so a co-resident session's type-restricted path-gated
                  // skill must not be listed as this one's.
                  && resolveInvocationForSession(
                    command,
                    params.context.options.templateType,
                  ).present,
              ),
            ),
          ),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }

    case 'hooks':
      return {
        messages: [
          createLocalizedSystemMessage(
            options.runtimeConfig,
            buildHooksListing(
              params.context.readAppState?.(),
              params.context.options.sessionId,
            ),
          ),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }

    case 'permissions':
      return {
        messages: [
          createLocalizedSystemMessage(
            options.runtimeConfig,
            buildPermissionsListing(params.context.readAppState?.()),
          ),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }

    default:
      return {
        messages: [
          unknownCommandMessage(
            options.runtimeConfig,
            command,
            supportedSlashCommands,
          ),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }
  }
}
