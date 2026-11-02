import { createPublicationReceiptStore } from './publication-store'
import { parseReviewArguments, isReviewLevel } from './arguments'
import { planVerification, runVerification } from './verification'
import { presentReviewJson } from './presenter'
import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'
import { resolveModelId } from '../config/nexusModelConfig/modelEntryResolution'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { PromptContextProvider } from '../runtime/interfaces/PromptContextProvider'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { resolveRuntimePath, dirnameRuntimePath, isAbsoluteRuntimePath } from '../utils/runtimePaths'
import { buildFilePermissionContext, decideToolPermission, requestQueuedToolUseConfirm, resolveHeadlessPermissionDecision } from '../toolkit/run/toolPermissionGate'
import { declareTool, dropDeniedTools } from '../toolkit/toolContract'
import { nestedToolGatesOf } from '../toolkit/run/toolLifecycleHooks'
import { vetFileRead } from '../permissions/filesystemPermission'
import { gatherInstructionDocs, getNestedInstructionFilesForPath, getConditionalRulesForPath, formatMemoryFilesForPrompt } from '../memory/instructionFiles'
import { assertUntrustedReadAllowed } from '../permissions/untrustedReadBoundary'
import { isFsNotFoundError } from '../utils/fsTransportFailure'
import { createGitArgvRunner, gitText, validateReviewPath, type GitStreamSpawner } from './git-adapter'
import { resolveLocalReviewScope, reviewDigest, type WorkspaceRead, type LocalReviewTarget } from './scope'
import { LocalReviewService, ReviewGatewayError } from './service'
import { createReviewModelRunner } from './runner'
import { registerReviewSession } from './review-channel'
import type { ReviewReportView } from './review-protocol'
import type { ReportSnapshot } from './report-store'
import { SuperEditTool } from '../toolkit/builtin/superEdit'
import type { ReviewPreferences } from './contracts'
import { bindChangeRequestTarget, createReviewPlatformReader, createReviewPlatformPublisher, type ReviewHttpRequest, type ChangeRequestSnapshot } from './platform-adapter'

