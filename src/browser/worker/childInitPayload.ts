/**
 * The init payload of a session another session starts (a teammate, F-20; a
 * child session, F-36), derived from the reusable UI init template. Security:
 * the project binding comes from the PARENT session, never from the template,
 * which is the last init of ANY session; the provider is stamped whenever it
 * was resolved, and without a model the template's model is cleared, not
 * inherited.
 */
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'

export type ParentSessionBinding = {
  projectRoot?: string
  templateType?: string
  cwd?: string
}

export type ChildInitPayloadArgs = {
  sessionId: string
  /** The parent's own binding; null when the parent is not a live session. */
  parent: ParentSessionBinding | null
  /** Explicit overrides; each wins over the parent's value. */
  projectRoot?: string
  templateType?: string
  providerId?: string
  model?: string
  thinkingTier?: string
  /** The child's working directory; absent falls back to the parent's own
   *  working directory when that is not its project root. */
  cwd?: string
  untrustedReadRoot?: string
  routineOriginId?: string
}

/** The template with the child's identity, binding, model and directory
 *  applied, and every trace / routine / team field of the template cleared. */
export function deriveChildInitPayload(
  template: AgentRuntimeWorkerInitPayload,
  args: ChildInitPayloadArgs,
): AgentRuntimeWorkerInitPayload {
  const { parent } = args
  const boundProjectRoot = args.projectRoot ?? parent?.projectRoot
  const boundTemplateType = args.templateType ?? parent?.templateType
  return {
    ...template,
    sessionId: args.sessionId,
    // With a live parent these OVERRIDE the template's (possibly foreign)
    // values, `undefined` included, so an unbound parent's child does not
    // inherit another session's folder or type.
    ...(parent
      ? { projectRoot: boundProjectRoot, templateType: boundTemplateType }
      : {
          ...(boundProjectRoot ? { projectRoot: boundProjectRoot } : {}),
          ...(boundTemplateType ? { templateType: boundTemplateType } : {}),
        }),
    ...(args.providerId
      ? {
          userSpecifiedProviderId: args.providerId,
          userSpecifiedModel: args.model,
          ...(args.thinkingTier ? { userSpecifiedThinkingTier: args.thinkingTier } : {}),
        }
      : args.model
        ? { userSpecifiedModel: args.model }
        : {}),
    ...(args.cwd
      ? { cwdOverride: args.cwd }
      : parent?.cwd
        ? { cwdOverride: parent.cwd }
        : {}),
    ...(args.untrustedReadRoot ? { untrustedReadRoot: args.untrustedReadRoot } : {}),
    traceId: undefined,
    isHeadless: undefined,
    routineId: undefined,
    routineOriginId: args.routineOriginId,
    isTeammate: undefined,
    teamName: undefined,
    teammateName: undefined,
    spawnerSessionId: undefined,
  }
}
