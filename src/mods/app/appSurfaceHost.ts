/**
 * An app session's surfaces (F-40), built from its folder: the entry file is
 * A2UI Express drawing one or more surfaces, the data file JSON bound under
 * `/data`. A failed build is published as an error beside the build before it.
 * Builds run at session open, on BuildApp, on Reload, and at a turn's end when
 * the entry changed; a plugin's write to the data file re-reads the data alone.
 */

import type { Message } from '../../runtime/RuntimeTypes'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { ToolContract } from '../../toolkit/toolContract'
import { declareTool } from '../../toolkit/toolContract'
import { joinRuntimePath, normalizeRuntimePath, pathCompareKey } from '../../utils/runtimePaths'
import type {
  AppSurfaceBuild,
  AppSurfaceError,
  AppSurfaceState,
  ModsBuildAppResult,
} from '../../browser/runtimeProtocol/modApps'
import { blockSurfaceIds, hasA2uiBlock, splitA2uiText } from '../../toolkit/builtin/a2ui/express/a2uiBlocks'
import { hashOf, SEED_MAX_FILE_BYTES } from './appSeed'
import type { AppSessionInfo } from './appSession'
import { setAppBuilder, setAppSurfaceState } from './appSurfaceRegistry'

export const BUILD_APP_TOOL_NAME = 'BuildApp'

export type AppEntryCompile = (body: string) => Promise<{ ok: true; surfaceIds: string[] } | { ok: false; message: string }>

export type AppSurfaceHostOptions = {
  fs: Pick<RuntimeFs, 'readFileBytes' | 'stat'>
  app: AppSessionInfo
  sessionId: string
  /** Compiles an entry body; defaults to the runtime's Express compiler. */
  compile?: AppEntryCompile
  /** Where a changed state goes; defaults to the realm registry. */
  publish?: (sessionId: string, state: AppSurfaceState | null) => void
  /**
   * Where `mods.buildApp` finds this build; defaults to the realm registry.
   * The result forgets it, and is true while it was still this host's.
   */
  registerBuild?: (sessionId: string, build: () => Promise<ModsBuildAppResult>) => () => boolean
}

export type TurnEndCheck = (params: { messages: Message[]; assistantMessages: Message[] }) => Promise<Message[]>

export type AppSurfaceHost = {
  /** The first build, at session open. */
  start(): Promise<AppSurfaceState>
  /** Builds the entry and reads the data; builds run one at a time. */
  build(): Promise<ModsBuildAppResult>
  /** A plugin's write at `absPath`: the data is read again when it is the data file. */
  noteWrite(absPath: string): void
  /** The session's system-prompt block for the app. */
  promptBlock: string
  /** The model's way to build the app: offered in this session alone. */
  tool: ToolContract<Record<string, never>, string>
  /**
   * The turn-end check of an app session: `inner`'s notes, then a build when
   * the entry changed since the last one, then a note when the reply drew one
   * of the app's surfaces in chat.
   */
  wrapTurnEndCheck(inner: TurnEndCheck, makeNote: (text: string) => Message): TurnEndCheck
  /** The session closed: its state leaves the registry. */
  dispose(): void
}

async function defaultCompile(body: string): Promise<{ ok: true; surfaceIds: string[] } | { ok: false; message: string }> {
  const { getRuntimeA2uiCompiler } = await import('../../toolkit/builtin/a2ui/express/a2uiRuntimeCompiler')
  const compiler = await getRuntimeA2uiCompiler()
  const result = compiler.compile(body, compiler.createState())
  if (!result.ok) return { ok: false, message: result.message }
  const ids: string[] = []
  for (const message of result.messages as unknown as Array<Record<string, { surfaceId?: unknown } | undefined>>) {
    if (message.deleteSurface) return { ok: false, message: `the entry may not delete a surface (deleteSurface("${String(message.deleteSurface.surfaceId)}"))` }
    for (const value of Object.values(message)) {
      const id = typeof value === 'object' && value !== null ? value.surfaceId : undefined
      if (typeof id === 'string' && !ids.includes(id)) ids.push(id)
    }
  }
  if (ids.length === 0) return { ok: false, message: 'the entry draws no surface; open it with surface("<id>")' }
  return { ok: true, surfaceIds: ids }
}

type FileRead = { text: string; hash: string; mtimeMs: number } | { missing: true } | { failed: string }

