import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import { fsForContext } from '../../utils/fs/runtimeFs'
import {
  extnameRuntimePath,
  resolveRuntimePath,
} from '../../utils/runtimePaths'

export const NOTEBOOK_TOOL_ID = 'NotebookEdit'

export type NotebookEditMode = 'replace' | 'insert' | 'delete'
export type IpynbCellKind = 'code' | 'markdown'

type IpynbCell = {
  cell_type: IpynbCellKind | 'raw'
  id?: string
  source: string | string[]
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
  [key: string]: unknown
}

type IpynbDoc = {
  cells: IpynbCell[]
  metadata?: {
    language_info?: { name?: string }
    [key: string]: unknown
  }
  nbformat: number
  nbformat_minor: number
  [key: string]: unknown
}

export type NotebookPatchArgs = {
  notebook_path?: string
  cell_id?: string
  new_source?: string
  cell_type?: IpynbCellKind
  edit_mode?: NotebookEditMode
}

// The model sees one sentence per edit ("Updated cell X with Y",
// "Inserted cell X with Y", "Deleted cell X"); cell type, language and the
// before/after file text stay internal.
export type NotebookEditOutput = string

const VALID_EDIT_MODES: ReadonlySet<NotebookEditMode> = new Set<NotebookEditMode>([
  'replace',
  'insert',
  'delete',
])

// A filesystem failure counts as "not found" when it carries the ENOENT
// code, or when its message names ENOENT as a separate word.
function notebookIsMissing(failure: unknown): boolean {
  if (failure === null || typeof failure !== 'object') return false
  const { code, message } = failure as { code?: unknown; message?: unknown }
  if (code === 'ENOENT') return true
  return typeof message === 'string' && /\bENOENT\b/.test(message)
}

const POSITIONAL_CELL_PATTERN = /^cell-([0-9]+)$/

// Positional fallback for `cell_id`: "cell-<digits>" selects that index.
export function cellIndexFromId(cellId: string): number | undefined {
  const found = POSITIONAL_CELL_PATTERN.exec(cellId)
  return found ? Number.parseInt(found[1], 10) : undefined
}

function safeParseNotebook(content: string): IpynbDoc | null {
  try {
    const parsed = JSON.parse(content) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as IpynbDoc).cells) &&
      typeof (parsed as IpynbDoc).nbformat === 'number'
    ) {
      return parsed as IpynbDoc
    }
  } catch {
    // fall through
  }
  return null
}

function generateCellId(): string {
  return Math.random().toString(36).substring(2, 15)
}

