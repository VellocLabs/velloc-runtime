/**
 * Worker-side body of a bundled skill for the Skills tab: a static skill's
 * registered body; a dynamic one's last injected body this session (`invoked`)
 * or `dynamic`; an unknown name `not_found`. Pure lookup.
 */

import {
  getBundledSkillCommand,
  getBundledSkillDynamicContent,
  invocationAllows,
} from './builtinSkills'
import { skillsUsedBy } from './invokedSkillsStore'

/** Wire-serializable result for `worker.skillBody` (see workerProtocol). */
export type BundledSkillBodyResult =
  | { kind: 'static'; body: string }
  | { kind: 'invoked'; body: string; invokedAt: number }
  | { kind: 'dynamic' }
  | { kind: 'not_found' }

/**
 * Resolve the displayable body for the bundled skill `name` in `sessionId`.
 * The invoked-body lookup is main-session scoped (`agentId = null`) — the
 * panel browses the user's session, and subagent invocations are not part
 * of it (no nexus invocation site sets `agentId` today anyway; see
 * invokedSkillsStore's divergence notes).
 */
export function resolveBundledSkillBody(
  name: string,
  sessionId: string,
  /** The asking session's template type. A bundled skill whose invocation
   *  gates exclude this type was never loaded into this session, so its body
   *  is `not_found` here — the registry is module-global and would otherwise
   *  answer for every session. */
  templateType?: string,
): BundledSkillBodyResult {
  const registered = getBundledSkillCommand(name)
  // Present in this session if EITHER surface admits it — the panel browses
  // what the session has, and a slash-only or model-only skill is still part
  // of it. Mirrors `resolveInvocationForSession`'s `present`.
  if (
    registered
    && !invocationAllows(registered.modelInvocation, templateType)
    && !invocationAllows(registered.userInvocation, templateType)
  ) {
    return { kind: 'not_found' }
  }
  if (getBundledSkillDynamicContent(name)) {
    // Composite store key is `${agentId ?? ''}:${skillName}`; walking the
    // main-session view keeps this robust to key-format changes.
    for (const info of skillsUsedBy(sessionId, null).values()) {
      if (info.skillName === name) {
        return { kind: 'invoked', body: info.content, invokedAt: info.invokedAt }
      }
    }
    return { kind: 'dynamic' }
  }
  if (registered) {
    return { kind: 'static', body: registered.content }
  }
  return { kind: 'not_found' }
}
