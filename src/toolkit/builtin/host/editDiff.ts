// Edit / Write: the host's `{message, original_file?}` result split into the
// model-facing sentence and a UI-only file-relative diff.
import { WRITE_TOOL_ID } from '../../../prompting/fileToolNames'
import { summarizeFileChange, type FileChangeDiff } from '../../../utils/fileChangeHunks'

export function buildHostEditDiff(
  toolName: string,
  args: Record<string, unknown>,
  data: unknown,
): { modelData: string; editDiff: FileChangeDiff } | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const message = typeof d.message === 'string' ? d.message : null
  if (message === null) return null

  const originalFile =
    typeof d.original_file === 'string' ? d.original_file : undefined
  const filePath = typeof args.file_path === 'string' ? args.file_path : ''

  if (toolName === WRITE_TOOL_ID) {
    const content = typeof args.content === 'string' ? args.content : ''
    return {
      modelData: message,
      editDiff: summarizeFileChange({
        op: 'overwrite',
        path: filePath,
        text: content,
        before: originalFile,
      }),
    }
  }

  return {
    modelData: message,
    editDiff: summarizeFileChange({
      op: 'replace',
      path: filePath,
      find: typeof args.old_string === 'string' ? args.old_string : '',
      put: typeof args.new_string === 'string' ? args.new_string : '',
      everywhere: args.replace_all === true,
      before: originalFile,
    }),
  }
}