async function readText(fs: AppSurfaceHostOptions['fs'], path: string): Promise<FileRead> {
  let size: number
  let mtimeMs: number
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return { failed: 'it is not a file' }
    size = stat.size
    mtimeMs = stat.mtimeMs ?? 0
  } catch {
    return { missing: true }
  }
  if (size > SEED_MAX_FILE_BYTES) return { failed: `it is ${size} bytes, over the ${SEED_MAX_FILE_BYTES}-byte limit` }
  try {
    const bytes = await fs.readFileBytes(path, SEED_MAX_FILE_BYTES)
    return { text: new TextDecoder().decode(bytes), hash: await hashOf(bytes), mtimeMs }
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) }
  }
}

const sameState = (a: AppSurfaceState | undefined, b: AppSurfaceState): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b)

/** The surface ids a reply's `<a2ui>` blocks draw that are among `ids`. */
export function replyDrawsAppSurface(reply: readonly Message[], ids: readonly string[]): string[] {
  if (ids.length === 0) return []
  const drawn = new Set<string>()
  for (const message of reply) {
    if (message.type !== 'assistant') continue
    const content = (message.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const record = part as { type?: unknown; text?: unknown }
      if (record?.type !== 'text' || typeof record.text !== 'string' || !hasA2uiBlock(record.text)) continue
      for (const segment of splitA2uiText(record.text)) {
        if (segment.kind !== 'block') continue
        for (const id of blockSurfaceIds(segment.body).targets) if (ids.includes(id)) drawn.add(id)
      }
    }
  }
  return [...drawn]
}

export function appPromptBlock(app: AppSessionInfo): string {
  const { entry, data } = app.decl
  return [
    `# This session is an app`,
    `This session runs the app "${app.appId}" of the plugin "${app.plugin}". Its folder is the project root; AGENTS.md there says what the app is for.`,
    `- What the person sees is built from \`${entry}\`, an A2UI Express file with one surface("..."). The app's pages are a Tabs component in that surface, as in \`root = Tabs([{title: "Overview", child: overview}, {title: "Refunds", child: refunds}])\`: the person switches between them, and a new build keeps the tab they are on. Load the a2ui skill before you edit it: it has the grammar and the components.`,
    `- After you change the app's files, call ${BUILD_APP_TOOL_NAME}: it builds \`${entry}\`, shows the result to the person and returns any error to fix. Never write an <a2ui> block in chat for one of the app's surfaces; a chart that answers a question in chat is fine.`,
    data
      ? `- The app's data is \`${data}\`, set under $/data on each of its surfaces: bind to $/data/... . A2UI does no arithmetic, so every figure shown must already be in the data.`
      : `- The app has no data file; its values are written in \`${entry}\`.`,
  ].join('\n')
}

function buildReport(entry: string, result: ModsBuildAppResult, errors: readonly AppSurfaceError[]): string {
  const dataLines = errors.filter(error => error.kind === 'data').map(error => error.message)
  const head = result.ok
    ? `Built ${entry}: ${result.surfaceIds.map(id => `surface("${id}")`).join(', ')}. The person sees it now.`
    : `${result.message}\nThe person still sees the previous build, marked as failed.`
  return [head, ...dataLines].join('\n')
}

