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
  AppSurfaceDelta,
  AppSurfaceState,
  ModsAppActionResult,
  ModsBuildAppResult,
  AppCatalogName,
} from '../../browser/runtimeProtocol/modApps'
import { blockSurfaceIds, hasA2uiBlock, splitA2uiText } from '../../toolkit/builtin/a2ui/express/a2uiBlocks'
import { dispatchAppAction, dispatchAppActionOutcome, dispatchAppRestartScript, dispatchAppShowAgain, type AppActionDispatch, type AppActionOutcomeDispatch } from './appActionBus'
import { appActionPromptLine, createAppActionTool, type AppActionToolInput } from './appActionTool'
import { hashOf, seedAppFolder, SEED_MAX_FILE_BYTES, type AppSeedFs } from './appSeed'
import type { AppSessionInfo } from './appSession'
import { liveAppState, onAppState, type AppStateEvent, type AppStateSource } from './appStateBus'
import { appSurfaceDelta } from './appSurfaceDelta'
import { setAppActor, setAppBuilder, setAppRefresher, setAppReseeder, setAppSurfaceState, type AppActor, type AppRefresh, type AppReseed, type AppSurfaceLiveData } from './appSurfaceRegistry'
import { appReseedKeep, namedError } from './appReseed'
import { readAppText } from './appText'
import { BUILD_APP_TOOL_NAME } from './appToolNames'

/** The app's live state, while its background module holds one. */
export type AppLiveData = {
  snapshot(appId: string): AppStateSource | undefined
  subscribe(appId: string, listener: (event: AppStateEvent) => void): () => void
}

export { BUILD_APP_TOOL_NAME }

export type AppEntryCompile = (body: string) => Promise<{ ok: true; surfaceIds: string[] } | { ok: false; message: string }>

export type AppSurfaceHostOptions = {
  fs: Pick<RuntimeFs, 'readFileBytes' | 'stat'>
  /** Writes the app's folder when a hand-placed plugin's seed is read again at a press (`app.devSeedDir`). Absent: never. */
  seedFs?: AppSeedFs
  app: AppSessionInfo
  sessionId: string
  /** Compiles an entry body; defaults to the runtime's Express compiler. */
  compile?: AppEntryCompile
  /** Where a changed state goes; defaults to the realm registry. */
  publish?: typeof setAppSurfaceState
  /**
   * Where `mods.buildApp` finds this build; defaults to the realm registry.
   * The result forgets it, and is true while it was still this host's.
   */
  registerBuild?: (sessionId: string, build: () => Promise<ModsBuildAppResult>) => () => boolean
  /** Where `mods.appAction` finds this host; defaults to the realm registry, released as the build is. */
  registerActor?: (sessionId: string, act: AppActor) => () => boolean
  /** Where `$.app.reseed()` finds this host; defaults to the realm registry, released as the build is. */
  registerReseeder?: (sessionId: string, appId: string, reseed: AppReseed) => () => boolean
  /** Where `mods.appRefresh` finds this host; defaults to the realm registry, released as the build is. */
  registerRefresher?: (sessionId: string, refresh: AppRefresh) => () => boolean
  /** Raises the app's `app.show` again; defaults to the realm bus. */
  showAgain?: (appId: string) => Promise<void>
  /** At Reinstall: loads the app's running script again from its files; defaults to the realm bus. */
  restartScript?: (appId: string) => Promise<void>
  /** The background module's state, read in place of the data file while there is one; defaults to the realm bus. */
  liveData?: AppLiveData
  /** Offers a local action to the app's background module; defaults to the realm bus. */
  dispatchAction?: AppActionDispatch
  /** Offers an action of the model's (`AppAction`) to the app's background module; defaults to the realm bus. */
  dispatchActionOutcome?: AppActionOutcomeDispatch
  /** The session's language: the plugin's text for it is set under `/text`. */
  locale?: string
  now?: () => number
}

export type TurnEndCheck = (params: { messages: Message[]; assistantMessages: Message[] }) => Promise<Message[]>

