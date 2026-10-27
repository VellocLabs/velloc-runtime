// The host tools' path arguments: worktree re-anchoring, host-native path
// forms, the Read range / pages / context-window shaping, and the untrusted
// read boundary — everything that rewrites or refuses a call's arguments
// before they reach the host. Pure (or fs-stat only); exported for the unit
// tests that pin them.
import type { ToolCallContext } from '../../toolCallContext'
import { SHELL_TOOL_ID } from '../../../prompting/processToolNames'
import { READ_TOOL_ID } from '../../../prompting/fileToolNames'
import { contextWindowOf } from '../../../engine/contextWindow'
import { fsForContext } from '../../../utils/fs/runtimeFs'
import {
  assertUntrustedReadAllowed,
  untrustedReadDeniedMessage,
} from '../../../permissions/untrustedReadBoundary'
import {
  absoluteGlobBaseDirectory,
  isAbsoluteRuntimePath,
  resolveRuntimePath,
} from '../../../utils/runtimePaths'
import { nativizeForHost } from '../../../utils/hostPathForm'

// Worktree isolation (SpawnAgentTool `isolation:'worktree'`). A fork whose
// `options.cwd` diverges from `options.projectRoot` runs in its own git
// worktree; re-anchor its host tool calls to that worktree so parallel forks
// don't clobber each other. The main agent + non-worktree forks have
// cwd === projectRoot and skip this entirely.
const WORKTREE_SHELL_TOOLS = new Set<string>([SHELL_TOOL_ID, 'PowerShell'])
const WORKTREE_FS_PATH_ARGS: Record<string, readonly string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  Glob: ['path'],
  Grep: ['path'],
}

/** Exported for unit testing — see __tests__/worktree-isolation.test.ts. */
export function applyWorktreeIsolation(
  toolName: string,
  input: unknown,
  context: ToolCallContext,
): Record<string, unknown> {
  const args = (input ?? {}) as Record<string, unknown>
  const { cwd, projectRoot } = context.options
  if (cwd === projectRoot) return args

  // Shell tools: the model's command is opaque, so JS can't rewrite paths
  // inside it — stamp the per-call `cwd` the C++ subprocess honours.
  if (WORKTREE_SHELL_TOOLS.has(toolName)) {
    return { ...args, cwd }
  }

  // fs tools: resolve the path arg against the worktree JS-side. An absolute
  // path is returned unchanged; a relative one anchors at the worktree. The
  // C++ fs then resolves the absolute path with no session-cwd dependency.
  const pathArgs = WORKTREE_FS_PATH_ARGS[toolName]
  if (!pathArgs) return args
  const out = { ...args }
  for (const name of pathArgs) {
    const value = out[name]
    if (typeof value === 'string' && value.length > 0) {
      out[name] = resolveRuntimePath(cwd, value)
    } else if (value == null && (toolName === 'Glob' || toolName === 'Grep')) {
      // Search-dir omitted → default to the worktree, not the session cwd.
      out[name] = cwd
    }
  }
  return out
}

/**
 * A per-call `cwd` in host-native form (a Windows host rejects a git-bash `/c/…`
 * cwd). No-op on POSIX hosts, for native paths, and without `cwd`.
 * `hostReference` is the session cwd.
 */
export function normalizeCwdArgForHost(
  args: Record<string, unknown>,
  hostReference: string,
): Record<string, unknown> {
  const cwd = args.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return args
  const native = nativizeForHost(cwd, hostReference)
  return native === cwd ? args : { ...args, cwd: native }
}

/**
 * Hosted fs-tool path args (`file_path`, `path`) in host-native form, as for `cwd`.
 * Windows only; native and relative values are no-ops. Runs AFTER
 * applyWorktreeIsolation.
 */
export function normalizeFsPathArgsForHost(
  toolName: string,
  args: Record<string, unknown>,
  hostReference: string,
): Record<string, unknown> {
  const pathArgs = WORKTREE_FS_PATH_ARGS[toolName]
  if (!pathArgs) return args
  let out: Record<string, unknown> | undefined
  for (const name of pathArgs) {
    const value = args[name]
    if (typeof value !== 'string' || value.length === 0) continue
    const native = nativizeForHost(value, hostReference)
    if (native !== value) {
      out = out ?? { ...args }
      out[name] = native
    }
  }
  return out ?? args
}

