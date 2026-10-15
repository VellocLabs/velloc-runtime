/**
 * Decide an install's outcome when the bridge request errored: a large install can
 * outlast the transport timeout, so it SUCCEEDED iff a re-list shows the skill.
 */
export type InstallReconcileOutcome = { ok: boolean; toast: string };

export function reconcileInstallError(
  skillName: string,
  errorMessage: string,
  installedAfterRefresh: ReadonlySet<string> | null,
  skillId: string,
): InstallReconcileOutcome {
  if (installedAfterRefresh?.has(skillId)) {
    // The worker completed despite the timed-out request.
    return { ok: true, toast: `Installed ${skillName}` };
  }
  return { ok: false, toast: `Install failed: ${errorMessage}` };
}
