import { joinRuntimePath } from './runtimePaths'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'

const TRANSCRIPT_FILE_NAME = 'transcript.jsonl'
const META_FILE_NAME = 'meta.json'
/** The retired ≤3-line JSONL sidecar `meta.json` replaced. Read ONCE by the
 *  migration to seed `meta.json`, then deleted; never written. */
const LEGACY_META_SIDECAR_FILE_NAME = 'meta.jsonl'
/**
 * The ONE SQLite database holding every session's `SessionMetaFile` projection
 * (one row per session), replacing the per-session `meta.json` files. Lives at
 * the projects root (`~/.velloc/projects/sessions.sqlite`) in the grouped
 * layout, or the flat base in the fallback layout — see `getSessionMetaDbPath`.
 */
const SESSION_META_DB_FILE_NAME = 'sessions.sqlite'
const TOOL_DETAIL_DIR_NAME = 'tool-details'
const TASK_OUTPUT_DIR_NAME = 'tasks'
const SCRATCHPAD_DIR_NAME = 'scratch'
/** Per-session sidecar holding the Skills-tab invocation event log
 *  (`SkillInvocationEvent[]`), so the loaded/failed history survives
 *  a process restart. A sibling of `transcript.jsonl` / `meta.json`, cleaned up
 *  with the session dir on delete. See `getConversationSkillEventsPath`. */
const SKILL_EVENTS_FILE_NAME = 'skill-events.json'

function encodeToolCallFileName(toolCallId: string): string {
  return `${encodeURIComponent(toolCallId)}.json`
}

export function getConversationSessionDirectoryPath(
  basePath: string,
  sessionId: string,
): string {
  return joinRuntimePath(basePath, sessionId)
}

export function getConversationTranscriptPath(
  basePath: string,
  sessionId: string,
): string {
  return joinRuntimePath(
    getConversationSessionDirectoryPath(basePath, sessionId),
    TRANSCRIPT_FILE_NAME,
  )
}

/**
 * The session's `meta.json` (`SessionMetaFile`): the projection the session list
 * reads, never opening a transcript. Authoritative for fields the transcript does
 * not carry; reconciled against it on open, so a torn or missing file is rebuilt.
 * Written by truncate-and-rewrite (`atomic` where supported).
 */
export function getConversationMetaPath(
  basePath: string,
  sessionId: string,
): string {
  return joinRuntimePath(
    getConversationSessionDirectoryPath(basePath, sessionId),
    META_FILE_NAME,
  )
}

/**
 * The retired `meta.jsonl` sidecar: a ≤3-line
 * mirror of the transcript's `custom-title` / `ai-title` / `__session_meta`
 * records. The one-time migration reads it as the preferred seed for
 * `meta.json` (it always held the complete title set) and then removes it.
 */
export function getLegacyConversationMetaSidecarPath(
  basePath: string,
  sessionId: string,
): string {
  return joinRuntimePath(
    getConversationSessionDirectoryPath(basePath, sessionId),
    LEGACY_META_SIDECAR_FILE_NAME,
  )
}

/**
 * The session's `skill-events.json` — the persisted Skills-tab invocation event
 * log (`SkillInvocationEvent[]`). Restart recovery reads it back into the
 * realm-global `skillInvocationLog` on session open so the per-invocation
 * loaded/failed history (which the transcript alone cannot
 * reconstruct — a failed invocation injects no message, a duplicate a
 * note-first one) reappears with its real status/time/size/error.
 */
export function getConversationSkillEventsPath(
  basePath: string,
  sessionId: string,
): string {
  return joinRuntimePath(
    getConversationSessionDirectoryPath(basePath, sessionId),
    SKILL_EVENTS_FILE_NAME,
  )
}

export function getConversationToolDetailsDirectoryPath(
  basePath: string,
  sessionId: string,
): string {
  return joinRuntimePath(
    getConversationSessionDirectoryPath(basePath, sessionId),
    TOOL_DETAIL_DIR_NAME,
  )
}

