/**
 * Bundled-skills entry point. `installStockSkills()` is idempotent and is called
 * by `loadLocalPromptCommands` before reading the registry.
 */

import { registerArenaTeamSkill } from './arenaTeam'
import { addFanoutSkill } from './batchSkill'
import { registerCommitSkill } from './commitSkill'
import { addDiagnoseSkill } from './debugSkill'
import { registerTidyMemorySkill } from './tidyMemory'
import { registerE2eThrowSkill } from './e2eThrow'
import { registerInitSkill } from './initSkill'
import { addRepeatSkill } from './loopSkill'
import { registerReviewSkill } from './reviewSkill'
import { registerSafeTeamSkill } from './safeTeam'
import { registerSecurityReviewSkill } from './securityReview'
import { addCleanupSkill } from './simplifySkill'
import { addConfigEditSkill } from './updateConfigSkill'

let initialized = false

export function installStockSkills(): void {
  if (initialized) return
  initialized = true
  // `addStockSkill` with `default:` also registers a `bundled-skills.<name>`
  // feature, so this one pass fills both registries.
  addCleanupSkill()
  // Team-only walkthroughs; hidden from every other session type.
  registerSafeTeamSkill()
  registerArenaTeamSkill()
  addFanoutSkill()
  addDiagnoseSkill()
  registerTidyMemorySkill()
  addConfigEditSkill()
  // Always-on (no `default`, so no Features-page toggle): `/loop` is a thin
  // front-end for the routine tools, which are themselves unconditional.
  addRepeatSkill()
  // Prompt-type slash commands, shipped as slash-only bundled skills.
  registerInitSkill()
  registerReviewSkill()
  registerSecurityReviewSkill()
  registerCommitSkill()
  // E2E-only test fixture (see e2eThrow.ts). `loadLocalPromptCommands` gates it
  // out of every non-e2e command list, so registering it here is inert in
  // production.
  registerE2eThrowSkill()
}

/** Test-only — re-enable init so subsequent calls run again. */
export function __resetBundledSkillsInitForTests(): void {
  initialized = false
}