export type AppSurfaceHost = {
  /** The first build, at session open. */
  start(): Promise<AppSurfaceState>
  /** Builds the entry and reads the data; builds run one at a time. */
  build(): Promise<ModsBuildAppResult>
  /** A plugin's write at `absPath`: the data is read again when it is the data file. */
  noteWrite(absPath: string): void
  /**
   * A surface action of the person's: offered to the app's background module
   * when the manifest names it local, with `refreshing` published while the
   * module has it; `{handled: false}` for any other action, or when the
   * module did not take it.
   */
  action(name: string, context: unknown): Promise<ModsAppActionResult>
  /** The session's system-prompt block for the app. */
  promptBlock: string
  /** The model's way to build the app: offered in this session alone. */
  tool: ToolContract<Record<string, never>, string>
  /** The model's way to run one of the app's declared actions; absent when the app declares none. */
  actionTool?: ToolContract<AppActionToolInput, string>
  /** The session's app tools, added by the host: a plugin neither removes nor replaces them. */
  tools: ToolContract[]
  /**
   * The turn-end check of an app session: `inner`'s notes, then a build when
   * the entry changed since the last one, then a note when the reply drew one
   * of the app's surfaces in chat.
   */
  wrapTurnEndCheck(inner: TurnEndCheck, makeNote: (text: string) => Message): TurnEndCheck
  /** The session closed: its state leaves the registry. */
  dispose(): void
}

type CompiledMessages = { ok: true; messages: readonly unknown[] } | { ok: false; message: string }

/** The entry's messages under the component set the app names. */
async function compileMessages(body: string, catalog: AppCatalogName | undefined): Promise<CompiledMessages> {
  if (catalog === 'studio') {
    const { getRuntimeStudioCompiler } = await import('../../toolkit/builtin/a2ui/express/studioRuntimeCompiler')
    return (await getRuntimeStudioCompiler()).compile(body)
  }
  const { getRuntimeA2uiCompiler } = await import('../../toolkit/builtin/a2ui/express/a2uiRuntimeCompiler')
  const compiler = await getRuntimeA2uiCompiler()
  return compiler.compile(body, compiler.createState())
}

