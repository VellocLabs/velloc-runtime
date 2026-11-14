import type { ReviewModelRequest } from './runner'
import type { ReviewServiceOptions } from './service'

type ResolveScope = ReviewServiceOptions['resolveScope']
type RunModel = ReviewServiceOptions['runModel']

/** Wraps a scope resolver so a diff read naming paths returns the manifest's patches of those included files; every other read passes through. */
export const servingPatches = (resolveScope: ResolveScope): ResolveScope => (async (...args: Parameters<ResolveScope>) => {
  const access = await resolveScope(...args)
  const read: typeof access.read = async (input, ...rest) => {
    if (input.operation !== 'diff' || !Array.isArray(input.paths)) return access.read(input, ...rest)
    const paths = input.paths as unknown[]
    return { files: access.manifest.files.filter(file => file.status === 'included' && paths.includes(file.path)).map(file => ({ path: file.path, status: file.status, patch: file.patch })) }
  }
  return { ...access, read }
}) as ResolveScope

/** Wraps a fake model so its coordinator turn opens as a real one does: one diff read of every included patch. */
export const readingPatchesFirst = (runModel: RunModel): RunModel => (async (request: ReviewModelRequest) => {
  const scope = request.blocks.find(block => block.source === 'scope-manifest')
  const tool = request.tools.find(candidate => candidate.name === 'ReviewRead')
  if (request.role === 'coordinator' && scope && tool) {
    const paths = (JSON.parse(scope.text) as { files: Array<{ path: string; status: string }> }).files.filter(file => file.status === 'included').map(file => file.path)
    const input = { operation: 'diff', paths }
    if (paths.length) await tool.call(input, {} as never, (() => ({ behavior: 'allow' })) as never, { type: 'assistant', uuid: crypto.randomUUID(), message: { content: [{ type: 'tool_use', id: crypto.randomUUID(), name: 'ReviewRead', input }] } } as never)
  }
  return runModel(request)
}) as RunModel
