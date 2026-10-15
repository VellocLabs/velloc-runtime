import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  LoaderIcon,
  LockIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  coerceFileText,
  FileContentView,
  FilePathHeader,
} from "@/components/assistant-ui/file-content-view";
import { StaticMarkdown } from "@/components/assistant-ui/static-markdown";
import type { RightPanelFileTarget } from "@/components/assistant-ui/right-panel-content-context";
// Type-only: erased at build, so importing it never pulls the `@codemirror/*`
// stack onto the boot bundle (the editor stays behind the lazy import below).
import type { CodeMirrorApi } from "@/components/assistant-ui/CodeMirrorView";
import { useT } from "./i18n";
import { rememberBounded } from "@/components/assistant-ui/boundedUiMemory";

// CodeMirror (+ its language grammars) is loaded ONLY when a non-markdown file
// is actually shown here — a lazy dynamic import keeps the whole editor stack
// off the boot bundle. Until the chunk arrives, the plain line-numbered
// `FileContentView` renders the already-loaded content as the Suspense
// fallback, so there's no blank flash and no loss of function if it never loads.
const CodeMirrorView = lazy(
  () => import("@/components/assistant-ui/CodeMirrorView"),
);

/**
 * Right-panel Files view: the current file, read live via `readFileText`. Non-markdown files
 * are editable when the host supplies `writeFileText`, read-only while `editingLocked`;
 * markdown gets a Rendered/Raw toggle and stays a viewer.
 */

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; content: string }
  | { status: "error"; message: string };

const MARKDOWN_FILE = /\.(md|markdown)$/i;

