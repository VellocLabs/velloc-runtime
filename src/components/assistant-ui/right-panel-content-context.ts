import { createContext, useContext } from "react";
import type { StructuredPatchHunk } from "diff";

/**
 * Thread-level handle for opening a file or diff in the Right Panel, provided by
 * `AssistantUiThread`. Own module so the deep tool cards and the thread host do not
 * import each other.
 */

/** A file to open in the right-panel Files view. The panel fetches the full,
 *  current file from the host fs bridge by `path`. An optional 1-based `line`
 *  (from a `path:42` transcript mention) is revealed once the editor mounts. */
export type RightPanelFileTarget = { path: string; line?: number };

/** What the right-panel Diff view shows:
 *   • `file` — one Edit's diff (the Edit card title opens this), carrying the
 *     already-computed hunks (file-relative when the host supplied the pre-edit
 *     content) so the panel never recomputes;
 *   • `turnHistory` — the whole "Changes this turn" history (the footer bar
 *     opens this). A marker only: the panel renders the LIVE per-session history
 *     + on-demand hunk loader threaded through `RightPanel`, so it stays current
 *     as new turns land instead of freezing a snapshot. */
export type RightPanelDiffTarget =
  | {
      kind: "file";
      filePath: string;
      hunks: StructuredPatchHunk[];
      plusLines: number;
      minusLines: number;
    }
  | { kind: "turnHistory" };

/** What the right-panel Skill view shows. Body resolution order: `path` (the skill's
 *  `SKILL.md`, read live), `detailId` (the `skill:<uuid>` sidecar), `inlineBody`.
 *  At least one of the three is set. */
export type RightPanelSkillTarget = {
  name: string;
  args?: string;
  path?: string;
  detailId: string | null;
  inlineBody: string | null;
  /** The event-log invocation id this target opens — lets the list highlight
   *  the specific invocation (rows can share a name). Omitted when opened from
   *  a conversation card / the file list. */
  eventId?: string;
  /** Event-log status of the invocation this target opens. `'failed'` shows
   *  the `error` instead of resolving a body; omitted → resolve a body as
   *  before (a skill opened from a conversation card / the file list). */
  status?: "loaded" | "failed";
  /** Failure message for a `'failed'` target. */
  error?: string;
};

export type RightPanelContentContextValue = {
  /** Open `target` in the right-panel Files view. Absent on hosts without the
   *  panel (e.g. the embedded test harness). */
  openFile?: (target: RightPanelFileTarget) => void;
  /** Open `target` in the right-panel Diff view. */
  openDiff?: (target: RightPanelDiffTarget) => void;
  /** Open `target` in the right-panel Skill view (Skill card "View skill"). */
  openSkill?: (target: RightPanelSkillTarget) => void;
  /** WorkspaceDiff card title → the Diff view. With a `path`, resolves that
   *  file's WHOLE-SESSION snapshot diff (loadTurnDiffDetail's sentinel turn 0)
   *  and opens it as a `file` target; without one — or when the path resolves
   *  to nothing — opens the `turnHistory` tab. */
  openWorkspaceDiff?: (path?: string) => void;
};

export const RightPanelContentContext =
  createContext<RightPanelContentContextValue>({});

export function useRightPanelContent(): RightPanelContentContextValue {
  return useContext(RightPanelContentContext);
}
