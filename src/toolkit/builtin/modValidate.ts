// ModValidate: the static check of a mod folder (F-25), for the model. The same
// validator answers `/plugins validate <folder>` for the person.

import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import type { ToolPermissionResult } from '../permissionVerdict'
import { declareTool } from '../toolContract'
import { buildFilePermissionContext } from '../run/toolPermissionGate'
import { vetFileRead } from '../../permissions/filesystemPermission'
import { assertUntrustedReadAllowed } from '../../permissions/untrustedReadBoundary'
import { fsForContext } from '../../utils/fs/runtimeFs'
import { resolveRuntimePath } from '../../utils/runtimePaths'
import { READ_TOOL_ID } from '../../prompting/fileToolNames'
import { validateModFolder, type ModValidateReport } from '../../mods/modValidate'

export const MOD_VALIDATE_TOOL_NAME = 'ModValidate'

export type ModValidateInput = { folder: string }

type GateContext = Pick<ToolCallContext, 'options' | 'readAppState'> & Partial<ToolCallContext>

/**
 * Security: the read gate for a validation, one path at a time: the session's
 * untrusted-read boundary, then the Read tool's file permission (a deny rule
 * refuses; an ask refuses too unless `askAllowed` — the person ran the
 * command — or the session bypasses permissions). Nothing here prompts.
 */
export function modFolderReadGate(context: GateContext, askAllowed: boolean): (path: string) => Promise<void> {
  return async path => {
    const boundary = await assertUntrustedReadAllowed(path, context, fsForContext(context as ToolCallContext))
    if (!boundary.ok) throw new Error(`${boundary.reason}; this session reads only under ${context.options.untrustedReadRoot}`)
    const rules = context.readAppState?.().permissionRules
    if (!rules) return
    const verdict = await vetFileRead(READ_TOOL_ID, { file_path: path }, buildFilePermissionContext(context as ToolCallContext, rules))
    if (verdict.behavior === 'deny') throw new Error(verdict.message ?? 'a permission rule denies reading it')
    if (verdict.behavior === 'ask' && !askAllowed && rules.mode !== 'bypassPermissions') {
      throw new Error(verdict.message ?? 'reading it needs permission')
    }
  }
}

/** Validate `folder` (relative to the session's cwd) as the session may read it. */
export function validateFolderForSession(folder: string, context: GateContext, askAllowed: boolean): Promise<ModValidateReport> {
  const absolute = resolveRuntimePath(context.options.cwd, folder)
  return validateModFolder(absolute, {
    fs: fsForContext(context as ToolCallContext),
    gate: modFolderReadGate(context, askAllowed),
  })
}

const DESCRIPTION = [
  'Statically check a mod (a plugin folder with hooks modules) the way the loader reads it, without loading or running it.',
  '',
  'Reports, as JSON: each module, the hooks it registers (event, file, line, whether it is a generator, whether it has a .catch, whether its answer can refuse an action), the $ calls it makes, the engine.create nouns it adds, the $.state keys it reads and writes, and findings.',
  '',
  'Finding levels: "refused" — the loader will not load the mod; "error" — it loads but fails where used, or cannot be checked; "warning" — it works with a named risk; "note" — information. `ok` is true when there is no refused or error finding. Compile errors carry the file and line.',
  '',
  'Use it after writing or changing a mod, before relying on it. It is a check, not a security boundary.',
].join('\n')

export const ModValidateTool: ToolContract<ModValidateInput, string> = declareTool({
  name: MOD_VALIDATE_TOOL_NAME,
  discoveryHint: 'check a mod or plugin folder: hooks, events, $ calls, compile errors',
  argsSchema: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        description: 'The plugin folder: the one holding the plugin manifest and hooks/hooks.json. Absolute, or relative to the working directory.',
      },
    },
    required: ['folder'],
  },
  description: async () => DESCRIPTION,
  parallelSafe: () => true,
  readsOnly: () => true,
  async checkInput(input: ModValidateInput): Promise<InputCheck> {
    if (typeof input.folder !== 'string' || input.folder.trim() === '') {
      return { result: false, message: 'folder is required and must be a non-empty path.', errorCode: 1 }
    }
    return { result: true }
  },
  async selfVerdict(input: ModValidateInput, context: ToolCallContext): Promise<ToolPermissionResult> {
    const folder = resolveRuntimePath(context.options.cwd, input.folder)
    const boundary = await assertUntrustedReadAllowed(folder, context, fsForContext(context))
    if (!boundary.ok) {
      return { behavior: 'deny', message: `${boundary.reason}. This session may only read files under ${context.options.untrustedReadRoot}.` }
    }
    const rules = context.readAppState?.().permissionRules
    if (!rules) return { behavior: 'allow', updatedInput: input }
    const verdict = await vetFileRead(READ_TOOL_ID, { file_path: folder }, buildFilePermissionContext(context, rules))
    return verdict.behavior === 'allow' ? { ...verdict, updatedInput: input } : verdict
  },
  async call(input: ModValidateInput, context: ToolCallContext) {
    const report = await validateFolderForSession(input.folder, context, false)
    return { data: JSON.stringify(report, null, 2) }
  },
})