function supportsCellIds(notebook: IpynbDoc): boolean {
  return (
    notebook.nbformat > 4 ||
    (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
  )
}

function buildNewCell(
  cellType: IpynbCellKind,
  source: string,
  cellId: string | undefined,
): IpynbCell {
  if (cellType === 'markdown') {
    return {
      cell_type: 'markdown',
      id: cellId,
      source,
      metadata: {},
    }
  }
  return {
    cell_type: 'code',
    id: cellId,
    source,
    metadata: {},
    execution_count: null,
    outputs: [],
  }
}

function failure(
  _input: NotebookPatchArgs,
  _notebookPath: string,
  message: string,
): NotebookEditOutput {
  // Failures are a single sentence too; nothing reads structured fields here.
  return `Notebook edit failed: ${message}`
}

export const NotebookPatchTool: ToolContract<NotebookPatchArgs, NotebookEditOutput> =
  declareTool({
    name: NOTEBOOK_TOOL_ID,
    discoveryHint: 'edit Jupyter notebook cells (.ipynb)',
    argsSchema: {
      type: 'object',
      properties: {
        notebook_path: {
          type: 'string',
          description:
            'Absolute path of the .ipynb file.',
        },
        cell_id: {
          type: 'string',
          description:
            'Which cell: its id, or "cell-N" for the cell at index N. For insert, the new cell goes after this one; omit it to insert at the top.',
        },
        new_source: {
          type: 'string',
          description: 'The cell\'s new source text.',
        },
        cell_type: {
          type: 'string',
          enum: ['code', 'markdown'],
          description:
            `"code" or "markdown". Keeps the cell's current type unless set; required when inserting.`,
        },
        edit_mode: {
          type: 'string',
          enum: ['replace', 'insert', 'delete'],
          description:
            `"replace" (default) rewrites the cell's source; "insert" adds a new cell after cell_id; "delete" removes cell_id.`,
        },
      },
      required: ['notebook_path', 'new_source'],
    },
    description: async () =>
      'Edits one cell of a Jupyter notebook (.ipynb): rewrites its source, inserts a new cell after it, or deletes it.',
    parallelSafe: () => false,
    readsOnly: () => false,
    async checkInput(
      input: NotebookPatchArgs,
      context: ToolCallContext,
    ): Promise<InputCheck> {
      if (!input.notebook_path || typeof input.notebook_path !== 'string') {
        return {
          result: false,
          message: 'notebook_path is required.',
          errorCode: 1,
        }
      }
      if (typeof input.new_source !== 'string') {
        return {
          result: false,
          message: 'new_source is required and must be a string.',
          errorCode: 2,
        }
      }
      const editMode: NotebookEditMode = input.edit_mode ?? 'replace'
      if (!VALID_EDIT_MODES.has(editMode)) {
        return {
          result: false,
          message: 'edit_mode must be one of: replace, insert, delete.',
          errorCode: 3,
        }
      }
      if (editMode === 'insert' && !input.cell_type) {
        return {
          result: false,
          message: "cell_type is required when edit_mode='insert'.",
          errorCode: 4,
        }
      }

      const fullPath = resolveRuntimePath(
        context.options.cwd,
        input.notebook_path,
      )

      if (extnameRuntimePath(fullPath) !== '.ipynb') {
        return {
          result: false,
          message:
            'File must be a Jupyter notebook (.ipynb). Use the Edit tool for other file types.',
          errorCode: 5,
        }
      }

      const fs = fsForContext(context)

      let mtimeMs: number
      try {
        const stat = await fs.stat(fullPath)
        if (!stat.isFile()) {
          return {
            result: false,
            message: `${fullPath} exists but is not a regular file.`,
            errorCode: 6,
          }
        }
        mtimeMs = stat.mtimeMs ?? 0
      } catch (error) {
        if (notebookIsMissing(error)) {
          return {
            result: false,
            message: 'No notebook exists at that path.',
            errorCode: 7,
          }
        }
        throw error
      }

      const lastRead = context.fileReadLedger.get(fullPath)
      if (!lastRead) {
        return {
          result: false,
          message:
            'This notebook has not been read in this conversation. Read it, then edit.',
          errorCode: 8,
        }
      }
      if (Math.floor(mtimeMs) > lastRead.timestamp) {
        return {
          result: false,
          message:
            'The notebook changed on disk after you read it. Read it again before editing.',
          errorCode: 9,
        }
      }

      let content: string
      try {
        content = await fs.readFile(fullPath, { encoding: 'utf-8' })
      } catch (error) {
        if (notebookIsMissing(error)) {
          return {
            result: false,
            message: 'No notebook exists at that path.',
            errorCode: 7,
          }
        }
        throw error
      }
      const notebook = safeParseNotebook(content)
      if (!notebook) {
        return {
          result: false,
          message: 'The notebook could not be parsed as JSON.',
          errorCode: 10,
        }
      }

      if (!input.cell_id) {
        if (editMode !== 'insert') {
          return {
            result: false,
            message: 'cell_id is required unless edit_mode is "insert".',
            errorCode: 11,
          }
        }
      } else {
        const byId = notebook.cells.findIndex(cell => cell.id === input.cell_id)
        if (byId === -1) {
          const parsed = cellIndexFromId(input.cell_id)
          if (parsed === undefined) {
            return {
              result: false,
              message: `No cell has the id "${input.cell_id}".`,
              errorCode: 12,
            }
          }
          if (!notebook.cells[parsed]) {
            return {
              result: false,
              message: `Cell with index ${parsed} does not exist in notebook.`,
              errorCode: 13,
            }
          }
        }
      }

      return { result: true }
    },
    async call(
      input: NotebookPatchArgs,
      context: ToolCallContext,
    ) {
      const notebookPath = String(input.notebook_path ?? '')
      const newSource = String(input.new_source ?? '')
      const fullPath = resolveRuntimePath(context.options.cwd, notebookPath)
      const fs = fsForContext(context)

      let originalContent: string
      try {
        originalContent = await fs.readFile(fullPath, { encoding: 'utf-8' })
      } catch (error) {
        return {
          data: failure(
            input,
            fullPath,
            error instanceof Error ? error.message : 'Failed to read notebook.',
          ),
        }
      }

      const notebook = safeParseNotebook(originalContent)
      if (!notebook) {
        return {
          data: failure(input, fullPath, 'Notebook is not valid JSON.'),
        }
      }

      let cellIndex: number
      if (!input.cell_id) {
        cellIndex = 0
      } else {
        cellIndex = notebook.cells.findIndex(cell => cell.id === input.cell_id)
        if (cellIndex === -1) {
          const parsed = cellIndexFromId(input.cell_id)
          if (parsed !== undefined) {
            cellIndex = parsed
          }
        }
        if (input.edit_mode === 'insert') {
          cellIndex += 1
        }
      }

      let editMode: NotebookEditMode = input.edit_mode ?? 'replace'
      let cellType: IpynbCellKind | undefined = input.cell_type

      // Replacing the slot just past the last cell appends a new cell.
      if (editMode === 'replace' && cellIndex === notebook.cells.length) {
        editMode = 'insert'
        if (!cellType) {
          cellType = 'code'
        }
      }

      const language =
        notebook.metadata?.language_info?.name ?? 'python'

      let resultCellId: string | undefined
      if (supportsCellIds(notebook)) {
        if (editMode === 'insert') {
          resultCellId = generateCellId()
        } else if (input.cell_id !== undefined) {
          resultCellId = input.cell_id
        }
      }

      if (editMode === 'delete') {
        notebook.cells.splice(cellIndex, 1)
      } else if (editMode === 'insert') {
        const inserted = buildNewCell(cellType ?? 'code', newSource, resultCellId)
        notebook.cells.splice(cellIndex, 0, inserted)
      } else {
        const target = notebook.cells[cellIndex]
        if (!target) {
          return {
            data: failure(
              input,
              fullPath,
              `Cell at index ${cellIndex} does not exist in notebook.`,
            ),
          }
        }
        target.source = newSource
        if (target.cell_type === 'code') {
          target.execution_count = null
          target.outputs = []
        }
        if (cellType && cellType !== target.cell_type) {
          target.cell_type = cellType
        }
      }

      const IPYNB_INDENT = 1
      const updatedContent = JSON.stringify(notebook, null, IPYNB_INDENT)

      try {
        await fs.writeFile(fullPath, updatedContent, { encoding: 'utf-8' })
      } catch (error) {
        return {
          data: failure(
            input,
            fullPath,
            error instanceof Error
              ? error.message
              : 'Failed to write notebook.',
          ),
        }
      }

      let newMtimeMs = Date.now()
      try {
        const stat = await fs.stat(fullPath)
        newMtimeMs = stat.mtimeMs ?? newMtimeMs
      } catch {
        // best-effort
      }

      const finalCellType: IpynbCellKind =
        editMode === 'delete'
          ? cellType ?? 'code'
          : cellType ??
            (() => {
              const cell =
                editMode === 'insert'
                  ? notebook.cells[cellIndex]
                  : notebook.cells[cellIndex]
              const t = cell?.cell_type
              return t === 'markdown' ? 'markdown' : 'code'
            })()

      const message =
        editMode === 'replace'
          ? `Updated cell ${resultCellId} with ${newSource}`
          : editMode === 'insert'
            ? `Inserted cell ${resultCellId} with ${newSource}`
            : `Deleted cell ${resultCellId}`

      // The structured `NotebookEditOutput` is no longer returned to
      // the model. `contextPatch` still uses the computed
      // `updatedContent` for the readFileState cache; `finalCellType`
      // / `originalContent` were only model-facing previously and are
      // not needed downstream. Reference the unused variables so the
      // typecheck doesn't flag them as dead.
      void finalCellType
      void originalContent

      return {
        data: message,
        contextPatch(ctx: ToolCallContext) {
          ctx.fileReadLedger.set(fullPath, {
            content: updatedContent,
            timestamp: newMtimeMs,
            offset: undefined,
            limit: undefined,
          })
          return ctx
        },
      }
    },
  })
