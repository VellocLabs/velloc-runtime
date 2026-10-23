import * as React from "react";

import { Button } from "@/components/ui/button";
import { useUnsavedEditsGate } from "@/glic/unsavedEditsGate";
import { cn } from "@/lib/utils";

import { useT } from "../../i18n";
import {
  useSettingsBridge,
  useSettingsHostActions,
  useSettingsSession,
} from "../../nexusSettingsBridge";
import type { NexusSettingsBridge } from "../../nexusSettingsBridge";
import {
  memoryInstructions,
  memoryUserInstructions,
  memoryWriteUserInstructions,
} from "../clients";
import {
  SettingsGroupLabel,
  SettingsSection,
  SettingsSubpageLayout,
} from "../SettingsSubpageLayout";

/**
 * Instructions — what YOU author to shape the agent (Memory is what the agent
 * writes). "All projects" edits the USER-tier file `~/.velloc/AGENTS.md` (every
 * project, next session) and lists the other User-tier files; "This project"
 * lists the Project and Local tiers read-only. There is no settings-backed
 * instruction field.
 */
export function InstructionsSection() {
  const t = useT();
  const bridge = useSettingsBridge();

  if (!bridge) {
    // Reuse the nav label as the fallback page title (same string) — avoids a
    // dedicated `settings.instructions.title` key across all five catalogs.
    return (
      <SettingsSubpageLayout title={t("settings.nav.instructions")}>
        <p className="text-muted-foreground text-sm">
          {t("settings.bridgeUnavailable")}
        </p>
      </SettingsSubpageLayout>
    );
  }

  return (
    <SettingsSubpageLayout title={t("settings.nav.instructions")}>
      <InstructionsBody bridge={bridge} />
    </SettingsSubpageLayout>
  );
}

type InstructionFile = {
  path: string;
  tier: "User" | "Project" | "Local";
  bytes: number;
};

/**
 * Loads the discovered instruction files once (`memory.instructions`, for the
 * session the client shows) and splits them by scope: User-tier files belong to
 * "All projects", Project and Local tiers to "This project".
 */
function InstructionsBody({ bridge }: { bridge: NexusSettingsBridge }) {
  const sessionId = useSettingsSession();
  const [files, setFiles] = React.useState<InstructionFile[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await memoryInstructions(bridge, sessionId);
        if (!cancelled) setFiles(r.files);
      } catch {
        if (!cancelled) setFiles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, sessionId]);

  return (
    <div data-testid="settings-instructions" className="flex flex-col gap-4">
      <GlobalInstructionsField
        bridge={bridge}
        userFiles={files?.filter((f) => f.tier === "User") ?? []}
      />
      <InstructionFilesList
        files={files?.filter((f) => f.tier !== "User") ?? null}
      />
    </div>
  );
}

/**
 * Editor for `~/.velloc/AGENTS.md`: commits on blur only when the draft differs from
 * the last SAVED value, VERBATIM (a blank commit empties the file). The write is
 * CONFLICT-CHECKED against the loaded baseline; on a conflict the field resyncs to
 * disk and says so instead of overwriting. Takes effect in the NEXT session.
 */
