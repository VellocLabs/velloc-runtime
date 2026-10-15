/**
 * Bundled `tidy-memory` skill: the manual memory-consolidation pass, sharing its
 * prompt with the background service. Targets the configured memory directory
 * and the project's session transcripts. Env-var memory overrides are not
 * applied here.
 */

import {
  defaultMemoryDir,
  joinPath,
  checkNotesDir,
  type ResolvedMemorySettings,
} from '../../memory/memoryPaths'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { projectHomeFor } from '../../utils/conversationStoragePaths'
import { composeTidyBrief } from '../../memory/consolidate/consolidatorPrompt'
import { addStockSkill } from '../builtinSkills'

/** Memory directory the pass targets: the `autoMemoryDirectory` setting, else
 *  `defaultMemoryDir`. Env-var overrides are not applied. */
function defaultMemoryRoot(
  cwd: string,
  projectRoot?: string,
  homeDir?: string,
  memorySettings?: ResolvedMemorySettings,
): string {
  const autoDir = checkNotesDir(memorySettings?.autoMemoryDirectory, {
    expandTilde: true,
    homeDir,
  })
  if (autoDir) return autoDir
  return defaultMemoryDir({ cwd, projectRoot, homeDir })
}

/** Session-transcripts root the consolidation grep targets. Transcripts live at
 *  the grouped per-project dir `<configHome>/projects/<projectFolderKey(projectRoot)>/
 *  <sessionId>/transcript.jsonl` (`getConversationTranscriptPath`), so we point
 *  the grep at that project dir — the base the background service passes
 *  as `deps.historyFolder`. With no host-resolved home (worker env), fall back
 *  to the legacy conventional base `${cwd}/.velloc/sessions/`. */
function defaultTranscriptDir(
  cwd: string,
  projectRoot?: string,
  homeDir?: string,
): string {
  if (homeDir) {
    return `${projectHomeFor(homeDir, projectRoot ?? cwd)}/`
  }
  return `${joinPath(cwd, RUNTIME_DIR_NAME, 'sessions')}/`
}

export function registerTidyMemorySkill(): void {
  addStockSkill({
    name: 'tidy-memory',
    description:
      'Reflective pass over your memory files — merge new signal into durable memories, update the index, prune what drifted. Useful when a session has accumulated material worth persisting.',
    useWhen:
      'When the user wants to consolidate what they\'ve learned in recent sessions into long-term memory, prune stale notes, or update the MEMORY.md index. Run after substantive work; not for every turn.',
    argumentHint: '[extra context]',
    // A regular bundled skill, slash-only like /debug since it's
    // user-driven self-introspection.
    modelInvocation: [],
    // Auto-registers feature `bundled-skills.tidy-memory`.
    default: false,
    featureTitle: 'Tidy memory',
    featureDescription:
      'Adds /tidy-memory — reflective pass over your memory files; merges new signal into durable memories, prunes the index.',
    // `/tidy-memory` only where consolidation has something to consolidate: the
    // reflective-pass prompt assumes a session that has accumulated memory
    // + transcript history, and it shells out (`Bash`) to grep transcripts.
    // `agent`, `code` and `team` build that up and carry the `shell` group;
    // `chat` is intentionally lightweight and only defers shell. The old
    // `type:` list said exactly this but gated only the model surface,
    // which `hiddenFromModel` had already closed — so `/tidy-memory` was
    // offered in chat regardless.
    userInvocation: ['agent', 'code', 'team'],
    // Memory consolidation needs to read and write memory files + grep
    // session transcripts.
    permittedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
    dynamicContent: async (args, context) => {
      const cwd = context.options.cwd
      const projectRoot = context.options.projectRoot
      const homeDir = context.options.homeDir
      const memoryRoot = defaultMemoryRoot(
        cwd,
        projectRoot,
        homeDir,
        context.options.memorySettings,
      )
      const historyFolder = defaultTranscriptDir(cwd, projectRoot, homeDir)
      return composeTidyBrief(memoryRoot, historyFolder, args.trim())
    },
  })
}
