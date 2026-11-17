import { setProductNameOverride } from '../../branding/productName'
import type { ConversationEngine } from '../../engine/conversationEngine'
import { setSessionModelSettingsSnapshot } from '../../models/tierSettingsSnapshot'
import { findShadowedRules } from '../../permissions/ruleEngine'
import {
  applyPermissionRulesBySource,
  type PermissionSettingsBySource,
} from '../../permissions/seedPermissionContext'
import { resolveOutputStyleSection } from '../../prompting/responseStyles'
import type { WorkingState } from '../../runtime/RuntimeTypes'
import { loadEffectiveSettings, readUserLayer } from '../../settings/settingsStore'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { applyPersistedInternalUser } from '../../utils/internalUser'
import { buildProfilePromptBlock } from '../context/buildProfilePromptBlock'

/** The settings.json overlays a session reads at boot; each read failure is non-fatal. */
export type SettingsOverlayInput = {
  settingsHome: () => string
  installedFs: RuntimeFs
}

/** The part of the runtime's core state the overlays read and seed. */
export type SettingsOverlayState = {
  options: { projectRoot?: string; appendSystemPrompt?: string }
  getAppState: () => WorkingState
  setAppState: (updater: (prev: WorkingState) => WorkingState) => void
}

/**
 * The system-prompt suffix: the caller's, with the settings reply style before it and the `profile`
 * block after it. Also seeds the permission rules per settings source before the engine starts.
 */
export async function buildSettingsPromptSuffix({
  coreState,
  settingsHome,
  installedFs,
  permissionSettings,
}: SettingsOverlayInput & {
  coreState: SettingsOverlayState
  permissionSettings: Promise<PermissionSettingsBySource>
}): Promise<string | undefined> {
  let effectiveAppendSystemPrompt = coreState.options.appendSystemPrompt
  try {
    // First adopter of the settings source hierarchy (gap #3): merge
    // user/project/local so a project's `.velloc/settings.json` can contribute
    // profile / output-style / permission rules. With only a user file present
    // this is identical to the old single-source `readUserLayer`.
    const { settings } = await loadEffectiveSettings(
      { homeDir: settingsHome(), projectRoot: coreState.options.projectRoot },
      installedFs,
    )
    const profileBlock = buildProfilePromptBlock(settings.profile)
    if (profileBlock) {
      effectiveAppendSystemPrompt = effectiveAppendSystemPrompt
        ? `${effectiveAppendSystemPrompt}\n\n${profileBlock}`
        : profileBlock
    }
    // Reply style: prepend the active style's `# Reply style:` block (before
    // the profile block) so the persona frames the rest of the addendum. Read
    // from the same settings.json; default / unknown style → no block.
    const outputStyleBlock = resolveOutputStyleSection(settings.outputStyle)
    if (outputStyleBlock) {
      effectiveAppendSystemPrompt = effectiveAppendSystemPrompt
        ? `${outputStyleBlock}\n\n${effectiveAppendSystemPrompt}`
        : outputStyleBlock
    }
    // Seed permission rules per settings source, the default mode, `additionalWorkingDirectories`
    // and the `disableBypassPermissionsMode` killswitch BEFORE the engine starts. No block → allow-all.
    const permissionsBySource = await permissionSettings
    if (permissionsBySource.some(entry => entry.permissions)) {
      coreState.setAppState(prev => ({
        ...prev,
        permissionRules: applyPermissionRulesBySource(
          prev.permissionRules,
          permissionsBySource,
        ),
      }))
      // Shadowed-rule warning (spec 5-5-8 — also listed in the
      // /permissions panel). With ask out-ranking allow (the rule order), an
      // allow rule under a broader ask/deny rule can never fire — the classic
      // case being "Always allow" persisting a rule that a configured
      // whole-tool `ask` keeps shadowing, so the prompt returns every session.
      // Diagnostics only; never fatal.
      try {
        for (const shadowed of findShadowedRules(
          coreState.getAppState().permissionRules,
        )) {
          console.warn(`[permissions] ${shadowed.reason} ${shadowed.fix}`)
        }
      } catch {
        /* diagnostics only */
      }
    }
  } catch {
    /* keep the caller's appendSystemPrompt — non-fatal, same as the agent overlay */
  }
  return effectiveAppendSystemPrompt
}

/**
 * Sub-session model routing (Settings → Session models): seed this realm's snapshot so the
 * pure tier helpers in engine/contextWindow.ts see the user's settings — the seam's contract
 * is "no caller changes", hence a realm snapshot instead of threading. Live updates land via
 * `QueryEngine.applySessionModelSettings` (worker.applyRuntimeSettings). Non-fatal: on failure
 * the helpers keep the built-in ladder/census. `mods.headless` rides the same read (F-25 debt 7).
 */
export async function seedSessionModelSettings({
  coreState,
  settingsHome,
  installedFs,
}: SettingsOverlayInput & { coreState: SettingsOverlayState }): Promise<boolean> {
  let headlessMods = false
  try {
    const { settings } = await loadEffectiveSettings(
      { homeDir: settingsHome(), projectRoot: coreState.options.projectRoot },
      installedFs,
    )
    setSessionModelSettingsSnapshot({
      modelTiers: settings.modelTiers,
      sessionModelPolicy: settings.sessionModelPolicy,
    })
    headlessMods = settings.mods?.headless === true
  } catch {
    /* non-fatal — built-in ladder/census apply */
  }
  return headlessMods
}

/**
 * settings.json's `agent` overlay: the product-name override, internal-user
 * mode, and a persisted `agent.maxTurns`, applied to sub-agent runtimes only
 * (a main UI session keeps its fixed cap).
 *
 * Failure is non-fatal — if settings.json is missing, malformed, or
 * the file read errors out, the engine keeps the constructor values.
 */
export async function applyAgentSettingsOverlay({
  settingsHome,
  installedFs,
  options,
  engine,
}: SettingsOverlayInput & {
  options: { isSubAgent?: boolean }
  engine: Pick<ConversationEngine, 'applyRuntimeSettings'>
}): Promise<void> {
  try {
    const homeDir = settingsHome()
    const { settings } = await readUserLayer(homeDir, installedFs)
    const agent = settings.agent
    // Restore the persisted `/debug name` product-name override. Module
    // state in this realm is lost on worker restart; settings.json is the
    // source of truth (absent key ⇒ build brand), so assign unconditionally
    // rather than only-when-present — a cleared key must also clear a stale
    // in-memory override.
    setProductNameOverride(agent?.productNameOverride)
    // Internal-user mode (`/debug internal`) is EXTERNAL unless settings.json
    // says otherwise. Applied only when the persisted value CHANGED since the
    // last boot applied it: every runtime boot (each background sub-agent
    // included) runs this, and an unconditional assign reverted an unsaved
    // `/debug internal` flip at the next agent spawn.
    applyPersistedInternalUser(agent?.internalUser === true)
    if (options.isSubAgent === true && agent && agent.maxTurns !== undefined) {
      engine.applyRuntimeSettings({ maxTurns: agent.maxTurns })
    }
  } catch (e) {
    console.warn(
      `[createBrowserRuntime] agent settings overlay skipped: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}