function GlobalInstructionsField({
  bridge,
  userFiles,
}: {
  bridge: NexusSettingsBridge;
  /** User-tier files; the one this field edits is not listed again. */
  userFiles: InstructionFile[];
}) {
  const t = useT();
  // `value` doubles as the load flag (null = still loading) AND the baseline
  // the conflict check is made against, so the two can never disagree.
  // It tracks DISK ONLY — never an in-flight draft, or a failed write would
  // leave it describing content that was never persisted and manufacture a
  // spurious conflict on the next save.
  const [value, setValue] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [path, setPath] = React.useState("");
  const [conflict, setConflict] = React.useState(false);
  // On a conflict, the on-disk text is shown ALONGSIDE the user's kept draft
  // rather than replacing it.
  const [conflictDisk, setConflictDisk] = React.useState<string | null>(null);
  // Set when the file exists but could not be read: the editor must not offer
  // to overwrite content it cannot show.
  const [unreadable, setUnreadable] = React.useState(false);
  // Set when the last write failed outright (a transport error, not a
  // conflict): the draft is kept, but it is NOT on disk, and the field must
  // say so rather than look saved.
  const [saveFailed, setSaveFailed] = React.useState(false);
  // Serializes commits. Two blurs inside one bridge round-trip would otherwise
  // send the second write against a baseline the first had not yet stored.
  const inFlight = React.useRef(false);
  // A blur that arrived while a write was in flight. Serialized, not dropped:
  // it is sent once the first write settles, against the baseline that write
  // stored.
  const queued = React.useRef<string | null>(null);
  // `value` as of the latest settled write. A queued commit runs from the
  // first commit's closure, whose `value` is the PRE-write baseline.
  const baseline = React.useRef<string | null>(null);
  baseline.current = value;
  // A draft that is not on disk (typed, kept on a conflict, or kept after a
  // failed write) lives only in this page — hold the background updater's
  // reload while there is one (glic/unsavedEditsGate.ts).
  useUnsavedEditsGate(value !== null && draft !== value);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await memoryUserInstructions(bridge);
        if (!cancelled) {
          setPath(snap.path);
          setUnreadable(snap.readable === false);
          setValue(snap.content);
          setDraft(snap.content);
        }
      } catch {
        // Leave `value` null → the loading note stays; the bridge is the only
        // persistence path, so there's nothing to fall back to.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const commit = React.useCallback(
    async (next: string) => {
      // No optimistic `setValue`: the textarea binds `draft` (already set by
      // onChange), so the only thing an optimistic baseline would achieve is
      // making `value` describe text that is not on disk.
      if (inFlight.current) {
        queued.current = next;
        return;
      }
      inFlight.current = true;
      let settledClean = false;
      try {
        const r = await memoryWriteUserInstructions(bridge, {
          content: next,
          // The baseline we loaded/last saved. The handler refuses the write
          // when disk has moved on, handing back the on-disk text.
          expected: baseline.current,
        });
        setPath(r.path);
        setValue(r.content);
        baseline.current = r.content;
        setConflict(r.conflict === true);
        setSaveFailed(false);
        // KEEP the user's draft on a conflict. The banner tells them to
        // reapply their change, which is only possible if it is still in the
        // box; `r.content` (disk) goes to the baseline so the next blur is
        // checked against it, and the two are shown side by side.
        if (r.conflict === true) {
          setConflictDisk(r.content);
        } else {
          setConflictDisk(null);
          // Only when the box still holds what was sent: the user may have
          // typed on while the write was in flight, and that newer text is
          // the only copy of it.
          setDraft((current) => (current === next ? r.content : current));
          settledClean = true;
        }
      } catch {
        // Transport failure. Re-read disk to refresh the BASELINE, but never
        // overwrite the draft — the user's text is the only copy that exists.
        setConflict(false);
        setConflictDisk(null);
        setSaveFailed(true);
        const snap = await memoryUserInstructions(bridge).catch(() => null);
        if (snap) {
          setValue(snap.content);
          baseline.current = snap.content;
        }
      } finally {
        inFlight.current = false;
      }
      // A blur queued behind this write. Sent only after a clean write: on a
      // conflict or a failure the newer text is still in the box (the draft
      // is never overwritten there), and the user's next blur retries it.
      const pending = queued.current;
      queued.current = null;
      if (settledClean && pending !== null && pending !== baseline.current) {
        await commitRef.current(pending);
      }
    },
    [bridge],
  );
  const commitRef = React.useRef(commit);
  commitRef.current = commit;

  const otherUserFiles = userFiles.filter((f) => !samePath(f.path, path));

  return (
    <SettingsSection
      title={t("settings.general.instructions")}
      description={t("settings.general.instructionsDescription")}
    >
      {value === null ? (
        <p className="text-muted-foreground text-sm">{t("settings.loading")}</p>
      ) : (
        <>
          <textarea
            id="user-instructions"
            value={draft}
            placeholder={t("settings.general.instructionsPlaceholder")}
            rows={5}
            onChange={(e) => setDraft(e.target.value)}
            disabled={unreadable}
            onBlur={(e) => {
              const next = e.currentTarget.value;
              if (!unreadable && next !== value) void commit(next);
            }}
            className={cn(
              "flex min-h-[120px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none",
              "placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
            )}
            data-testid="user-instructions"
          />
          {unreadable ? (
            <p
              className="mt-2 text-destructive text-sm"
              data-testid="user-instructions-unreadable"
            >
              {t("settings.general.instructionsUnreadable")}
            </p>
          ) : null}
          {saveFailed ? (
            <p
              className="mt-2 text-destructive text-sm"
              data-testid="user-instructions-save-failed"
            >
              {t("settings.general.instructionsSaveFailed")}
            </p>
          ) : null}
          {conflict ? (
            <>
              <p
                className="mt-2 text-destructive text-sm"
                data-testid="user-instructions-conflict"
              >
                {t("settings.general.instructionsConflict")}
              </p>
              <textarea
                readOnly
                rows={5}
                value={conflictDisk ?? ""}
                data-testid="user-instructions-disk"
                className={cn(
                  "mt-2 flex min-h-[120px] w-full resize-y rounded-md border border-input bg-muted/40 px-3 py-2 text-sm shadow-sm outline-none",
                )}
              />
            </>
          ) : null}
          {path ? (
            <p
              className="mt-2 truncate font-mono text-muted-foreground text-xs"
              title={path}
              data-testid="user-instructions-path"
            >
              {path}
            </p>
          ) : null}
          {otherUserFiles.length > 0 ? (
            <div
              className="mt-3 flex flex-col gap-1"
              data-testid="user-instruction-files"
            >
              <SettingsGroupLabel>
                {t("settings.memory.otherUserFiles")}
              </SettingsGroupLabel>
              <InstructionFileRows files={otherUserFiles} />
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

/** Path equality across separator style and case (Windows paths). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/** Compact byte-size formatter for the file list (no i18n — units are universal
 *  short forms). Mirrors the same helper in MemorySection's saved-memory list. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Containing directory of a file path (for "Open" → reveal the folder). */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

const TIER_LABEL_KEYS = {
  Project: "settings.memory.tierProject",
  Local: "settings.memory.tierLocal",
} as const;

/**
 * "This project" — the Project and Local tier files of the session the client
 * shows, grouped by tier. READ-ONLY: each row has an "Open" (reveal the
 * containing folder) but NO delete — these are your files, never touched by
 * Memory's "Clear all". `files` is null while the discovery is loading.
 */
function InstructionFilesList({ files }: { files: InstructionFile[] | null }) {
  const t = useT();
  const groups = (["Project", "Local"] as const)
    .map((tier) => ({ tier, files: (files ?? []).filter((f) => f.tier === tier) }))
    .filter((g) => g.files.length > 0);

  return (
    <SettingsSection
      title={t("settings.memory.instructionsTitle")}
      description={t("settings.memory.instructionsDescription")}
    >
      <div
        className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4"
        data-testid="memory-instructions"
      >
        {files && files.length === 0 ? (
          <p
            className="text-muted-foreground text-sm"
            data-testid="memory-instructions-empty"
          >
            {t("settings.memory.noInstructions")}
          </p>
        ) : null}
        {groups.map((g) => (
          <div key={g.tier} className="flex flex-col gap-1">
            <SettingsGroupLabel>{t(TIER_LABEL_KEYS[g.tier])}</SettingsGroupLabel>
            <InstructionFileRows files={g.files} />
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

/** One row per file: path, size, and "Open" (reveals the containing folder). */
function InstructionFileRows({ files }: { files: InstructionFile[] }) {
  const t = useT();
  const hostActions = useSettingsHostActions();
  return (
    <ul className="flex flex-col gap-1">
      {files.map((f) => (
        <li
          key={f.path}
          className="flex items-center justify-between gap-4 text-sm"
        >
          <span className="min-w-0 truncate font-mono" title={f.path}>
            {f.path}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {formatBytes(f.bytes)}
            </span>
            {hostActions ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void hostActions.revealFolder(dirOf(f.path))}
                data-testid="memory-instruction-open"
              >
                {t("settings.memory.open")}
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