export function createAppSurfaceHost(options: AppSurfaceHostOptions): AppSurfaceHost {
  const { fs, app, sessionId } = options
  const compile = options.compile ?? defaultCompile
  const publish = options.publish ?? setAppSurfaceState
  const registerBuild = options.registerBuild ?? setAppBuilder
  const entry = app.decl.entry
  const entryPath = joinRuntimePath(app.folder, entry)
  const dataPath = app.decl.data ? joinRuntimePath(app.folder, app.decl.data) : undefined
  const dataKey = dataPath ? pathCompareKey(normalizeRuntimePath(dataPath)) : undefined

  let built: AppSurfaceBuild | null = null
  let buildError: AppSurfaceError | undefined
  let data: { value: unknown; at: number; hash: string } | undefined
  let dataError: AppSurfaceError | undefined
  /** The entry hash of the last build attempt and what it gave, so an unchanged entry is not compiled again. */
  let attempted: { hash: string; result: ModsBuildAppResult } | undefined
  let published: AppSurfaceState | undefined
  let disposed = false
  let queue: Promise<unknown> = Promise.resolve()
  let pendingData = false

  const errors = (): AppSurfaceError[] => [buildError, dataError].filter((e): e is AppSurfaceError => e !== undefined)

  const emit = (): AppSurfaceState => {
    const list = errors()
    const state: AppSurfaceState = {
      appId: app.appId,
      surface: built,
      ...(data ? { data: data.value, dataAt: data.at } : {}),
      refreshing: false,
      ...(list.length > 0 ? { errors: list } : {}),
      ...(app.seed.conflicts.length > 0 ? { seedConflicts: [...app.seed.conflicts] } : {}),
    }
    if (!disposed && !sameState(published, state)) {
      published = state
      publish(sessionId, state)
    }
    return state
  }

  const readData = async (): Promise<void> => {
    if (!dataPath) return
    const read = await readText(fs, dataPath)
    if ('failed' in read) {
      dataError = { kind: 'data', message: `${app.decl.data} could not be read: ${read.failed}` }
    } else if ('missing' in read) {
      dataError = undefined
      data = undefined
    } else if (read.hash !== data?.hash) {
      try {
        data = { value: JSON.parse(read.text), at: read.mtimeMs, hash: read.hash }
        dataError = undefined
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        dataError = { kind: 'data', message: `${app.decl.data} is not JSON: ${reason}` }
      }
    } else {
      dataError = undefined
    }
  }

  const buildEntry = async (): Promise<ModsBuildAppResult> => {
    const read = await readText(fs, entryPath)
    let result: ModsBuildAppResult
    if ('missing' in read) {
      attempted = undefined
      result = { ok: false, message: `${entry} is missing` }
    } else if ('failed' in read) {
      attempted = undefined
      result = { ok: false, message: `${entry} could not be read: ${read.failed}` }
    } else if (attempted?.hash === read.hash) {
      result = attempted.result
    } else {
      const compiled = await compile(read.text)
      result = compiled.ok
        ? { ok: true, surfaceIds: compiled.surfaceIds }
        : { ok: false, message: `${entry} did not build: ${compiled.message}` }
      if (compiled.ok) built = { body: read.text, hash: read.hash, surfaceIds: compiled.surfaceIds }
      attempted = { hash: read.hash, result }
    }
    buildError = result.ok ? undefined : { kind: 'build', message: result.message }
    return result
  }

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  const build = (): Promise<ModsBuildAppResult> =>
    enqueue(async () => {
      const result = await buildEntry()
      await readData()
      emit()
      return result
    })

  /** A build only when the entry changed since the last attempt. */
  const buildIfChanged = (): Promise<void> =>
    enqueue(async () => {
      const read = await readText(fs, entryPath)
      const changed = !('text' in read) || read.hash !== attempted?.hash
      if (changed) await buildEntry()
      await readData()
      emit()
    })

  const tool = declareTool({
    name: BUILD_APP_TOOL_NAME,
    discoveryHint: "build this app's A2UI entry file and show it to the person",
    argsSchema: { type: 'object', properties: {} },
    description: async () =>
      `Build this app from \`${entry}\` and show the result to the person. Call it after you change the app's files, once your edits are done; it returns the surfaces built, or the error to fix.`,
    readsOnly: () => true,
    async call() {
      const result = await build()
      return { data: buildReport(entry, result, errors()), ...(result.ok ? {} : { isError: true }) }
    },
  }) as ToolContract<Record<string, never>, string>

  const releaseBuild = registerBuild(sessionId, build)

  return {
    async start() {
      await build()
      return published ?? emit()
    },
    build,
    noteWrite(absPath) {
      if (!dataKey || pathCompareKey(normalizeRuntimePath(absPath)) !== dataKey) return
      if (pendingData) return
      pendingData = true
      queueMicrotask(() => {
        pendingData = false
        void enqueue(async () => {
          await readData()
          emit()
        }).catch(error => console.warn('[mods/app] data read failed', error))
      })
    },
    promptBlock: appPromptBlock(app),
    tool,
    wrapTurnEndCheck(inner, makeNote) {
      return async params => {
        const notes = await inner(params)
        await buildIfChanged()
        const drawn = replyDrawsAppSurface(params.assistantMessages, built?.surfaceIds ?? [])
        if (drawn.length === 0) return notes
        const ids = drawn.map(id => `"${id}"`).join(', ')
        const text = `Your reply drew the app's surface ${ids} in chat; that block is not shown. The app's surfaces are built from ${entry} alone: change that file and call ${BUILD_APP_TOOL_NAME}. Add at most one short sentence for the person.`
        return [...notes, makeNote(text)]
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      // A newer runtime of the same session may own the entry by now.
      if (releaseBuild()) publish(sessionId, null)
    },
  }
}
