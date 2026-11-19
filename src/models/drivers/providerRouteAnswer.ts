/**
 * Security: the check every answer of a router provider passes before it is
 * used (F-27). The answer comes from a module and is untrusted. A target is
 * accepted only when it is a provider that is set up, is not itself a router,
 * is inside the router's boundary and can be served here, and the model is
 * one that target lists. `provider` is an opaque instance id: it is compared
 * and looked up, never taken apart.
 */
import { THINKING_TIER_ORDER } from '../../config/nexusModelConfig/providers/shared/listing'
import { insideRoutesTo, type RoutesTo } from './providerRouter'

export const ROUTE_MODEL_MAX_LENGTH = 256
export const ROUTE_STOP_MESSAGE_MAX_LENGTH = 2_000

export type RouteTarget = { provider: string; model: string; effort?: string }

export type RouteAnswerFacts = {
  routesTo: RoutesTo
  isSetUp(provider: string): boolean
  isRouter(provider: string): boolean
  /** The provider definition an instance belongs to. */
  definitionOf(provider: string): string
  /** The runtime can send a request of `model` to `provider`. */
  serves(provider: string, model: string): boolean
  /** `provider` lists `model`. */
  knownModel(provider: string, model: string): boolean
}

export type CheckedRouteAnswer =
  | { kind: 'target'; target: RouteTarget }
  | { kind: 'stop'; message?: string }
  /** The router left the request to the platform. */
  | { kind: 'none' }
  | { kind: 'refused'; reason: string }

const refused = (reason: string): CheckedRouteAnswer => ({ kind: 'refused', reason })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function checkRouteAnswer(answer: unknown, facts: RouteAnswerFacts): CheckedRouteAnswer {
  if (answer === undefined || answer === null) return { kind: 'none' }
  if (!isRecord(answer)) return refused('the answer is not an object')
  if ('stop' in answer) {
    if (answer.stop !== true) return refused('`stop` must be true')
    if ('provider' in answer || 'model' in answer) return refused('the answer names both a target and `stop`')
    const message = typeof answer.message === 'string' ? answer.message.trim() : ''
    return message
      ? { kind: 'stop', message: message.slice(0, ROUTE_STOP_MESSAGE_MAX_LENGTH) }
      : { kind: 'stop' }
  }
  const { provider, model, effort } = answer
  if (typeof provider !== 'string' || provider === '') return refused('`provider` must be a non-empty string')
  if (typeof model !== 'string' || model === '') return refused('`model` must be a non-empty string')
  if (model.length > ROUTE_MODEL_MAX_LENGTH) return refused(`\`model\` is longer than ${ROUTE_MODEL_MAX_LENGTH} characters`)
  if (facts.isRouter(provider)) return refused(`the provider ${provider} is a router`)
  if (!insideRoutesTo(facts.routesTo, { definition: facts.definitionOf(provider) })) {
    return refused(`the provider ${provider} is outside what this router may send through`)
  }
  if (!facts.isSetUp(provider)) return refused(`the provider ${provider} is not set up`)
  if (!facts.knownModel(provider, model)) return refused(`the provider ${provider} does not list the model ${model}`)
  if (!facts.serves(provider, model)) return refused(`requests to the provider ${provider} cannot be sent from here`)
  const tier = typeof effort === 'string' && (THINKING_TIER_ORDER as readonly string[]).includes(effort) ? effort : undefined
  return { kind: 'target', target: { provider, model, ...(tier ? { effort: tier } : {}) } }
}
