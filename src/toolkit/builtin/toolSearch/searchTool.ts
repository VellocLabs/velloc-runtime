/**
 * The deferred-tool loader. Deferred tools are advertised by name only;
 * this tool resolves names (`select:`) or keywords to tools and activates
 * their owning units so the tools' schemas join the next request.
 */
import type { ToolContract, ToolContractList } from '../../toolContract'
import { declareTool } from '../../toolContract'
import {
  activateSkills,
  deferralKeyFromContext,
  isAnySkillDeferred,
  type DeferralKey,
} from '../../run/deferredTools'
import { isToolSealed, loadableTools, owningUnit, renderCatalog } from './catalog'
import { parseSelectList, rankByKeywords } from './ranking'

export const DEFERRED_LOADER_TOOL_NAME = 'ToolSearch'

export type DeferredLoaderInput = { query: string; max_results?: number }
export type DeferredLoaderOutput = string

const DEFAULT_LIMIT = 5

const SUMMARY =
  'Loads the parameter schema for a deferred tool so it can be called. Until loaded, only a deferred tool\'s name is known — calling it directly fails. Provide "select:Name" to load specific tools, or keywords to search.'

function keyOf(runtimeConfig: unknown): DeferralKey {
  return deferralKeyFromContext({ options: { runtimeConfig } })
}

function resolveSelection(
  names: readonly string[],
  loadable: readonly ToolContract[],
  allTools: ToolContractList,
  key: DeferralKey,
): string[] {
  const picked: string[] = []
  for (const raw of names) {
    const wanted = raw.toLowerCase()
    const hit =
      loadable.find(t => t.name.toLowerCase() === wanted) ??
      allTools.find(t => t.name.toLowerCase() === wanted && !isToolSealed(t, key))
    if (hit && !picked.includes(hit.name)) picked.push(hit.name)
  }
  return picked
}

export const deferredLoaderTool: ToolContract<DeferredLoaderInput, DeferredLoaderOutput> =
  declareTool({
    name: DEFERRED_LOADER_TOOL_NAME,
    discoveryHint: 'load the parameter schema for a deferred tool so it can be called',
    argsSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Query to find deferred tools. Use "select:<tool_name>" (comma-separated for multiple) for direct selection, or keywords to search. Prefix a term with "+" to require it.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5).',
        },
      },
      required: ['query'],
    },
    offeredNow: () => isAnySkillDeferred(),
    parallelSafe: () => true,
    readsOnly: () => true,
    description: async (_input: DeferredLoaderInput, options) =>
      `${SUMMARY}\n\n${renderCatalog(options.tools, keyOf(options.runtimeConfig))}`,
    async checkInput(input: DeferredLoaderInput) {
      if (typeof input.query !== 'string' || input.query.trim() === '') {
        return {
          result: false,
          message: 'query is required and must be a non-empty string.',
          errorCode: 1,
        }
      }
      return { result: true }
    },
    async call(input: DeferredLoaderInput, context) {
      const key = deferralKeyFromContext(context)
      const allTools = context.options.tools
      const loadable = loadableTools(allTools, key)
      const selection = parseSelectList(input.query)
      const matched = selection
        ? resolveSelection(selection, loadable, allTools, key)
        : rankByKeywords(input.query, loadable, input.max_results ?? DEFAULT_LIMIT)

      if (matched.length === 0) {
        return {
          data: `No matching deferred tools found for "${input.query}". ${loadable.length} deferred tool(s) available — try a different keyword or "select:<name>".`,
        }
      }

      const units: string[] = []
      for (const name of matched) {
        const tool = allTools.find(t => t.name === name)
        const unit = tool ? owningUnit(tool, key) : undefined
        if (unit && !units.includes(unit)) units.push(unit)
      }
      activateSkills(context.writeAppState, units, key)

      return {
        data: `Loaded ${matched.length} tool schema(s): ${matched.join(', ')}. They are now callable — invoke them directly.`,
      }
    },
  })