function MarkdownViewToggle({
  view,
  onChange,
}: {
  view: "rendered" | "raw";
  onChange: (view: "rendered" | "raw") => void;
}) {
  const t = useT();
  const options = [
    { key: "rendered" as const, label: t("filePanel.viewRendered") },
    { key: "raw" as const, label: t("filePanel.viewRaw") },
  ];
  return (
    <div
      data-slot="file-panel-view-toggle"
      className="flex shrink-0 items-center gap-0.5 rounded-md border p-0.5"
    >
      {options.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          data-slot={`file-panel-view-${key}`}
          aria-pressed={view === key}
          onClick={() => onChange(key)}
          className={
            view === key
              ? "rounded bg-muted px-1.5 py-0.5 text-foreground text-caption"
              : "rounded px-1.5 py-0.5 text-muted-foreground text-caption hover:text-foreground"
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Re-reads the file from disk on demand. The turn-end auto-refresh only fires
 *  on the active session's lock→unlock, so a file changed by anything else — a
 *  background task, a sub-agent, an out-of-band write — would otherwise stay
 *  frozen at the content captured when it was opened (e.g. from the whole-session
 *  diff). This gives an always-available manual refresh; a clean file adopts the
 *  on-disk copy silently, unsaved edits raise the same conflict banner. Spins
 *  while the re-read is in flight. */
function FileRefreshButton({
  refreshing,
  onClick,
}: {
  refreshing: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="file-panel-refresh"
      aria-label={t("filePanel.refresh")}
      title={t("filePanel.refresh")}
      disabled={refreshing}
      onClick={onClick}
      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
    </button>
  );
}

/** Opens the editor's find panel (Ctrl/Cmd+F) from the header — a discoverable
 *  affordance for the keyboard shortcut. No-op until the lazy editor mounts. */
function FileSearchButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="file-panel-search"
      aria-label={t("filePanel.search")}
      title={`${t("filePanel.search")} (Ctrl/⌘F)`}
      onClick={onClick}
      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <SearchIcon className="size-3.5" />
    </button>
  );
}

/** Explicit-save control for the editable Files view. Disabled (with an
 *  explanatory tooltip) while editing is locked — a turn is running and the
 *  agent may be writing the same files — or when there are no unsaved changes.
 *  A dot marks unsaved edits; a lock icon replaces the save glyph when locked. */
function FileSaveButton({
  dirty,
  locked,
  saving,
  onClick,
}: {
  dirty: boolean;
  locked: boolean;
  saving: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const disabled = !dirty || locked || saving;
  const title = locked
    ? t("filePanel.editLocked")
    : `${t("filePanel.save")} (Ctrl/⌘S)`;
  return (
    <button
      type="button"
      data-testid="file-panel-save"
      aria-label={t("filePanel.save")}
      aria-keyshortcuts="Control+S Meta+S"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-caption",
        disabled
          ? "text-muted-foreground/50"
          : "text-foreground hover:bg-muted",
      )}
    >
      {locked ? (
        <LockIcon className="size-3.5" />
      ) : saving ? (
        <LoaderIcon className="size-3.5 animate-spin" />
      ) : (
        <SaveIcon className="size-3.5" />
      )}
      <span>{t("filePanel.save")}</span>
      {dirty && !saving ? (
        <span
          aria-hidden
          data-testid="file-panel-dirty"
          className="size-1.5 rounded-full bg-primary"
        />
      ) : null}
    </button>
  );
}

/** Shown when the file changed on disk (the agent wrote it during a turn) while
 *  the user has UNSAVED edits — so a blind save wouldn't silently clobber the
 *  agent's version. Reload discards the user's edits for the on-disk copy; Keep
 *  mine dismisses and preserves them (the next save overwrites disk). */
function DiskChangedBanner({
  onReload,
  onKeepMine,
}: {
  onReload: () => void;
  onKeepMine: () => void;
}) {
  const t = useT();
  return (
    <div
      data-testid="file-panel-conflict"
      className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-body"
    >
      <span className="min-w-0 flex-1 text-foreground">
        {t("filePanel.diskChanged")}
      </span>
      <button
        type="button"
        data-testid="file-panel-reload"
        onClick={onReload}
        className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-foreground hover:bg-muted/70"
      >
        {t("filePanel.reload")}
      </button>
      <button
        type="button"
        data-testid="file-panel-keep-mine"
        onClick={onKeepMine}
        className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
      >
        {t("filePanel.keepMine")}
      </button>
    </div>
  );
}

/**
 * Unsaved edits of a dirty editor that unmounted (session switch, tab close), keyed by path
 * and restored as a dirty draft by the next FilePanel for it. Page-lifetime, small cap.
 */
const unsavedFileDrafts = new Map<string, { text: string; baseline: string }>();
const UNSAVED_DRAFTS_MAX = 16;

/** Test-only: the draft store is module-level (page lifetime), so tests that
 *  unmount a dirty editor must clear it between cases. */
export function __resetUnsavedFileDraftsForTests(): void {
  unsavedFileDrafts.clear();
}

export function FilePanel({
  target,
  readFileText,
  writeFileText,
  editingLocked = false,
  onDirtyChange,
  reveal,
}: {
  target: RightPanelFileTarget | null;
  /** Resolves `null` when no client can read right now (no active session
   *  client) — NOT an empty file. Treated as an unavailable read everywhere. */
  readFileText?: (path: string) => Promise<string | null>;
  writeFileText?: (path: string, text: string) => Promise<boolean>;
  /** Lock the editor read-only (a turn is running; the agent may be writing). */
  editingLocked?: boolean;
  /**
   * Reveal request from a `path:42` transcript mention: move the cursor to
   * `line` and center it. `nonce` makes the request edge-triggered — clicking
   * the same `path:42` again re-reveals even though the line is unchanged.
   * May arrive before the (lazy, async-loaded) editor exists; it is stashed
   * and delivered the moment the editor reports ready.
   */
  reveal?: { line: number; nonce: number } | null;
  /**
   * Report unsaved-edit state upward. The right panel bounds how many tab
   * bodies stay mounted, and an unsaved edit lives ONLY in this mounted
   * editor's doc — so the owner uses this to mark the view un-releasable.
   * Always reports `false` on unmount / file change, so the owner's set
   * describes mounted bodies and nothing else.
   */
  onDirtyChange?: (path: string, dirty: boolean) => void;
}): ReactElement {
  const t = useT()
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // When the file changes on disk (agent write) while the user has unsaved
  // edits, this holds the fresh on-disk text and drives the reconcile banner.
  const [conflict, setConflict] = useState<string | null>(null);
  // Imperative handle onto the lazy editor (set via its `onReady`), so the
  // header Search/Save buttons drive it without FilePanel importing any
  // `@codemirror` symbol.
  const cmApiRef = useRef<CodeMirrorApi | null>(null);
  // A reveal that arrived before the editor mounted (lazy chunk + async file
  // load); delivered by `onReady`. Cleared once fired so a remount (Rendered/
  // Raw toggle) doesn't replay a stale jump.
  const pendingRevealRef = useRef<{ line: number; nonce: number } | null>(null);
  // Latest state/dirty/lock, read by the turn-end refresh effect without adding
  // them to its deps (so it fires only on the lock transition, not every edit).
  const stateRef = useRef(state);
  stateRef.current = state;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const prevLockedRef = useRef(editingLocked);
  const path = target?.path;
  const isMarkdown = !!path && MARKDOWN_FILE.test(path);
  // The syntax-highlighted editor body is shown for every ready file except
  // markdown in its Rendered view (which uses the markdown renderer instead).
  const showEditorBody =
    state.status === "ready" && !(isMarkdown && view === "rendered");
  // Editing is offered for non-markdown files when the host provides a writer.
  // Markdown stays a viewer (its Rendered/Raw preview would drop edits on a
  // toggle), and the editor is locked read-only while a turn runs.
  const canEdit = showEditorBody && !isMarkdown && !!writeFileText;
  const editorReadOnly = !canEdit || editingLocked;

  useEffect(() => {
    // Each newly opened file starts on the default view.
    setView("rendered");
  }, [path]);

  // Publish unsaved-edit state so the panel's mount cache won't release this
  // body while there is typing to lose. The cleanup reports `false` on unmount
  // AND on a path change, so the flag can never outlive the editor holding it.
  useEffect(() => {
    if (!path || !onDirtyChange) return;
    onDirtyChange(path, dirty);
    return () => onDirtyChange(path, false);
  }, [path, dirty, onDirtyChange]);

  // Deliver a reveal request. Edge-triggered on the NONCE — a primitive,
  // because the `reveal` object is minted fresh by the parent on every render
  // and keying on its identity would re-jump every render. Re-clicking the
  // same `path:42` bumps the nonce and re-centers. When the editor isn't
  // mounted yet (lazy chunk / file still loading) the request is stashed for
  // `onReady`.
  const revealLine = reveal?.line;
  const revealNonce = reveal?.nonce;
  useEffect(() => {
    if (revealLine === undefined || revealNonce === undefined) return;
    const api = cmApiRef.current;
    if (api) api.revealLine(revealLine);
    else pendingRevealRef.current = { line: revealLine, nonce: revealNonce };
  }, [revealLine, revealNonce]);

  useEffect(() => {
    // A new file (or reload) starts clean, with any prior save error / conflict
    // cleared.
    setDirty(false);
    setSaveError(null);
    setConflict(null);
    if (!path) {
      setState({ status: "idle" });
      return;
    }
    if (!readFileText) {
      setState({
        status: "error",
        message: t("filePanel.readUnavailable"),
      });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    readFileText(path)
      .then((content) => {
        if (cancelled) return;
        // No client to read with: an empty editor here would be saved back
        // over the real file.
        if (content === null) {
          setState({ status: "error", message: t("filePanel.readUnavailable") });
          return;
        }
        setState({ status: "ready", content: coerceFileText(content) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message:
            error instanceof Error ? error.message : t("filePanel.readFailed"),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path, readFileText]);

  // After a turn ends (editing unlocks), re-read the file to see whether the
  // agent wrote it while it was open here. No unsaved edits → silently adopt the
  // new on-disk content (the view refreshes). Unsaved edits → raise the conflict
  // banner so the user chooses reload vs keep-mine instead of a blind overwrite
  // on the next save. Runs ONLY on the lock→unlock transition (deps), reading
  // current state/dirty via refs.
  useEffect(() => {
    const wasLocked = prevLockedRef.current;
    prevLockedRef.current = editingLocked;
    if (!wasLocked || editingLocked) return; // only on lock → unlock
    const s = stateRef.current;
    if (s.status !== "ready" || !path || !readFileText) return;
    const loaded = s.content;
    let cancelled = false;
    readFileText(path)
      .then((raw) => {
        // `null` = nothing could read (no client), not an emptied file.
        if (cancelled || raw === null) return;
        const disk = coerceFileText(raw);
        if (disk === loaded) return; // unchanged on disk
        if (dirtyRef.current) {
          setConflict(disk); // unsaved edits — let the user decide
        } else {
          setState({ status: "ready", content: disk }); // refresh silently
        }
      })
      .catch(() => {
        // Refresh failed — keep showing the current content.
      });
    return () => {
      cancelled = true;
    };
  }, [editingLocked, path, readFileText]);

  // Explicit save: write the current editor text back via the host bridge, then
  // rebaseline the editor (dirty clears via markSaved's callback) and reflect
  // the saved text as the loaded content (updates the copy affordance too).
  // Guarded so a keyboard ⌘/Ctrl+S can't write while locked/clean/in-flight.
  const handleSave = () => {
    const api = cmApiRef.current;
    if (!api || !writeFileText || !path) return;
    if (!canEdit || editingLocked || saving || !dirty) return;
    const text = api.getValue();
    setSaving(true);
    setSaveError(null);
    writeFileText(path, text)
      .then((ok) => {
        if (!ok) {
          setSaveError(t("filePanel.saveUnavailable"));
          return;
        }
        api.markSaved(text);
        setState({ status: "ready", content: text });
        // Saving IS the "keep mine" resolution — the user's text is now on disk.
        setConflict(null);
      })
      .catch((error: unknown) => {
        setSaveError(
          error instanceof Error ? error.message : t("filePanel.saveFailed"),
        );
      })
      .finally(() => setSaving(false));
  };

  // Manual re-read from disk (header Refresh button). Mirrors the turn-end
  // auto-refresh, but fires ON DEMAND — so a file changed by something other
  // than the active session's own turn (a background task, a sub-agent, an
  // out-of-band write) can still be brought current. A clean file adopts the
  // on-disk copy silently; unsaved edits raise the conflict banner instead of
  // being clobbered. Guarded against firing while a read is already in flight.
  const handleRefresh = () => {
    if (!path || !readFileText || state.status !== "ready" || refreshing) return;
    const loaded = state.content;
    setRefreshing(true);
    readFileText(path)
      .then((raw) => {
        // `null` = nothing could read (no client), not an emptied file: adopting
        // "" would blank a clean editor, and the next save would truncate disk.
        if (raw === null) return;
        const disk = coerceFileText(raw);
        if (disk === loaded) return; // already current
        // Read dirty at resolve time (like the turn-end path) — the user may
        // have typed while the re-read was in flight.
        if (dirtyRef.current) setConflict(disk); // unsaved edits — let the user decide
        else setState({ status: "ready", content: disk }); // adopt silently
      })
      .catch(() => {
        // Failed re-read — keep showing the current content.
      })
      .finally(() => setRefreshing(false));
  };

  // Conflict banner actions. Reload force-replaces the editor with the on-disk
  // text (bypassing the no-clobber guard) and drops the dirty state; Keep mine
  // just dismisses — the edits stay and the next save overwrites disk.
  const handleReload = () => {
    if (conflict === null) return;
    cmApiRef.current?.reloadContent(conflict);
    setState({ status: "ready", content: conflict });
    setDirty(false);
    setConflict(null);
  };
  const handleKeepMine = () => setConflict(null);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground text-body">
        {t("filePanel.noFileOpen")}
      </div>
    );
  }

  return (
    <div
      data-testid="file-panel"
      className="flex h-full min-h-0 flex-col gap-2 p-2"
    >
      <FilePathHeader
        path={path}
        copyText={state.status === "ready" ? state.content : path}
        copyTooltip={t("filePanel.copyFileContents")}
        copyAlwaysVisible
        trailing={
          isMarkdown || showEditorBody ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {isMarkdown ? (
                <MarkdownViewToggle view={view} onChange={setView} />
              ) : null}
              {canEdit ? (
                <FileSaveButton
                  dirty={dirty}
                  locked={editingLocked}
                  saving={saving}
                  onClick={handleSave}
                />
              ) : null}
              {state.status === "ready" && readFileText ? (
                <FileRefreshButton
                  refreshing={refreshing}
                  onClick={handleRefresh}
                />
              ) : null}
              {showEditorBody ? (
                <FileSearchButton
                  onClick={() => cmApiRef.current?.openSearch()}
                />
              ) : null}
            </div>
          ) : undefined
        }
      />
      {conflict !== null ? (
        <DiskChangedBanner
          onReload={handleReload}
          onKeepMine={handleKeepMine}
        />
      ) : null}
      {saveError ? (
        <div
          data-testid="file-panel-save-error"
          className="px-1 text-destructive text-body"
        >
          {saveError}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {state.status === "loading" ? (
          <div className="flex items-center gap-2 px-1 py-2 text-muted-foreground text-body">
            <LoaderIcon className="size-3 animate-spin" />
            <span>{t("filePanel.loadingFile")}</span>
          </div>
        ) : state.status === "error" ? (
          <div className="px-1 py-2 text-destructive text-body">
            {state.message}
          </div>
        ) : state.status === "ready" ? (
          isMarkdown && view === "rendered" ? (
            <div className="h-full overflow-auto rounded-md border bg-background px-3 py-2">
              <StaticMarkdown content={state.content} />
            </div>
          ) : (
            <Suspense
              fallback={
                <FileContentView content={state.content} numbered={false} fill />
              }
            >
              <CodeMirrorView
                content={state.content}
                filename={path}
                readOnly={editorReadOnly}
                onReady={(api) => {
                  cmApiRef.current = api;
                  // Restore a draft stashed by a released/unmounted body for
                  // this path — consumed on delivery, so it fires once. When
                  // the disk moved while the draft was parked (the agent wrote
                  // the file), raise the same conflict banner an in-editor
                  // disk change does: the draft stays in the doc, the fresh
                  // disk copy is one click away.
                  if (api && path) {
                    const draft = unsavedFileDrafts.get(path);
                    if (draft) {
                      unsavedFileDrafts.delete(path);
                      const disk =
                        stateRef.current.status === "ready"
                          ? stateRef.current.content
                          : draft.baseline;
                      api.restoreDraft(draft.text);
                      if (disk !== draft.baseline) setConflict(disk);
                    }
                  }
                  const pending = pendingRevealRef.current;
                  if (api && pending) {
                    pendingRevealRef.current = null;
                    api.revealLine(pending.line);
                  }
                }}
                onDirtyChange={setDirty}
                onSave={handleSave}
                onUnmountWhileDirty={(draft) => {
                  if (!path) return;
                  rememberBounded(
                    unsavedFileDrafts,
                    path,
                    draft,
                    UNSAVED_DRAFTS_MAX,
                  );
                }}
              />
            </Suspense>
          )
        ) : null}
      </div>
    </div>
  );
}