export function getConversationToolDetailPath(
  basePath: string,
  sessionId: string,
  toolCallId: string,
): string {
  return joinRuntimePath(
    getConversationToolDetailsDirectoryPath(basePath, sessionId),
    encodeToolCallFileName(toolCallId),
  )
}

export function getTaskOutputDirectoryPath(
  basePath: string,
  sessionId: string,
): string {
  return joinRuntimePath(
    getConversationSessionDirectoryPath(basePath, sessionId),
    TASK_OUTPUT_DIR_NAME,
  )
}

export function taskLogFile(
  basePath: string,
  sessionId: string,
  taskId: string,
): string {
  return joinRuntimePath(
    getTaskOutputDirectoryPath(basePath, sessionId),
    `${taskId}.output`,
  )
}

/**
 * Per-session scratchpad directory (the permission check `inFreeWriteDir`
 * in `permissions/filesystemPermission.ts` admits writes here). A writable
 * area for the agent's throwaway/intermediate files (drafts, analysis output,
 * temp data) that should never trigger a permission prompt. Lives at
 * `<sessionDir>/scratch/`.
 */
export function getScratchpadDirectoryPath(
  basePath: string,
  sessionId: string,
): string {
  return joinRuntimePath(
    getConversationSessionDirectoryPath(basePath, sessionId),
    SCRATCHPAD_DIR_NAME,
  )
}

/**
 * The base a RUNNING session's own directory lives under. Prefers the routed
 * `storageBase` — the only source that knows a nested (teammate / sub-agent)
 * session's address; `projectHomeFor(homeDir, projectRoot)` is the fallback.
 * Undefined when neither is available.
 */
export function resolveSessionStorageBase(options: {
  storageBase?: string
  homeDir?: string
  projectRoot?: string
}): string | undefined {
  if (options.storageBase) return options.storageBase
  if (options.homeDir && options.projectRoot) {
    return projectHomeFor(options.homeDir, options.projectRoot)
  }
  return undefined
}

/**
 * Per-task workspace directory — a writable working area scoped to a single
 * background task / side-task run, so concurrent or sequential tasks don't
 * collide on files. Lives at `<sessionDir>/tasks/<taskId>/workspace/`.
 */
export function getTaskWorkspaceDirectoryPath(
  basePath: string,
  sessionId: string,
  taskId: string,
): string {
  return joinRuntimePath(
    getTaskOutputDirectoryPath(basePath, sessionId),
    taskId,
    'workspace',
  )
}

// Project-grouped storage: ~/.velloc/projects/<projectFolderKey(projectDir)>/<sessionId>/
// One dir per session (transcript + sidecar files). The home dir is passed in:
// the SharedWorker has no `os.homedir()`.

/** Longest sanitized project-dir name before a hash suffix is appended. */
export const SLUG_MAX_CHARS = 200

/** djb2 string hash — only used to disambiguate >200-char paths. */
function djb2Hash(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i)
  }
  return hash
}

/**
 * Turns a project path into a directory name: every non-alphanumeric char
 * becomes `-`; a path
 * longer than SLUG_MAX_CHARS is truncated with a hash suffix for
 * uniqueness. `D:\project\Maxh` → `D--project-Maxh`; `/Users/foo/app` →
 * `-Users-foo-app`.
 */
export function projectFolderKey(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= SLUG_MAX_CHARS) {
    return sanitized
  }
  return `${sanitized.slice(0, SLUG_MAX_CHARS)}-${Math.abs(
    djb2Hash(name),
  ).toString(36)}`
}

/** The Nexus config home, `~/.velloc`. */
export function userDataRoot(homeDir: string): string {
  return joinRuntimePath(homeDir, RUNTIME_DIR_NAME)
}

/** `~/.velloc/projects` — holds one directory per project. */
export function projectsHome(homeDir: string): string {
  return joinRuntimePath(userDataRoot(homeDir), 'projects')
}

/**
 * The single session-meta SQLite database, `<root>/sessions.sqlite`, indexing
 * every session under `root`. See `SqliteSessionMetaStore`.
 */
export function getSessionMetaDbPath(root: string): string {
  return joinRuntimePath(root, SESSION_META_DB_FILE_NAME)
}