export interface ReviewRuntimeDependencies {
  sessionLevel?: () => string | undefined
  spawnArgv: GitStreamSpawner
  httpRequest?: ReviewHttpRequest
  platformSecret?: (origin: string) => Promise<import('./platform-adapter').PlatformSecret | undefined>
  atomicWrite?: (path: string, content: string) => Promise<void>
  promptContextProvider: PromptContextProvider
  deps?: QueryRuntimeDeps
}
const publicationOwners = new Map<string, object>()
const services = new WeakMap<object, LocalReviewService>()
const contexts = new WeakMap<object, ToolCallContext>()
const pendingServices = new WeakMap<object, Promise<LocalReviewService>>()
const normalized = (path: string) => { const slashed = path.replace(/\\/g, '/'); return /^(?:[A-Za-z]:)?\/$/.test(slashed) ? slashed : slashed.replace(/\/$/, '') }
const equal = (a: string, b: string) => /^[A-Za-z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b
const below = (path: string, root: string) => equal(path, root) || ( /^[A-Za-z]:/.test(root) ? path.toLowerCase().startsWith(root.toLowerCase() + '/') : path.startsWith(root + '/'))
const sanitize = (text: string) => text.replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[redacted]').replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g, '[redacted]')

export async function getOrCreateReviewService(incomingContext: ToolCallContext, decidePermission: PermissionDecider): Promise<LocalReviewService> {
  const identity = incomingContext.options.runtimeConfig ?? incomingContext.options
  contexts.set(identity, incomingContext)
  const pending = pendingServices.get(identity)
  if (pending) return pending
  const promise = buildReviewService(incomingContext, decidePermission)
  pendingServices.set(identity, promise)
  try { return await promise } finally { if (pendingServices.get(identity) === promise) pendingServices.delete(identity) }
}
async function buildReviewService(incomingContext: ToolCallContext, decidePermission: PermissionDecider): Promise<LocalReviewService> {
  const identity = incomingContext.options.runtimeConfig ?? incomingContext.options
  contexts.set(identity, incomingContext)
  const context = new Proxy(incomingContext, { get(_target, key) { return Reflect.get(contexts.get(identity)!, key) } })
  const existing = services.get(identity)
  if (existing) return existing
  const runtime = context.options.reviewRuntime
  const fs = context.options.fsOperations
  if (!runtime || !fs?.realpath) throw new ReviewGatewayError('review-runtime-unavailable')
  const root = normalized(await fs.realpath(context.options.projectRoot, { resolveLinks: true }))
  const configuredBase = context.options.sessionStorageBase ?? context.options.sessionStoragePath
  if (!configuredBase || !isAbsoluteRuntimePath(configuredBase) || !/^[A-Za-z0-9_-]+$/.test(context.options.sessionId)) throw new ReviewGatewayError('review-storage-unavailable')
  const storageBase = normalized(resolveRuntimePath(configuredBase, '.'))
  if (below(storageBase, root)) throw new ReviewGatewayError('review-storage-unavailable')
  const sharedBase = context.options.sessionStoragePath ?? configuredBase
  if (!isAbsoluteRuntimePath(sharedBase) || below(normalized(sharedBase), root)) throw new ReviewGatewayError('review-storage-unavailable')
  const storageRoot = resolveRuntimePath(sharedBase, 'code-review')
  const sessionDir = resolveRuntimePath(storageBase, `${context.options.sessionId}/code-review`)
  const preferencePath = resolveRuntimePath(storageRoot, 'preferences.json')
  const storageAllowed = (path: string) => below(path, normalized(storageRoot)) || below(path, normalized(sessionDir))
  // Security: validate every existing ancestor and destination; an application namespace cannot redirect through a workspace junction.
  async function guardStorage(path: string): Promise<void> {
    const destination = normalized(resolveRuntimePath(path, '.'))
    if (!storageAllowed(destination)) throw new ReviewGatewayError('review-storage-not-authorized')
    let current = destination
    for (;;) {
      try {
        const actual = normalized(await fs!.realpath!(current, { resolveLinks: true }))
        if (!equal(actual, current) || below(actual, root)) throw new ReviewGatewayError('review-storage-not-authorized')
      } catch (error) { if (!isFsNotFoundError(error)) throw error }
      const parent = normalized(dirnameRuntimePath(current))
      if (equal(parent, current) || !parent) break
      current = parent
    }
  }
  async function prepareStorage(path: string): Promise<void> {
    await guardStorage(path)
    const parent = dirnameRuntimePath(path)
    await fs!.mkdir(parent)
    await guardStorage(path)
  }
  await guardStorage(sessionDir)
  await guardStorage(storageRoot)
  async function readJson(path: string): Promise<unknown> {
    await guardStorage(path)
    try { return JSON.parse(await fs!.readFile(path, { encoding: 'utf-8' })) }
    catch (error) { if (isFsNotFoundError(error)) return undefined; throw error }
  }
  async function writeSerialized(path: string, serialized: string): Promise<void> {
    if (!runtime!.atomicWrite) throw new ReviewGatewayError('review-storage-unavailable')
    await prepareStorage(path)
    await runtime!.atomicWrite(path, serialized)
  }
  async function writeJson(path: string, value: unknown): Promise<void> { await writeSerialized(path, JSON.stringify(value)) }
  const authorizeAction = async (name: string, input: Record<string, unknown>, forceAsk = false) => {
    const tool = declareTool({ name, description: async () => name, readsOnly: () => name === 'Read',
      selfVerdict: async () => ({ behavior: forceAsk ? 'ask' as const : 'allow' as const, updatedInput: input }), call: async () => ({ data: null }) })
    const hooks = await nestedToolGatesOf(context).preHooks(name, input, crypto.randomUUID(), context)
    if (hooks.blocked) return false
    const verdict = await decideToolPermission(tool, input, context)
    if (verdict.decision === 'deny') return false
    if (verdict.decision === 'allow') return true
    const mode = context.readAppState().permissionRules
    if (mode.mode === 'dontAsk') return false
    if (mode.suppressAsks) return (await resolveHeadlessPermissionDecision(tool, input, crypto.randomUUID(), context)).behavior === 'allow'
    return (await requestQueuedToolUseConfirm({ tool, input, message: verdict.message, metadata: verdict.metadata, callRef: crypto.randomUUID(),
      modelReply: { type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [] } }, callContext: context }))?.behavior === 'allow'
  }
  const authorizePath = async (absolute: string) => {
    const hooks = await nestedToolGatesOf(context).preHooks('Read', { file_path: absolute }, crypto.randomUUID(), context)
    if (hooks.blocked) throw new ReviewGatewayError('review-read-not-authorized')
    const boundary = await assertUntrustedReadAllowed(absolute, context, fs)
    if (!boundary.ok) throw new ReviewGatewayError('review-read-not-authorized')
    const result = await vetFileRead('Read', { file_path: absolute }, buildFilePermissionContext(context, context.readAppState().permissionRules))
    if (result.behavior === 'deny') throw new ReviewGatewayError('review-read-not-authorized')
    if (result.behavior === 'ask') {
      if (!await authorizeAction('Read', { file_path: absolute })) throw new ReviewGatewayError('review-read-not-authorized')
    }
  }
  const readWorkspaceFile = async (path: string, maxBytes: number, signal?: AbortSignal): Promise<WorkspaceRead> => {
    validateReviewPath(path)
    if (signal?.aborted) throw new ReviewGatewayError('review-cancelled')
    const absolute = resolveRuntimePath(root, path)
    let canonical: string
    try { canonical = normalized(await fs!.realpath!(absolute, { resolveLinks: true })) }
    catch (error) { if (isFsNotFoundError(error)) return { kind: 'missing' }; throw error }
    if (!below(canonical, root) || !equal(canonical, normalized(absolute))) return { kind: 'symlink' }
    await authorizePath(absolute)
    try {
      const stat = await fs!.stat(absolute)
      if (stat.isSymbolicLink()) return { kind: 'symlink' }
      if (stat.isDirectory()) return { kind: 'directory' }
      if (!stat.isFile()) return { kind: 'unreadable' }
      if (stat.size > maxBytes) return { kind: 'large' }
      return { kind: 'file', bytes: await fs!.readFileBytes(absolute, maxBytes) }
    } catch (error) { if (isFsNotFoundError(error)) return { kind: 'missing' }; throw error }
  }
  const guidanceFor = async (paths: string[]) => {
    if (!context.options.runtimeConfig) return { text: '', sources: [] as Array<{ path: string; revision: string; excerpt: string }> }
    const guardedFs = new Proxy(fs, { get(target, key) {
      if (key === 'readFile') return async (path: string, options: { encoding: string }) => { await authorizePath(path); return target.readFile(path, options) }
      if (key === 'readdir') return async (path: string) => { await authorizePath(path); return target.readdir(path) }
      const value = target[key as keyof RuntimeFs]
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const params = { cwd: root, projectRoot: root, homeDir: context.options.homeDir, readRoot: context.options.untrustedReadRoot,
      runtimeConfig: context.options.runtimeConfig, fs: guardedFs, memorySettings: context.options.memorySettings }
    const docs = await gatherInstructionDocs(params)
    for (const path of paths) {
      docs.push(...await getNestedInstructionFilesForPath(resolveRuntimePath(root, path), params))
      docs.push(...await getConditionalRulesForPath(resolveRuntimePath(root, path), params))
    }
    const selected = docs.filter((doc, index) => docs.findIndex(other => other.path === doc.path) === index)
    const sources = await Promise.all(selected.filter(doc => below(normalized(doc.path), root) && !equal(normalized(doc.path), root)).map(async doc => ({
      path: normalized(doc.path).slice(root.length + 1), revision: `guidance:${await reviewDigest(doc.content)}`, excerpt: doc.content,
    })))
    return { text: formatMemoryFilesForPrompt(selected), sources }
  }
  const scopeGit = async () => {
    const git = await createGitArgvRunner(runtime.spawnArgv, { authorizeRoot: async () => {
    await authorizePath(root)
    const dotGit = resolveRuntimePath(root, '.git')
    await authorizePath(dotGit)
    const stat = await fs.stat(dotGit)
    let gitDir = dotGit
    if (stat.isFile()) {
      const marker = await fs.readFile(dotGit, { encoding: 'utf-8' })
      const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(marker)
      if (!match) throw new ReviewGatewayError('invalid-git-directory')
      gitDir = resolveRuntimePath(root, match[1])
    }
    gitDir = normalized(await fs.realpath!(gitDir, { resolveLinks: true }))
    await authorizePath(gitDir)
    let commonDir = gitDir
    const commonMarker = resolveRuntimePath(gitDir, 'commondir')
    try {
      const actualMarker = normalized(await fs.realpath!(commonMarker, { resolveLinks: true }))
      await authorizePath(actualMarker)
      const relative = (await fs.readFile(actualMarker, { encoding: 'utf-8' })).trim()
      if (!relative || /[\r\n\0]/.test(relative)) throw new ReviewGatewayError('invalid-git-directory')
      commonDir = normalized(await fs.realpath!(resolveRuntimePath(gitDir, relative), { resolveLinks: true }))
    } catch (error) { if (!isFsNotFoundError(error)) throw error }
    await authorizePath(commonDir)
    for (const metadata of [resolveRuntimePath(commonDir, 'config'), resolveRuntimePath(gitDir, 'config.worktree'), resolveRuntimePath(gitDir, 'index'), resolveRuntimePath(commonDir, 'objects')]) {
      let actual = metadata
      try { actual = normalized(await fs.realpath!(metadata, { resolveLinks: true })) }
      catch (error) { if (!isFsNotFoundError(error)) throw error }
      await authorizePath(actual)
    }
    return { root, gitDir, commonDir }
  } })
    const objects = new Map<string, Set<string>>()
    const rememberTree = (bytes: Uint8Array) => {
      for (const line of new TextDecoder().decode(bytes).split('\0')) {
        const match = /^\d+ blob ([a-f0-9]+)\t([\s\S]+)$/.exec(line)
        if (match) { const paths = objects.get(match[1]) ?? new Set<string>(); paths.add(validateReviewPath(match[2])); objects.set(match[1], paths) }
      }
    }
    return { root: git.root, async query(query: import('./git-adapter').GitQuery, signal?: AbortSignal) {
      if (query.kind === 'blob') {
        const paths = objects.get(query.oid)
        if (!paths?.size) throw new ReviewGatewayError('review-object-not-authorized')
        for (const path of paths) await authorizePath(resolveRuntimePath(root, path))
      }
      if (query.kind === 'diff') {
        for (const oid of [query.base, query.head]) {
          const tree = await git.query({ kind: 'tree', oid }, signal)
          if (tree.exitCode !== 0) throw new ReviewGatewayError('review-context-unavailable')
          rememberTree(tree.stdout)
          for (const line of new TextDecoder().decode(tree.stdout).split('\0').filter(Boolean)) {
            const path = line.slice(line.indexOf('\t') + 1)
            if (!query.paths?.length || query.paths.some(p => path === p || path.startsWith(p + '/'))) await authorizePath(resolveRuntimePath(root, validateReviewPath(path)))
          }
        }
      }
      const result = await git.query(query, signal)
      if (query.kind === 'tree' && result.exitCode === 0) rememberTree(result.stdout)
      return result
    } }
  }
  const receiptFile = resolveRuntimePath(storageRoot, 'publication-receipts.json')
  const receiptOwner = publicationOwners.get(receiptFile) ?? {}
  publicationOwners.set(receiptFile, receiptOwner)
  const durableReceipts = createPublicationReceiptStore({
    async read() { const value = await readJson(receiptFile); return value ? JSON.stringify(value) : null },
    async writeAtomic(serialized) { await writeSerialized(receiptFile, serialized) },
  }, receiptOwner)
  const currentCapabilities = () => {
    const rules = context.readAppState().permissionRules
    const agents = dropDeniedTools(context.options.tools, { denyRuleBook: rules.denyRuleBook ?? {} }).filter(tool => tool.name === 'Agent' && tool.offeredNow())
    return { agentAvailable: agents.length > 0, agentPermitted: rules.mode !== 'plan' && agents.length > 0,
      remainingDepth: Math.max(0, 3 - (context.turnChain?.depth ?? 0)), outputToolAvailable: true, workerConcurrency: 4,
      coordinator: context.options.templateType === 'team', coordinatorCanExecuteSkill: context.options.tools.some(tool => tool.name === 'Skill' && tool.offeredNow()), coordinatorWorkerAvailable: agents.length > 0,
      supportedReasoningLevels: findConfiguredModel(context.options.mainLoopProviderId, context.options.mainLoopModel)?.availableThinkingTiers?.filter(isReviewLevel) }
  }
  const remoteKey = (scope: ReportSnapshot['run']['scope']) => JSON.stringify([
    scope.repository.platform, scope.repository.platform === 'github' ? 'https://github.com' : 'https://gitlab.com',
    scope.repository.projectKey, scope.request?.number, scope.revision.base, scope.revision.head, scope.request?.headRevision,
  ])
  const remoteSnapshots = new Map<string, ChangeRequestSnapshot>()
  const service = new LocalReviewService({
    conversationKey: context.options.sessionId, get modelId() { return resolveModelId(context.options.mainLoopProviderId, context.options.mainLoopModel) },
    get sessionLevel() { const level = context.options.reviewRuntime?.sessionLevel?.(); return level && isReviewLevel(level) ? level : undefined },
    savePresentation: (id, value) => writeJson(resolveRuntimePath(sessionDir, `presentation/${id}.json`), value),
    saveTarget: (id, target, targetLiteral) => writeJson(resolveRuntimePath(sessionDir, `targets/${id}.json`), { target, targetLiteral }),
    loadTarget: async id => (await readJson(resolveRuntimePath(sessionDir, `targets/${id}.json`)) as { target?: string } | undefined)?.target,
    loadTargetLiteral: async id => (await readJson(resolveRuntimePath(sessionDir, `targets/${id}.json`)) as { targetLiteral?: true } | undefined)?.targetLiteral,
    get capabilities() { return currentCapabilities() },
    output: 'terminal',
    get automaticVerificationPermitted() { return !['plan', 'dontAsk'].includes(context.readAppState().permissionRules.mode) },
    preferences: {
      async load() {
        const value = await readJson(preferencePath) as ReviewPreferences | undefined
        if (!value) return {}
        return { ...(['low', 'medium', 'high', 'xhigh', 'max'].includes(value.level ?? '') ? { level: value.level } : {}),
          ...(value.maxFindings === 'all' || Number.isSafeInteger(value.maxFindings) && Number(value.maxFindings) > 0 ? { maxFindings: value.maxFindings } : {}) }
      },
      save: value => writeJson(preferencePath, value),
    },
    storage: {
      async listRunIds() {
        await guardStorage(sessionDir)
        try { return (await fs.readdir(sessionDir)).filter(e => e.isFile() && /^[A-Za-z0-9_-]+\.json$/.test(e.name)).map(e => e.name.slice(0, -5)) }
        catch (error) { if (isFsNotFoundError(error)) return []; throw error }
      },
      async load(id) { const value = await readJson(resolveRuntimePath(sessionDir, `${id}.json`)); return value ? JSON.stringify(value) : null },
      async save(id, serialized) {
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ReviewGatewayError('invalid-run-id')
        await writeSerialized(resolveRuntimePath(sessionDir, `${id}.json`), serialized)
      },
    },
    sanitizeExcerpt: sanitize,
    runModel: request => createReviewModelRunner({ context, promptContextProvider: context.options.reviewRuntime!.promptContextProvider, decidePermission, deps: context.options.reviewRuntime!.deps })({ ...request,
      tools: request.tools.map(tool => tool.name !== 'Agent' ? tool : { ...tool, async call(input, callContext, permission, row, progress) {
        const caps = currentCapabilities()
        if (!caps.agentAvailable || !caps.agentPermitted || caps.remainingDepth < 1 || request.signal.aborted) throw new ReviewGatewayError('review-worker-not-authorized')
        const original = context.options.tools.find(candidate => candidate.name === 'Agent' && candidate.offeredNow())!
        const verdict = await decideToolPermission(original, input, context)
        if (verdict.decision === 'deny' || !await authorizeAction('Agent', input, verdict.decision === 'ask')) throw new ReviewGatewayError('review-worker-not-authorized')
        const latest = currentCapabilities()
        if (!latest.agentAvailable || !latest.agentPermitted || latest.remainingDepth < 1 || request.signal.aborted) throw new ReviewGatewayError('review-worker-not-authorized')
        return tool.call(input, callContext, permission, row, progress)
      } }),
    }),
    async resolveScope(args, plan, signal) {
      const git = await scopeGit()
      let target: LocalReviewTarget = { kind: 'workspace' }
      if (args.target) {
        if (!args.targetLiteral && (/^\d+$/.test(args.target) || /^https?:/.test(args.target))) {
          if (!runtime.httpRequest) throw new ReviewGatewayError('review-platform-adapter-required')
          const remotes = (await gitText(git, { kind: 'remotes' }, signal)).trim().split('\n').map(line => line.slice(line.indexOf(' ') + 1))
          const remoteTarget = bindChangeRequestTarget(remotes, args.target)
          const secret = await runtime.platformSecret?.(remoteTarget.platform === 'github' ? 'https://api.github.com' : remoteTarget.origin)
          const remoteReader = createReviewPlatformReader({ httpRequest: runtime.httpRequest, target: remoteTarget, workspaceKey: root, secret })
          const remote = await remoteReader.read(signal)
          for (const file of remote.manifest.files) {
            await authorizePath(resolveRuntimePath(root, file.path))
            if (plan.skipTestsAndFixtures && /(?:^|\/)(?:__tests__|tests?|fixtures)(?:\/|$)|\.(?:test|spec)\./i.test(file.path)) { file.status = 'skipped'; file.patch = ''; file.anchors = [] }
          }
          remote.manifest.anchors = remote.manifest.files.flatMap(file => file.anchors)
          if (remote.manifest.files.some(file => file.status !== 'included')) { remote.manifest.complete = false; remote.manifest.status = 'partial' }
          remoteSnapshots.set(remoteKey(remote.manifest.scope), remote)
          const guidance = await guidanceFor([])
          return { manifest: remote.manifest, trustedGuidance: guidance.text, evidenceSources: guidance.sources, async read(input, selectedPlan, readSignal) {
            if (input.operation === 'diff') return remote.manifest
            if (!selectedPlan.allowWholeFileReads) throw new ReviewGatewayError('whole-file-read-not-authorized')
            if (input.operation === 'search' && typeof input.query === 'string') return { files: remote.manifest.files.filter(file => file.patch.includes(input.query as string)), limitations: ['search-limited-to-remote-diff'] }
            if (input.operation === 'context' && typeof input.path === 'string') {
              validateReviewPath(input.path)
              await authorizePath(resolveRuntimePath(root, input.path))
              return remoteReader.readContext(remote, input.path, 'after', readSignal)
            }
            throw new ReviewGatewayError('remote-context-unavailable')
          } }
        }
        if (args.targetLiteral) target = { kind: 'paths', paths: [args.target.replace(/^\.\//, '')] }
        else if (args.target.includes('..')) {
          const path = args.target.replace(/^\.\//, '')
          const read = await readWorkspaceFile(path, 1, signal)
          target = read.kind !== 'missing' ? { kind: 'paths', paths: [path] } : { kind: 'range', expression: args.target }
        }
        else {
          const path = args.target.replace(/^\.\//, '')
          const read = await readWorkspaceFile(path, 1, signal)
          const ref = args.target.startsWith('./') ? undefined : await git.query({ kind: 'resolve', ref: args.target }, signal)
          if (read.kind !== 'missing' && ref?.exitCode === 0) throw new ReviewGatewayError('ambiguous-review-target')
          target = read.kind !== 'missing' ? { kind: 'paths', paths: [path] } : { kind: 'branch', ref: args.target }
        }
      }
      const manifest = await resolveLocalReviewScope({ git, workspaceKey: root, projectKey: root, readWorkspaceFile,
        skipPath: path => plan.skipTestsAndFixtures && /(?:^|\/)(?:__tests__|tests?|fixtures)(?:\/|$)|\.(?:test|spec)\./i.test(path),
      }, target, signal)
      for (const file of manifest.files) await authorizePath(resolveRuntimePath(root, file.path))
      const treeText = manifest.semantics === 'working-copy' ? await gitText(git, { kind: 'tracked' }, signal) : await gitText(git, { kind: 'tree', oid: manifest.scope.revision.head }, signal)
      const contextPaths = manifest.semantics === 'working-copy' ? treeText.split('\0').filter(Boolean) : treeText.split('\0').filter(Boolean).map(line => line.slice(line.indexOf('\t') + 1))
      const readContext = async (path: string, readSignal: AbortSignal): Promise<string> => {
        validateReviewPath(path)
        if (!contextPaths.includes(path) && !manifest.files.some(file => file.path === path)) throw new ReviewGatewayError('read-outside-review-scope')
        await authorizePath(resolveRuntimePath(root, path))
        if (manifest.semantics !== 'working-copy') {
          const row = treeText.split('\0').find(line => line.endsWith('\t' + path))
          const match = row && /^100[0-9]{3} blob ([a-f0-9]+)\t/.exec(row)
          if (!match) throw new ReviewGatewayError('review-context-unavailable')
          return gitText(git, { kind: 'blob', oid: match[1] }, readSignal)
        }
        const read = await readWorkspaceFile(path, 512 * 1024, readSignal)
        if (read.kind !== 'file') throw new ReviewGatewayError('review-context-unavailable')
        return new TextDecoder().decode(read.bytes)
      }
      const guidance = await guidanceFor(manifest.files.map(file => file.path))
      return { manifest, trustedGuidance: guidance.text, evidenceSources: guidance.sources, async read(input, selectedPlan, readSignal) {
        if (readSignal.aborted) throw new ReviewGatewayError('review-cancelled')
        if (input.operation === 'diff') return manifest
        if (!selectedPlan.allowWholeFileReads) throw new ReviewGatewayError('whole-file-read-not-authorized')
        if (input.operation === 'search') {
          if (typeof input.query !== 'string' || input.query.length > 500) throw new ReviewGatewayError('invalid-review-search')
          const matches: Array<{ path: string; line: number; text: string }> = []
          let scanned = 0
          for (const path of contextPaths) {
            if (++scanned > 2000 || matches.length >= 200) break
            let content: string
            try { content = await readContext(path, readSignal) } catch (error) { if (error instanceof ReviewGatewayError && error.code === 'review-context-unavailable') continue; throw error }
            content.split('\n').forEach((line, index) => { if (line.includes(input.query as string) && matches.length < 200) matches.push({ path, line: index + 1, text: line.slice(0, 2000) }) })
          }
          return { matches, truncated: scanned > 2000 || matches.length >= 200 }
        }
        if (input.operation !== 'context' || typeof input.path !== 'string') throw new ReviewGatewayError('read-outside-review-scope')
        return readContext(input.path, readSignal)
      } }
    },
    async verify(snapshot, signal, store, actionEpoch, verificationGrantId) {
      if (!['workspace', 'paths'].includes(snapshot.run.scope.kind) || snapshot.run.scope.workspaceKey !== root) throw new ReviewGatewayError('verification-workspace-mismatch')
      if (actionEpoch && !verificationGrantId) throw new ReviewGatewayError('verification-phase-grant-required')
      const grantId = verificationGrantId ?? await store.grantAction(snapshot.run.id, { kind: 'verification', workspaceKey: root,
        headRevision: snapshot.run.scope.revision.head, diagnosticIds: snapshot.retainedIds, expiresAt: Date.now() + 600_000 })
      await store.assertActionAuthorized(snapshot.run.id, grantId, 'verification', snapshot.retainedIds)
      const instructionGaps: string[] = []
      const readText = async (path: string) => {
        const read = await readWorkspaceFile(path, 128 * 1024, signal)
        if (read.kind === 'file') return new TextDecoder().decode(read.bytes)
        if (read.kind !== 'missing') instructionGaps.push(`verification-instruction-${read.kind}:${path}`)
        return undefined
      }
      const currentScope = await resolveLocalReviewScope({ git: await scopeGit(), workspaceKey: root, projectKey: root, readWorkspaceFile },
        snapshot.run.scope.kind === 'paths' ? { kind: 'paths', paths: snapshot.run.scope.pathFilter } : { kind: 'workspace' }, signal)
      const files = [...new Set(currentScope.files.map(file => file.path).concat(snapshot.diagnostics.map(d => d.anchor.path)))]
      if (!currentScope.complete) instructionGaps.push('verification-scope-incomplete')
      const guidance = await guidanceFor(files)
      const packageText = await readText('package.json')
      let packageManifest: unknown
      if (packageText) {
        try { packageManifest = JSON.parse(packageText) }
        catch { instructionGaps.push('invalid-package-manifest') }
      }
      const runtimeChanged = files.some(path => !/(?:^|\/)(?:docs?|__tests__|tests?|fixtures)\/|\.(?:md|txt)$|\.(?:test|spec)\./i.test(path))
      const plan = planVerification({ workspace: root, files, guidance: guidance.text, runtimeChanged,
        uiChanged: files.some(path => /\.(?:tsx|jsx|vue|svelte|html|css|scss)$|(?:^|\/)(?:ui|webview|components)\//i.test(path)),
        packageManifest, pyproject: await readText('pyproject.toml'), cargoManifest: await readText('Cargo.toml'), goManifest: await readText('go.mod'),
        existingDevUrl: guidance.text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/[^\s`"'<>)]*/)?.[0],
      })
      let checkedThroughSequence = snapshot.events.at(-1)?.sequence ?? 0
      let codeRevision = snapshot.run.scope.revision.workingCopyDigest ?? snapshot.run.scope.revision.head
      const captureVersion = async () => {
        const current = await store.getSnapshot(snapshot.run.id)
        checkedThroughSequence = current.events.at(-1)?.sequence ?? 0
        const hashes = await Promise.all(files.map(async path => {
          const read = await readWorkspaceFile(path, 512 * 1024, signal)
          return [path, read.kind === 'file' ? await reviewDigest(read.bytes) : read.kind]
        }))
        codeRevision = `workspace:${await reviewDigest(JSON.stringify({ head: current.run.scope.revision.head, hashes, checkedThroughSequence }))}`
      }
      let executionSignal = signal
      const browser = context.platformCapabilities?.browser
      const browserTools = dropDeniedTools(context.options.tools, { denyRuleBook: context.readAppState().permissionRules.denyRuleBook ?? {} })
      const canProbe = browser && ['BrowserNavigate', 'BrowserReadPage'].every(name => browserTools.some(tool => tool.name === name && tool.offeredNow()))
      const result = await runVerification(plan, {
        signal,
        probeUi: canProbe ? async input => {
          const common = { evaluation_previous_goal: 'No prior browser verification in this run.', memory: 'Read-only local review verification.', next_goal: 'Inspect the documented local application without submitting forms.' }
          for (const [name, args] of [['BrowserNavigate', { ...common, url: input.url, new_tab: true }], ['BrowserReadPage', { ...common, include_observation: false }]] as const) {
            if (input.signal.aborted) throw new ReviewGatewayError('verification-cancelled')
            if (!await authorizeAction(name, args, true)) throw new ReviewGatewayError('verification-not-authorized')
            const observation = await browser!.callTool({ name, args, executionContext: { sessionId: context.options.sessionId } })
            if (name === 'BrowserReadPage') return { passed: true, output: sanitize(JSON.stringify(observation)), mainPaths: [], boundaries: [], uncovered: ['interactive-ui-paths-not-exercised'] }
          }
          throw new ReviewGatewayError('verification-failed')
        } : undefined,
        authorize: async request => {
          executionSignal = request.signal
          if (request.signal.aborted || signal.aborted || request.workspace !== root) return false
          const input = { url: request.url, file: request.command?.file, args: request.command?.args, cwd: root, script: request.command?.script,
            instruction: request.command?.instruction, restrictions: ['no dependency installation', 'no service restart', 'no external writes'] }
          if (!await authorizeAction('ReviewVerification', input, true)) return false
          if (request.signal.aborted || signal.aborted) return false
          await store.assertActionAuthorized(snapshot.run.id, grantId, 'verification', snapshot.retainedIds)
          await captureVersion()
          return true
        },
        spawn: async (spec, handlers) => {
          if (signal.aborted) throw new ReviewGatewayError('verification-cancelled')
          await store.assertActionAuthorized(snapshot.run.id, grantId, 'verification', snapshot.retainedIds)
          if (executionSignal.aborted || signal.aborted) throw new ReviewGatewayError('verification-cancelled')
          return runtime.spawnArgv(spec, handlers)
        },
        record: async receipt => {
          await store.recordExecution(snapshot.run.id, { ref: crypto.randomUUID(), kind: 'verification', diagnosticIds: [], paths: [],
            succeeded: receipt.state === 'passed', grantId, actionEpoch, checkedThroughSequence, codeRevision,
            command: JSON.stringify(receipt.command ? [receipt.command.file, ...receipt.command.args] : ['browser', receipt.url]),
            missingCases: [...plan.uncovered, ...instructionGaps, ...receipt.coverage.uncovered, 'test-to-diagnostic-coverage-not-established', ...(plan.uiChanged ? ['interactive-ui-not-verified'] : [])],
            evidence: [{ quote: sanitize(receipt.output || receipt.state), relevance: JSON.stringify({ state: receipt.state, exitCode: receipt.exitCode, reason: receipt.reason, outputTruncated: receipt.outputTruncated }) }] })
        },
      })
      if (!result.receipts.length) {
        await store.recordExecution(snapshot.run.id, { ref: crypto.randomUUID(), kind: 'verification', diagnosticIds: [], paths: [], succeeded: false,
          grantId, actionEpoch, checkedThroughSequence, codeRevision, missingCases: [...result.uncovered, ...instructionGaps, ...(!runtimeChanged ? ['runtime-verification-not-applicable'] : [])],
          evidence: [{ quote: 'No runtime verification command was executed.', relevance: 'Existing project instructions did not provide an executable verification plan.' }] })
        if (runtimeChanged) throw new ReviewGatewayError('verification-instructions-unavailable')
        return
      }
      if (result.receipts.some(receipt => receipt.state === 'cancelled')) throw new ReviewGatewayError('verification-cancelled')
      if (result.receipts.some(receipt => receipt.state === 'timed-out')) throw new ReviewGatewayError('verification-timed-out')
      if (result.receipts.some(receipt => receipt.state !== 'passed')) throw new ReviewGatewayError('verification-failed')
    },
    async publish(snapshot, grantId, signal, store, discussions = false) {
      const scope = snapshot.run.scope
      const remote = remoteSnapshots.get(remoteKey(scope))
      if (!remote || !runtime.httpRequest) throw new ReviewGatewayError('publication-target-unavailable')
      if (remote.target.platform !== scope.repository.platform || remote.target.origin !== (scope.repository.platform === 'github' ? 'https://github.com' : 'https://gitlab.com') || remote.target.projectKey !== scope.repository.projectKey || remote.target.number !== scope.request?.number || remote.base !== scope.revision.base || remote.head !== scope.revision.head || remote.head !== scope.request.headRevision) throw new ReviewGatewayError('publication-target-mismatch')
      const secret = await runtime.platformSecret?.(remote.target.platform === 'github' ? 'https://api.github.com' : remote.target.origin)
      if (!secret) throw new ReviewGatewayError('publication-authentication-required')
      if (!await authorizeAction('ReviewPublication', { target: remote.target, head: remote.head }, true)) throw new ReviewGatewayError('publication-not-authorized')
      const retained = snapshot.diagnostics.filter(d => snapshot.retainedIds.includes(d.id))
      const bodyFor = (ids: string[]) => JSON.stringify({ complete: snapshot.coverage.complete, limitations: snapshot.coverage.limitations,
        findings: retained.filter(d => ids.includes(d.id)), actions: snapshot.actions.filter(a => a.diagnosticIds.some(id => ids.includes(id))), localEditsAreNotPushed: true })
      const writes = (remote.target.platform === 'github' || discussions) && retained.length ? retained.map(d => {
        const anchor = remote.manifest.anchors.find(a => a.path === d.anchor.path && a.side === d.anchor.side && a.span && d.anchor.span && a.span.start <= d.anchor.span.start && a.span.end >= d.anchor.span.end)
        return { kind: anchor && d.anchor.span ? remote.target.platform === 'gitlab' ? 'discussion' as const : 'inline' as const : 'summary' as const,
          body: bodyFor([d.id]), diagnosticIds: [d.id], reportRevision: snapshot.run.reportRevision,
          rootCauseFingerprint: JSON.stringify([d.anchor.path, d.anchor.revision, d.claim.explanation]),
          ...(anchor && d.anchor.span ? { location: { anchorKey: anchor.anchorKey, path: d.anchor.path, line: d.anchor.span.start, endLine: d.anchor.span.end } } : {}) }
      }) : [{ kind: 'summary' as const, body: bodyFor(snapshot.retainedIds), diagnosticIds: snapshot.retainedIds, reportRevision: snapshot.run.reportRevision }]
      for (const write of writes) {
        const reservation = await store.beginPublication(snapshot.run.id, { grantId, diagnosticIds: write.diagnosticIds, remoteHead: remote.head,
          kind: write.kind, normalizedContent: write.body })
        if (!reservation.shouldSend && reservation.operation.state !== 'uncertain' && reservation.operation.state !== 'pending') continue
        const publisher = createReviewPlatformPublisher({ httpRequest: runtime.httpRequest, target: remote.target, workspaceKey: root, secret,
          authorize: async () => {
            if (signal.aborted || Date.now() >= expires) return false
            await store.assertActionAuthorized(snapshot.run.id, grantId, 'publication', write.diagnosticIds)
            return true
          },
          receipts: durableReceipts,
        })
        const expires = Date.now() + 60_000
        try {
          const receipt = reservation.shouldSend ? await publisher.publish(remote, write, signal) : await publisher.recover(remote, write, signal)
          await store.settlePublication(snapshot.run.id, reservation.operation.id, { state: receipt.state === 'succeeded' ? 'succeeded' : receipt.state === 'uncertain' || receipt.state === 'pending' ? 'uncertain' : 'failed', externalRef: receipt.externalId, reason: receipt.reason })
        } catch (error) {
          await store.settlePublication(snapshot.run.id, reservation.operation.id, { state: 'uncertain', reason: error instanceof Error ? error.message : 'publication-failed' })
          throw error
        }
      }
    },
    async repairTools(snapshot, grant, signal, store, actionEpoch) {
      if (context.readAppState().permissionRules.mode === 'plan' || !['workspace', 'paths'].includes(snapshot.run.scope.kind)) throw new ReviewGatewayError('repair-workspace-mismatch')
      const git = await scopeGit()
      const notices = service.presentation(snapshot.run.id)?.notices ?? (await readJson(resolveRuntimePath(sessionDir, `presentation/${snapshot.run.id}.json`)) as ReturnType<LocalReviewService['presentation']>)?.notices ?? []
      const currentScope = await resolveLocalReviewScope({ git, workspaceKey: root, projectKey: root, readWorkspaceFile,
        skipPath: path => notices.some(notice => notice.code === 'tests-fixtures-skipped') && /(?:^|\/)(?:__tests__|tests?|fixtures)(?:\/|$)|\.(?:test|spec)\./i.test(path),
      }, snapshot.run.scope.pathFilter.length ? { kind: 'paths', paths: snapshot.run.scope.pathFilter } : { kind: 'workspace' }, signal)
      if (currentScope.scope.revision.head !== snapshot.run.scope.revision.head || currentScope.scope.revision.workingCopyDigest !== snapshot.run.scope.revision.workingCopyDigest) throw new ReviewGatewayError('snapshot-changed')
      const allowed = new Set((grant.paths ?? []).map(path => normalized(resolveRuntimePath(root, path))))
      return [{ ...SuperEditTool, async call(input, callContext, permission, row, progress) {
        if (signal.aborted) throw new ReviewGatewayError('review-cancelled')
        const refs: string[] = []
        const guard = async (path: string) => {
          const actual = normalized(await fs.realpath!(path, { resolveLinks: true }))
          if (!allowed.has(actual) || !equal(actual, normalized(path))) throw new ReviewGatewayError('edit-outside-review-grant')
          if (signal.aborted) throw new ReviewGatewayError('review-cancelled')
          if (grant.expiresAt <= Date.now()) throw new ReviewGatewayError('repair-grant-expired')
          await store.assertActionAuthorized(snapshot.run.id, grant.id, 'repair', grant.diagnosticIds, [actual.slice(root.length + 1)])
          const current = await store.getSnapshot(snapshot.run.id)
          if (current.run.progress.status !== 'active') throw new ReviewGatewayError('repair-no-longer-active')
        }
        const restricted = new Proxy(fs, { get(targetFs, key) {
          if (['readFile', 'readFileBytes', 'stat'].includes(String(key))) return async (path: string, ...args: unknown[]) => { await guard(path); return (targetFs[key as keyof RuntimeFs] as (...a: unknown[]) => unknown).apply(targetFs, [path, ...args]) }
          if (key === 'writeFile') return async (path: string, data: string | Uint8Array, options?: { encoding?: string }) => {
            await guard(path)
            const before = await targetFs.readFileBytes(path)
            const next = typeof data === 'string' ? new TextEncoder().encode(data) : data
            await targetFs.writeFile(path, data, options)
            if (await reviewDigest(before) !== await reviewDigest(next)) {
              const relative = normalized(path).slice(root.length + 1)
              const ids = snapshot.diagnostics.filter(d => grant.diagnosticIds.includes(d.id) && d.anchor.path === relative).map(d => d.id)
              const ref = crypto.randomUUID()
              await store.recordExecution(snapshot.run.id, { ref, kind: 'edit', diagnosticIds: ids, paths: [relative], succeeded: true, grantId: grant.id, actionEpoch })
              refs.push(ref)
            }
          }
          if (['mkdir', 'rm', 'unlink', 'rename', 'readdir'].includes(String(key))) return async () => { throw new ReviewGatewayError('review-mutation-not-authorized') }
          if (key === 'cwd') return () => root
          return () => { throw new ReviewGatewayError('review-fs-operation-not-authorized') }
        } }) as RuntimeFs
        const result = await SuperEditTool.call(input, { ...callContext, requestToolUseConfirm: context.requestToolUseConfirm,
          options: { ...callContext.options, fsOperations: restricted } }, permission, row, progress)
        return { ...result, data: JSON.stringify({ result: result.data, executionRefs: refs }) }
      } }]
    },
  })
  services.set(identity, service)
  const previews = new Map<string, string>()
  const restoredPresentations = new Map<string, NonNullable<ReturnType<LocalReviewService['presentation']>>>()
  const projection = (snapshot: ReportSnapshot): ReviewReportView => {
    const presentation = service.presentation(snapshot.run.id) ?? restoredPresentations.get(snapshot.run.id)
    const active = ['active', 'queued'].includes(snapshot.run.progress.status)
    return {
      run: snapshot.run, diagnostics: snapshot.diagnostics.filter(d => snapshot.retainedIds.includes(d.id)), evidence: snapshot.evidence,
      assessments: snapshot.assessments, actions: snapshot.actions, coverage: snapshot.coverage, verifications: snapshot.verifications,
      notices: presentation?.notices.map(notice => ({ ...notice })), emptyScope: presentation?.emptyScope,
      targetLabel: presentation?.target ?? snapshot.run.scope.repository.projectKey,
      publicationPreview: previews.get(snapshot.run.id), exportJson: presentReviewJson(snapshot),
      finishedTasks: snapshot.events.filter(e => e.type === 'worker-finished').length,
      permissions: { cancel: active, repair: !active && snapshot.structured && ['workspace', 'paths'].includes(snapshot.run.scope.kind), publish: !active && snapshot.structured && snapshot.run.scope.kind === 'change-request', publishConfirmation: true, rerun: !active, verify: !active && snapshot.structured, locate: !active && snapshot.structured },
    }
  }
  const unregister = registerReviewSession(context.options.sessionId, {
    async getSnapshot() {
      const snapshot = await service.snapshots()
      for (const report of snapshot.reports) if (!service.presentation(report.run.id) && !restoredPresentations.has(report.run.id)) {
        const stored = await readJson(resolveRuntimePath(sessionDir, `presentation/${report.run.id}.json`)) as ReturnType<LocalReviewService['presentation']>
        if (stored) restoredPresentations.set(report.run.id, stored)
      }
      return { sessionId: context.options.sessionId, sequence: snapshot.sequence, reports: snapshot.reports.map(projection) }
    },
    subscribe: service.subscribe, cancel: id => service.cancel(id), repair: (id, ids) => service.requestRepair(id, ids),
    async publish(id, options) {
      if (options.preview) {
        const snapshot = await service.store.getSnapshot(id)
        previews.set(id, JSON.stringify({ complete: snapshot.coverage.complete, findings: snapshot.diagnostics.filter(d => snapshot.retainedIds.includes(d.id)), actions: snapshot.actions, coverage: snapshot.coverage }, null, 2))
        service.changed()
        return
      }
      if (!options.confirmed) throw new ReviewGatewayError('publication-not-authorized')
      await service.requestPublication(id, options.discussions === true)
    }, rerun: (id, presentation) => service.rerun(id, presentation),
    verify: id => service.requestVerification(id),
    async locate(id, diagnosticId) {
      const snapshot = await service.store.getSnapshot(id)
      const diagnostic = snapshot.diagnostics.find(item => item.id === diagnosticId && snapshot.retainedIds.includes(item.id))
      if (!diagnostic || diagnostic.anchor.side !== 'working-copy') throw new ReviewGatewayError('snapshot-changed')
      const git = await scopeGit()
      const current = await resolveLocalReviewScope({ git, workspaceKey: root, projectKey: root, readWorkspaceFile,
        skipPath: path => (service.presentation(id)?.notices ?? restoredPresentations.get(id)?.notices ?? []).some(notice => notice.code === 'tests-fixtures-skipped') && /(?:^|\/)(?:__tests__|tests?|fixtures)(?:\/|$)|\.(?:test|spec)\./i.test(path),
      }, snapshot.run.scope.pathFilter.length ? { kind: 'paths', paths: snapshot.run.scope.pathFilter } : { kind: 'workspace' })
      if (current.scope.revision.head !== snapshot.run.scope.revision.head || current.scope.revision.workingCopyDigest !== snapshot.run.scope.revision.workingCopyDigest) throw new ReviewGatewayError('snapshot-changed')
      const path = resolveRuntimePath(root, diagnostic.anchor.path)
      await authorizePath(path)
      return { path, line: diagnostic.anchor.span?.start }
    },
  })
  context.options.runtimeScopeSignal?.addEventListener('abort', () => { unregister(); void service.snapshots().then(s => Promise.all(s.reports.map(r => service.cancel(r.run.id)))) }, { once: true })
  try { const entries = await fs.readdir(sessionDir); await service.restore(entries.filter(e => e.isFile() && /^[A-Za-z0-9_-]+\.json$/.test(e.name)).map(e => e.name.slice(0, -5))) }
  catch (error) { if (!isFsNotFoundError(error)) throw error }
  return service
}

export async function invokeReviewModelSkill(raw: string, context: ToolCallContext, permission: PermissionDecider): Promise<string> {
  const parsed = parseReviewArguments(raw)
  if (!parsed.ok) throw new ReviewGatewayError(parsed.error.code)
  if (parsed.arguments.fix || parsed.arguments.comment) throw new ReviewGatewayError('action-not-authorized')
  const service = await getOrCreateReviewService(context, permission)
  const { runId } = await service.startModel(raw, context.cancelSource.signal)
  return JSON.stringify(await service.wait(runId))
}
