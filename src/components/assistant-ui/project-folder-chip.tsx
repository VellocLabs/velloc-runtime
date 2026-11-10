import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
} from "lucide-react";
import {
  type FC,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useT } from "@/browser/webview/i18n";
import { readRecentFolders, type RecentFolder } from "@/browser/webview/recentFoldersStorage";
import { resolveChipFolder } from "@/components/assistant-ui/resolveChipFolder";
import { useCapabilities } from "@/browser/webview/useCan";
import { basenameRuntimePath } from "@/utils/runtimePaths";
import { ProjectFolderContext } from './thread-contexts';

// Normalize a path for display-time equality (trailing-separator + slash-style
// differences): the resolved `projectRoot` carries a trailing separator while a
// recent-folder `path` (straight from the picker) does not, so a raw `===`
// would never mark the current folder. Cosmetic only (drives the ✓), so a
// case-sensitive compare after normalizing is sufficient.
function isSameFolderPath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

// Git-branch chip shown next to the folder chip (folder name + current
// branch). Click → a small "Copy branch name" menu. The branch comes from the runtime snapshot
// (`projectBranch`, resolved via the host Bash tool).
const ProjectBranchChip: FC<{ branch: string }> = ({ branch }) => {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Dismiss on outside-click / Escape (same pattern as the folder chip).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleCopy = () => {
    try {
      void globalThis.navigator?.clipboard?.writeText(branch);
    } catch {
      // clipboard may be unavailable; best-effort.
    }
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className="aui-project-branch-chip-root relative w-fit max-w-full"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("projectFolder.branchLabel", { name: branch })}
        title={branch}
        className="aui-project-branch-chip flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-muted-foreground text-caption transition-colors hover:bg-accent hover:text-foreground"
      >
        <GitBranchIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        <span className="max-w-80 truncate">{branch}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="aui-project-branch-menu absolute bottom-full left-0 z-50 mb-1 min-w-44 overflow-hidden rounded-xl border bg-background p-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleCopy}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
          >
            <CopyIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
            <span>{t("projectFolder.copyBranch")}</span>
          </button>
        </div>
      )}
    </div>
  );
};