async function defaultCompile(body: string, catalog?: AppCatalogName): Promise<{ ok: true; surfaceIds: string[] } | { ok: false; message: string }> {
  const result = await compileMessages(body, catalog)
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


const liveHash = (owner: number, version: number): string => `live:${owner}:${version}`

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
  const { entry, data, catalog } = app.decl
  const head = [
    `# This session is an app`,
    `This session runs the app "${app.appId}" of the plugin "${app.plugin}". Its folder is the project root; AGENTS.md there says what the app is for.`,
  ]
  const actionLine = appActionPromptLine(app.decl.localActions ?? [])
  const dataLine = data
    ? `- The app's data is \`${data}\`, set under $/data on each of its surfaces: bind to $/data/... . A2UI does no arithmetic, so every figure shown must already be in the data.`
    : `- The app has no data file; its values are written in \`${entry}\`.`
  if (catalog === 'studio') {
    return [
      ...head,
      `- What the person sees is built from \`${entry}\`, an A2UI Express file with one surface("..."), written for the studio component set. Load the a2ui skill before you edit it: in this session it lists that set's components and their arguments, and the file may use no other.`,
      `- After you change the app's files, call ${BUILD_APP_TOOL_NAME}: it builds \`${entry}\`, shows the result to the person and returns any error to fix. Never write an <a2ui> block in chat in this session: the app's surface is the one place it draws.`,
      dataLine,
      ...actionLine,
    ].join('\n')
  }
  return [
    ...head,
    `- What the person sees is built from \`${entry}\`, an A2UI Express file with one surface("..."). The app's pages are a Tabs component in that surface, as in \`root = Tabs([{title: "Overview", child: overview}, {title: "Refunds", child: refunds}])\`: the person switches between them, and a new build keeps the tab they are on. Load the a2ui skill before you edit it: it has the grammar and the components.`,
    `- After you change the app's files, call ${BUILD_APP_TOOL_NAME}: it builds \`${entry}\`, shows the result to the person and returns any error to fix. Never write an <a2ui> block in chat for one of the app's surfaces; a chart that answers a question in chat is fine.`,
    dataLine,
    ...actionLine,
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
  const catalog = app.decl.catalog
  const compile = options.compile ?? ((body: string) => defaultCompile(body, catalog))
  const publish = options.publish ?? setAppSurfaceState
  const registerBuild = options.registerBuild ?? setAppBuilder
  const registerActor = options.registerActor ?? setAppActor
  const registerReseeder = options.registerReseeder ?? setAppReseeder
  const registerRefresher = options.registerRefresher ?? setAppRefresher
  const showAgain = options.showAgain ?? dispatchAppShowAgain
  const restartScript = options.restartScript ?? dispatchAppRestartScript
  const live: AppLiveData = options.liveData ?? { snapshot: liveAppState, subscribe: onAppState }
  const dispatchAction = options.dispatchAction ?? dispatchAppAction
  const dispatchActionOutcome = options.dispatchActionOutcome ?? dispatchAppActionOutcome
  const now = options.now ?? Date.now
  const entry = app.decl.entry
  const localActions = app.decl.localActions ?? []
  const entryPath = joinRuntimePath(app.folder, entry)
  const dataPath = app.decl.data ? joinRuntimePath(app.folder, app.decl.data) : undefined
  const dataKey = dataPath ? pathCompareKey(normalizeRuntimePath(dataPath)) : undefined

  let built: AppSurfaceBuild | null = null
  let buildError: AppSurfaceError | undefined
  /** `live`: the app's script holds the value, which is then not kept here. */
  let data: { value?: unknown; at: number; hash: string; live?: { owner: number; version: number } } | undefined
  let dataError: AppSurfaceError | undefined
  /** The plugin's text in the session's language, read at each build. */
  let text: Record<string, string> | undefined
  /** Counts the data values this host published. */
  let dataSeq = 0
  /** The patches from the last published data to the current one; one publish only. */
  let dataPatches: AppSurfaceState['dataPatches']
  let unsubscribeLive: (() => void) | undefined
  /** The entry hash of the last build attempt and what it gave, so an unchanged entry is not compiled again. */
  let attempted: { hash: string; result: ModsBuildAppResult } | undefined
  let published: AppSurfaceState | undefined
  let disposed = false
  let seedConflicts: readonly string[] = app.seed.conflicts
  let queue: Promise<unknown> = Promise.resolve()
  let pendingData = false
  /** Counts the local actions the background module has in hand. */
  let acting = 0

  const errors = (): AppSurfaceError[] => [buildError, dataError].filter((e): e is AppSurfaceError => e !== undefined)

  const emit = (): AppSurfaceState => {
    const list = errors()
    const state: AppSurfaceState = {
      appId: app.appId,
      surface: built,
      ...(catalog ? { catalog } : {}),
      ...(data ? { ...(data.live ? {} : { data: data.value }), dataAt: data.at, dataSeq } : {}),
      ...(data && dataPatches ? { dataPatches } : {}),
      ...(text ? { text } : {}),
      refreshing: acting > 0,
      ...(list.length > 0 ? { errors: list } : {}),
      ...(seedConflicts.length > 0 ? { seedConflicts: [...seedConflicts] } : {}),
      ...(localActions.length > 0 ? { localActions: [...localActions] } : {}),
    }
    dataPatches = undefined
    if (disposed) return state
    // A board with the same `dataSeq` has the same data: only its other fields are compared.
    const delta = published ? appSurfaceDelta(published, state) : undefined
    if (delta === null) return state
    published = state
    publish(sessionId, state, delta, data?.live ? loadLive : undefined)
    return state
  }

  /** The data of a board whose script holds it, numbered as this host numbers what it published. */
  const loadLive = async (): Promise<AppSurfaceLiveData> => {
    const source = live.snapshot(app.appId)
    if (!source) throw new Error(`${app.appId}: its script stopped`)
    const read = await source.read()
    const held = data?.live
    if (!held || held.owner !== source.owner) throw new Error(`${app.appId}: its script stopped`)
    return { data: read.value, dataSeq: dataSeq + (read.version - held.version), dataAt: data!.at }
  }

  const setLive = (owner: number, version: number): void => {
    const hash = liveHash(owner, version)
    if (data?.hash === hash) return
    data = { at: now(), hash, live: { owner, version } }
    dataError = undefined
    dataSeq += 1
  }

  const setData = (value: unknown, at: number, hash: string): void => {
    if (data?.hash === hash) return
    data = { value, at, hash }
    dataError = undefined
    dataSeq += 1
  }

  const readData = async (): Promise<void> => {
    const snapshot = live.snapshot(app.appId)
    if (snapshot) {
      setLive(snapshot.owner, snapshot.version())
      return
    }
    if (!dataPath) return
    const read = await readText(fs, dataPath)
    if ('failed' in read) {
      dataError = { kind: 'data', message: `${app.decl.data} could not be read: ${read.failed}` }
    } else if ('missing' in read) {
      dataError = undefined
      data = undefined
    } else if (read.hash !== data?.hash) {
      try {
        setData(JSON.parse(read.text), read.mtimeMs, read.hash)
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

  const readTexts = async (): Promise<void> => {
    if (app.root === undefined) return
    text = await readAppText(
      async path => {
        const read = await readText(fs, path)
        return 'text' in read ? read.text : undefined
      },
      app.root,
      options.locale,
    )
  }

  const build = (): Promise<ModsBuildAppResult> =>
    enqueue(async () => {
      const result = await buildEntry()
      await readData()
      await readTexts()
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

  /** A hand-placed plugin's edited seed reaches the folder at the next press; files the person edited are kept and published as conflicts. */
  const reseed = async (): Promise<void> => {
    if (!app.devSeedDir || !options.seedFs) return
    try {
      const result = await seedAppFolder({
        fs: options.seedFs,
        seedDir: app.devSeedDir,
        appDir: app.folder,
        appId: app.appId,
        plugin: app.plugin,
        seedVersion: app.decl.seedVersion,
        everyOpen: true,
      })
      seedConflicts = result.conflicts
    } catch (error) {
      console.warn('[mods/app] seed copy failed', error)
    }
  }

  /** One action in the module's hands: `refreshing` is published around it, and a hand-placed plugin's seed is read before and built after. */
  const offer = async <T>(run: () => Promise<T>): Promise<T> => {
    acting += 1
    emit()
    try {
      if (app.devSeedDir && options.seedFs) await reseed()
      return await run()
    } finally {
      acting -= 1
      if (app.devSeedDir && options.seedFs && !disposed) await buildIfChanged().catch(() => undefined)
      emit()
    }
  }

  const action = async (name: string, context: unknown): Promise<ModsAppActionResult> => {
    if (disposed || !localActions.includes(name)) return { handled: false }
    try {
      return { handled: (await offer(() => dispatchAction(app.appId, name, context, sessionId))) === true }
    } catch {
      return { handled: false }
    }
  }

  const actionTool = localActions.length > 0
    ? createAppActionTool({
        actions: localActions,
        run: (name, context) =>
          disposed ? Promise.resolve({ status: 'unavailable' }) : offer(() => dispatchActionOutcome(app.appId, name, context, sessionId)),
      })
    : undefined

  /**
   * `$.app.reseed()`: the seed's files over the folder again, the person's
   * config and data kept, then a build. Rejects with `AppBuildError` when the
   * entry does not build; the person keeps the previous page.
   */
  const reseedAll = async (): Promise<void> => {
    const seedDir = app.devSeedDir ?? app.seedDir
    if (disposed) throw namedError('AbortError', 'the app is closed')
    if (!seedDir || !options.seedFs) throw namedError('NotSupportedError', 'this app has no seed folder to copy again')
    const result = await seedAppFolder({
      fs: options.seedFs,
      seedDir,
      appDir: app.folder,
      appId: app.appId,
      plugin: app.plugin,
      seedVersion: app.decl.seedVersion,
      reseed: { keep: appReseedKeep(app.decl) },
    })
    seedConflicts = result.conflicts
    const built = await build()
    if (!built.ok) throw namedError('AppBuildError', built.message)
  }

  const releaseBuild = registerBuild(sessionId, build)
  const releaseActor = registerActor(sessionId, action)
  const releaseReseeder = registerReseeder(sessionId, app.appId, reseedAll)

  /** Refresh: the entry built again and `app.show` raised; a failed build keeps the previous page and raises nothing. Reinstall: the seed copied, then the app's running script loaded again from its files. */
  const refresh: AppRefresh = async reinstall => {
    if (reinstall) {
      try {
        await reseedAll()
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      // The script's files may have changed in place too: it loads again, and hears app.show once loaded.
      await restartScript(app.appId).catch(error => console.warn('[mods/app] the app script did not restart', error))
      return { ok: true, surfaceIds: built?.surfaceIds ?? [] }
    }
    const result = await build()
    if (!result.ok) return result
    await showAgain(app.appId).catch(error => console.warn('[mods/app] app.show failed', error))
    return result
  }
  const releaseRefresher = registerRefresher(sessionId, refresh)

  return {
    async start() {
      unsubscribeLive ??= live.subscribe(app.appId, event => {
        if (disposed) return
        if (event.gone) {
          // The data file is the state again.
          void enqueue(async () => {
            await readData()
            emit()
          }).catch(error => console.warn('[mods/app] data read failed', error))
          return
        }
        const from = dataSeq
        // The patches lead from the script's version before this one: valid only onto that value.
        const follows = data?.hash === liveHash(event.owner, event.version - 1)
        setLive(event.owner, event.version)
        if (dataSeq !== from && follows && event.patches) dataPatches = { from, patches: [...event.patches] }
        emit()
      })
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
    action,
    promptBlock: appPromptBlock(app),
    tool,
    ...(actionTool ? { actionTool } : {}),
    tools: [tool, ...(actionTool ? [actionTool] : [])] as ToolContract[],
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
      unsubscribeLive?.()
      unsubscribeLive = undefined
      // A newer runtime of the same session may own the entry by now.
      releaseActor()
      releaseReseeder()
      releaseRefresher()
      if (releaseBuild()) publish(sessionId, null)
    },
  }
}