/** Exported for unit testing — see __tests__/worktree-isolation.test.ts. */
export function stripNonPdfReadPagesArg(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== READ_TOOL_ID || !Object.hasOwn(args, 'pages')) {
    return args
  }

  const filePath = args.file_path
  if (
    typeof filePath === 'string' &&
    filePath.trimEnd().toLowerCase().endsWith('.pdf')
  ) {
    return args
  }

  const out = { ...args }
  delete out.pages
  return out
}

/**
 * Coerce a clean base-10 integer string `offset` / `limit` on a Read call to an
 * integer (the host otherwise drops the range silently). Anything else is left as
 * sent, so the native validator still rejects it.
 */
export function coerceReadRangeArgsForHost(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== READ_TOOL_ID) return args

  let out: Record<string, unknown> | undefined
  for (const key of ['offset', 'limit'] as const) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!/^-?\d+$/.test(trimmed)) continue
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isSafeInteger(parsed)) continue
    out ??= { ...args }
    out[key] = parsed
  }
  return out ?? args
}

/** Exported for unit testing — see __tests__/worktree-isolation.test.ts. */
export function applyReadContextWindow(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolCallContext,
): Record<string, unknown> {
  if (toolName !== READ_TOOL_ID) return args

  const model = context.options.mainLoopModel
  const modelId = model && model !== 'inherit' ? model : undefined
  return {
    ...args,
    context_window: contextWindowOf(
      modelId,
      context.options.mainLoopProviderId,
    ),
  }
}

/**
 * The untrusted-provider read boundary's refusal for a host tool call, or
 * undefined when the call may proceed. This is the chokepoint: every host
 * filesystem tool call passes through here on its way to the host, with its
 * path arguments already anchored, so the check runs on the FINAL paths. A
 * no-op for every session without `untrustedReadRoot`.
 */
export async function untrustedReadRefusal(
  toolName: string,
  callArgs: Record<string, unknown>,
  context: ToolCallContext,
): Promise<string | undefined> {
    // Security: untrusted-provider read boundary. Every host fs call passes here
    // with its paths already anchored, so the check runs on the FINAL `callArgs`.
    // A no-op without `untrustedReadRoot`. applyWorktreeIsolation is NOT a boundary.
    if (context.options.untrustedReadRoot) {
      const pathArgs = WORKTREE_FS_PATH_ARGS[toolName]
      if (pathArgs) {
        const args = callArgs
        for (const name of pathArgs) {
          const value = args[name]
          if (typeof value !== 'string' || value.length === 0) continue
          const verdict = await assertUntrustedReadAllowed(
            value,
            context,
            fsForContext(context),
          )
          if (!verdict.ok) {
            return untrustedReadDeniedMessage(verdict, context.options.untrustedReadRoot)
          }
        }
        // Glob's `pattern` is a SECOND path argument: the host derives the
        // search root from an ABSOLUTE pattern and ignores `path`
        // (file_tool.cc RunGlobOnUI → ExtractGlobBaseDirectory), so
        // `pattern: 'C:/Users/me/**/*'` lists outside the root while the
        // `path` check above sees nothing. Its static base is checked like
        // a path; one the host would not split is refused outright.
        if (toolName === 'Glob') {
          const pattern = args.pattern
          if (typeof pattern === 'string' && isAbsoluteRuntimePath(pattern)) {
            const base = absoluteGlobBaseDirectory(pattern)
            const verdict = base
              ? await assertUntrustedReadAllowed(
                  base,
                  context,
                  fsForContext(context),
                )
              : {
                  ok: false as const,
                  reason: 'the pattern has no static base directory to check',
                }
            if (!verdict.ok) {
              return untrustedReadDeniedMessage(verdict, context.options.untrustedReadRoot)
            }
          }
        }
      } else if (WORKTREE_SHELL_TOOLS.has(toolName)) {
        // Unreachable today — `safe_code` has no shell at all, which is what
        // actually closes execution. Kept as a fail-closed default so a
        // future untrusted session on some other template cannot inherit a
        // shell that this boundary was never written to constrain.
        return 'Denied: this session cannot run commands.'
      }
    }
  return undefined
}