// Composer-top chip showing the current project folder for a `code` session.
// Click opens a dropdown of recent folders (✓ on the current) + "Open folder…".
// Locked (read-only, no dropdown) once the session has messages — to switch
// folders the user starts a new session. Mirrors `ComposerModePicker`'s
// custom-popover (outside-click / Escape dismiss, active-checkmark) pattern.
// Exported for its render test.
export const CurrentProjectFolderChip: FC = () => {
  const t = useT();
  const controls = useContext(ProjectFolderContext);
  // Two items act on the HOST machine: "Show in Explorer" opens its file
  // manager (`ui.revealProjectFolder`) and "Open folder…" its native folder
  // picker (`ui.pickProjectFolder`), both `full`. A scoped connection gets
  // neither item instead of one that is refused when clicked; Copy path and
  // the folder switcher's known folders stay. A `full` grant and a tree with
  // no capability provider both answer true, so the desktop menu is unchanged.
  const capabilities = useCapabilities();
  const canRevealFolder = capabilities.can("ui", "revealProjectFolder");
  const canPickFolder = capabilities.can("ui", "pickProjectFolder");
  const rootRef = useRef<HTMLDivElement>(null);
  // Last bound folder we displayed — keeps a locked session's chip stable
  // against transient snapshot flips (see `resolveChipFolder`).
  const rememberedRootRef = useRef<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<readonly RecentFolder[]>([]);

  // Refresh the recent list whenever the menu opens — it lives in
  // localStorage, so another session may have added entries since last render.
  useEffect(() => {
    if (open) setRecent(readRecentFolders());
  }, [open]);

  // Dismiss on outside-click / Escape (same as ComposerModePicker).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Gate: any session on a folder-picker-capable host gets the chip. `code` is
  // *forced* to bind (needsProjectFolder); agent/chat/project default to their
  // per-type `<type>` root and may pick a different folder before the
  // first message. Mock/dev hosts (no native picker) still get no chip.
  if (!controls || !controls.canPick) {
    return null;
  }

  // Resolve the folder to show (stable across a locked session's lifetime, and
  // resilient to a transient snapshot reporting the sandbox / needs-folder).
  const {
    remembered,
    display: displayProjectRoot,
    showOpenCta,
  } = resolveChipFolder(rememberedRootRef.current, controls);
  rememberedRootRef.current = remembered;

  const folderName = displayProjectRoot
    ? basenameRuntimePath(displayProjectRoot)
    : "";
  // Show the "Open folder…" call-to-action only when genuinely unbound — never
  // for a locked (bound) session, even if a stray snapshot says otherwise.
  const label = showOpenCta ? t("projectFolder.openFolder") : folderName;
  const ariaLabel = t("projectFolder.chipLabel", { name: label });

  // The folder has revealable/copyable actions whenever a real folder is bound.
  const hasFolderActions = !showOpenCta && !!displayProjectRoot;
  // Recent bound folders EXCLUDING the current one — the current folder is
  // rendered separately at the top of the switcher (checked), so the active
  // folder is always visible even when it is the per-type default
  // (`shared-workspace/<type>`), which never enters the bound-folders MRU. This
  // also de-dupes the current folder out of the "Recent" section.
  const otherRecent = displayProjectRoot
    ? recent.filter((f) => !isSameFolderPath(f.path, displayProjectRoot))
    : recent;
  const handleReveal = () => {
    if (displayProjectRoot) controls.onRevealFolder(displayProjectRoot);
    setOpen(false);
  };
  const handleCopyPath = () => {
    if (displayProjectRoot) {
      try {
        void globalThis.navigator?.clipboard?.writeText(displayProjectRoot);
      } catch {
        // clipboard may be unavailable; best-effort.
      }
    }
    setOpen(false);
  };

  // Folder chip — always clickable, even when the folder is locked, so its
  // folder actions stay reachable. Menu = folder actions (Show in Explorer / Copy path) and, while
  // unlocked, the switcher (recent folders + Open folder…).
  const folderChip = (
    <div
      ref={rootRef}
      className="aui-project-folder-chip-root relative w-fit max-w-full"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-locked={controls.locked ? "true" : undefined}
        data-needs-folder={controls.needsProjectFolder ? "true" : undefined}
        title={displayProjectRoot}
        className="aui-project-folder-chip flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 font-medium text-muted-foreground text-caption transition-colors hover:bg-accent hover:text-foreground"
      >
        <FolderIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="aui-project-folder-menu absolute bottom-full left-0 z-50 mb-1 min-w-56 overflow-hidden rounded-xl border bg-background p-1 shadow-md"
        >
          {hasFolderActions && (
            <>
              {canRevealFolder && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleReveal}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <FolderOpenIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                  <span>{t("projectFolder.showInExplorer")}</span>
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={handleCopyPath}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
              >
                <CopyIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                <span>{t("projectFolder.copyPath")}</span>
              </button>
            </>
          )}
          {!controls.locked && (
            <>
              {hasFolderActions && (
                <div className="mx-1 my-1 h-px bg-border" aria-hidden="true" />
              )}
              {/* Current folder — always shown (checked) so the active folder
                  is visible in the switcher, including the per-type default
                  (`shared-workspace/<type>`) that never enters the recents MRU.
                  Clicking it is a no-op (already active); just close. */}
              {displayProjectRoot && (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={true}
                  title={displayProjectRoot}
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="truncate">{folderName}</span>
                  <CheckIcon className="size-3.5 shrink-0" />
                </button>
              )}
              {otherRecent.length > 0 && (
                <>
                  <div className="px-2.5 py-1 text-muted-foreground text-xs select-none">
                    {t("projectFolder.recent")}
                  </div>
                  {otherRecent.map((folder) => (
                    <button
                      key={folder.path}
                      type="button"
                      role="menuitemradio"
                      aria-checked={false}
                      title={folder.path}
                      onClick={() => {
                        controls.onSelectFolder(folder.path);
                        setOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      <span className="truncate">{folder.name}</span>
                    </button>
                  ))}
                </>
              )}
              {canPickFolder && (
                <>
                  {(displayProjectRoot || otherRecent.length > 0) && (
                    <div className="mx-1 my-1 h-px bg-border" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      controls.onOpenFolder();
                      setOpen(false);
                    }}
                    className="aui-project-folder-menu-open flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <FolderIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                    <span>{t("projectFolder.openFolder")}</span>
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );

  // Folder name (first item) + the folder's git branch (second item).
  // Rendered inside the composer footer's single bottom row (folder left,
  // cache/context indicators right), so no standalone-row positioning here —
  // the parent row owns the bottom-margin compensation against the footer's
  // padding.
  return (
    <div className="aui-project-folder-row flex max-w-full items-center gap-1.5 ml-5">
      {folderChip}
      {controls.branch ? <ProjectBranchChip branch={controls.branch} /> : null}
    </div>
  );
};