/**
 * A project's storage dir: `~/.velloc/projects/<projectFolderKey(projectDir)>`.
 * A trailing separator on `projectDir` is trimmed. Memoized; inputs are
 * session-invariant.
 */
const projectDirCache = new Map<string, string>()
export function projectHomeFor(homeDir: string, projectDir: string): string {
  const cacheKey = `${homeDir}\0${projectDir}`
  const cached = projectDirCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const trimmed = projectDir.replace(/[\\/]+$/, '')
  const result = joinRuntimePath(projectsHome(homeDir), projectFolderKey(trimmed))
  projectDirCache.set(cacheKey, result)
  return result
}

/**
 * Directory name of the shared sandbox workspace, under `~/.velloc/`; the single
 * source for the string. Kept here so the webview can import it without
 * `resolveProjectRoot`'s dependency tree.
 */
export const NEXUS_WORKSPACE_DIR_NAME = 'shared-workspace'

/**
 * The unbound (sandbox) project root: `~/.velloc/shared-workspace`.
 * Sessions with no bound project folder (and `code` sessions not yet bound)
 * work in this shared sandbox. Per-type
 * sessions hang their own subdir off it (`getNexusWorkspaceDirForType` →
 * `~/.velloc/shared-workspace/<type>`).
 */
export function getNexusWorkspaceDir(homeDir: string): string {
  return joinRuntimePath(
    userDataRoot(homeDir),
    NEXUS_WORKSPACE_DIR_NAME,
  )
}

/**
 * The primary template type that forces the user to bind a real project folder
 * (no per-type sandbox default).
 */
export const FORCED_FOLDER_TEMPLATE_TYPE = 'code'

/**
 * Every template type that forces a bound project folder. Check membership via
 * {@link isForcedFolderTemplateType}.
 */
export const FORCED_FOLDER_TEMPLATE_TYPES: ReadonlySet<string> = new Set([
  FORCED_FOLDER_TEMPLATE_TYPE,
  'safe_code',
  // A team lead reviews diffs and spawns git worktrees off the bound repo:
  // with no real folder there is nothing to delegate and nowhere to isolate
  // an untrusted child into.
  'team',
])

/**
 * True when `templateType` is one of the forced-folder types (must bind a real
 * project folder rather than get a per-type sandbox). Type guard so call sites
 * can pass the narrowed value straight to `writeLastFolderForType` etc.
 */
export function isForcedFolderTemplateType(
  templateType: string | undefined,
): templateType is string {
  return templateType !== undefined && FORCED_FOLDER_TEMPLATE_TYPES.has(templateType)
}

// A safe single path segment: lowercase alphanumeric + dashes, starting
// alphanumeric. Anything else (uppercase, dots, slashes, empty) is rejected so a
// hostile or garbage `?templateType=` can never inject a path fragment.
const SAFE_TEMPLATE_TYPE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/

/**
 * True when `templateType` gets a per-type `~/.velloc/shared-workspace/<type>/`
 * default: any safe-named type except {@link FORCED_FOLDER_TEMPLATE_TYPES}. A
 * non-segment value returns false.
 */
export function isPerTypeSharedTemplateType(
  templateType: string | undefined,
): templateType is string {
  return (
    templateType !== undefined &&
    !FORCED_FOLDER_TEMPLATE_TYPES.has(templateType) &&
    SAFE_TEMPLATE_TYPE_SEGMENT.test(templateType)
  )
}

/**
 * The default project root for a session of `templateType` when it has no
 * explicit override: `~/.velloc/shared-workspace/<type>` for the per-type
 * shared types, else the bare `~/.velloc/shared-workspace`. Co-located naming so
 * the on-disk layout is self-documenting (`shared-workspace/agent`,
 * `shared-workspace/chat`, …).
 */
export function getNexusWorkspaceDirForType(
  homeDir: string,
  templateType: string | undefined,
): string {
  const base = getNexusWorkspaceDir(homeDir)
  return isPerTypeSharedTemplateType(templateType)
    ? joinRuntimePath(base, templateType)
    : base
}

