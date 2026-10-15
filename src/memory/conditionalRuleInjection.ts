/**
 * Per-file-read instruction injection: drains
 * `nestedMemoryAttachmentTriggers` (filled by Read) and attaches, as
 * `<system-reminder>`s, the nested instruction files below the anchor and the
 * `paths:`-matched rules. De-dup via `loadedNestedMemoryPaths`, cleared on
 * compaction so a compacted-out rule re-injects.
 */

import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  createNestedInstructionWalkMemo,
  getConditionalRulesForPath,
  getNestedInstructionFilesForPath,
  type InstructionDoc,
} from './instructionFiles'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { pathCompareKey } from '../utils/runtimePaths'

export type ConditionalRuleInjectionParams = {
  /** Files read this turn (drained from `nestedMemoryAttachmentTriggers`). */
  readPaths: readonly string[]
  /**
   * Non-evicting dedup set of rule file paths already injected this session
   * (`ToolUseContext.loadedNestedMemoryPaths`). Mutated in place: a rule already
   * present is skipped; a freshly-injected rule is added. Cleared on compaction
   * by the query loop. Omit (test/headless) → no cross-turn dedup.
   */
  loadedNestedMemoryPaths?: Set<string>
  /**
   * Instruction files the system prompt already carries (the eager load's
   * result, `ToolUseContext.promptInstructionPaths`). Unlike the set above it
   * survives compaction — the prompt is not compacted — so a nested file's
   * `@include` that resolves to one of them is never injected a second time.
   */
  promptInstructionPaths?: ReadonlySet<string>
  /** The session's cwd: the nested walk's anchor when there is no project
   *  root (the eager walk's own fallback). */
  cwd?: string
  projectRoot?: string
  homeDir?: string
  /** Untrusted-child read boundary; see `GetMemoryFilesParams.readRoot`. */
  readRoot?: string
  runtimeConfig: RuntimeConfig
  /** THIS session's fs; see `GetMemoryFilesParams.fs`. */
  fs?: RuntimeFs
}

/**
 * Build the `<system-reminder>` blocks for the files read this turn — the
 * nested instruction files, then the path-scoped rules — or `null` to inject
 * nothing. Best-effort — any failure returns null and the turn proceeds
 * unchanged. Mutates `loadedNestedMemoryPaths` with what it injects.
 */
export async function buildConditionalRuleInjection(
  params: ConditionalRuleInjectionParams,
): Promise<string | null> {
  const uniqueReadPaths = [...new Set(params.readPaths)].filter(
    p => typeof p === 'string' && p.length > 0,
  )
  if (uniqueReadPaths.length === 0) return null

  const surfaced = params.loadedNestedMemoryPaths
  const readKeys = new Set(uniqueReadPaths.map(pathCompareKey))
  const promptKeys = new Set(
    [...(params.promptInstructionPaths ?? [])].map(pathCompareKey),
  )
  // One walk for the whole batch: files read side by side share ancestors.
  const memo = createNestedInstructionWalkMemo()

  // Nested instruction files, deduped by path across the read files and
  // against what this session already surfaced.
  const nestedByPath = new Map<string, InstructionDoc>()
  for (const readPath of uniqueReadPaths) {
    let files: InstructionDoc[]
    try {
      files = await getNestedInstructionFilesForPath(readPath, {
        cwd: params.cwd,
        projectRoot: params.projectRoot,
        homeDir: params.homeDir,
        readRoot: params.readRoot,
        runtimeConfig: params.runtimeConfig,
        fs: params.fs,
        memo,
      })
    } catch {
      continue // best-effort per read path
    }
    for (const file of files) {
      if (surfaced?.has(file.path) || nestedByPath.has(file.path)) continue
      // Already in the system prompt (an `@include` that climbed back up).
      if (promptKeys.has(pathCompareKey(file.path))) continue
      // The agent read the instruction file itself: it has the text already.
      // Counted as surfaced, so a later read beside it does not send it again.
      if (readKeys.has(pathCompareKey(file.path))) {
        surfaced?.add(file.path)
        continue
      }
      nestedByPath.set(file.path, file)
    }
  }
  const nested = [...nestedByPath.values()]
  if (surfaced) {
    for (const file of nested) surfaced.add(file.path)
  }
  const nestedText = nested.map(
    file =>
      `<system-reminder>\nContents of ${file.path}:\n\n${file.content}\n</system-reminder>`,
  )

  // Collect matched rules across all read paths, deduped by rule file path,
  // skipping any already surfaced this session (out-of-band Set).
  const matchedByPath = new Map<string, InstructionDoc>()
  for (const readPath of uniqueReadPaths) {
    let rules: InstructionDoc[]
    try {
      rules = await getConditionalRulesForPath(readPath, {
        projectRoot: params.projectRoot,
        homeDir: params.homeDir,
        readRoot: params.readRoot,
        runtimeConfig: params.runtimeConfig,
        fs: params.fs,
      })
    } catch {
      continue // best-effort per read path
    }
    for (const rule of rules) {
      if (surfaced?.has(rule.path) || matchedByPath.has(rule.path)) continue
      matchedByPath.set(rule.path, rule)
    }
  }

  if (matchedByPath.size === 0 && nestedText.length === 0) return null

  const rules = [...matchedByPath.values()]
  // Mark as surfaced BEFORE returning so a concurrent/duplicate drain in the
  // same turn doesn't re-emit them (the set is filled at injection time).
  if (surfaced) {
    for (const rule of rules) surfaced.add(rule.path)
  }

  return [
    ...nestedText,
    ...rules.map(
      rule =>
        `<system-reminder>\nThe following path-scoped rule applies to a file you ` +
        `just read. Follow it.\n\nContents of ${rule.path}:\n${rule.content}\n` +
        `</system-reminder>`,
    ),
  ].join('\n')
}
