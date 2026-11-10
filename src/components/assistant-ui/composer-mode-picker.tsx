import { useSessionAreaVisible } from "@/browser/webview/sessionAreaVisibility";
import { CheckIcon, ChevronDownIcon, ClipboardListIcon } from "lucide-react";
import {
  type FC,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useT, type TranslateFn } from "@/browser/webview/i18n";
import {
  coerceSessionMode,
  modeLabel,
  modePillLabel,
  modeTone,
  nextModeInCycle,
  pickerModes,
  type ModeTone,
  type SessionMode,
} from "@/permissions/sessionModes";
import { PermissionModeContext } from './thread-contexts';

// Concrete text class for each abstract mode tone on the composer pill.
const MODE_TONE_CLASS: Record<ModeTone, string> = {
  muted: "text-muted-foreground",
  success: "text-success",
  info: "text-info",
  danger: "text-warning",
  caution: "text-warning",
};

// Localized mode labels; modes without a key fall back to the module's English label.
function localizedModeTitle(t: TranslateFn, m: SessionMode): string {
  switch (m) {
    case "default":
      return t("permissionMode.title.default");
    case "acceptEdits":
      return t("permissionMode.title.acceptEdits");
    case "plan":
      return t("permissionMode.title.plan");
    case "bypassPermissions":
      return t("permissionMode.title.bypassPermissions");
    default:
      return modeLabel(m);
  }
}

function localizedModeShortTitle(t: TranslateFn, m: SessionMode): string {
  switch (m) {
    case "default":
      return t("permissionMode.short.default");
    case "acceptEdits":
      return t("permissionMode.short.acceptEdits");
    case "plan":
      return t("permissionMode.short.plan");
    case "bypassPermissions":
      return t("permissionMode.short.bypassPermissions");
    default:
      return modePillLabel(m);
  }
}

// Plan-mode banner. Display only: the enforcement is `isToolAllowedInPlanMode` and the
// plan prompt (`renderPlanModeAttachment`).
export const PlanModeBanner: FC = () => {
  const t = useT();
  const ctx = useContext(PermissionModeContext);
  const mode = coerceSessionMode(ctx?.mode ?? "default");
  if (mode !== "plan") return null;
  return (
    <div
      className="aui-plan-mode-banner mb-2 flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-1.5 text-info text-xs"
      role="status"
    >
      <ClipboardListIcon className="size-3.5 shrink-0" />
      <span>
        <span className="font-medium">{t("permissionMode.planBannerName")}</span>{" "}
        {t("permissionMode.planBannerBody")}
      </span>
    </div>
  );
};

// Composer permission-mode pill + popover menu. Offers the four modes
// (Ask permissions / Accept edits / Plan mode / Bypass permissions) and
// cycles with Shift+Ctrl+M via the shared nextModeInCycle. Renders
// nothing unless a PermissionModeProvider supplies the host setter.
export const ComposerModePicker: FC = () => {
  const t = useT();
  const ctx = useContext(PermissionModeContext);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Coerce the raw snapshot string to a typed SessionMode (also guards
  // against an unexpected persisted value — unknown ⇒ default).
  const mode = coerceSessionMode(ctx?.mode ?? "default");
  const setMode = ctx?.setMode;
  const isActive = ctx?.isActive ?? false;
  const bypassDisabled = ctx?.bypassDisabled === true;
  // Foreground is not enough: the shell keeps the session area MOUNTED but
  // hidden while Settings is open, and the foreground thread's picker stayed
  // bound under it — Ctrl+Shift+M on the settings page cycled the hidden
  // session's permission mode. One shell-provided flag, read here.
  const sessionAreaVisible = useSessionAreaVisible();

  // Shift+Ctrl+M cycles the mode. Only the foreground session's picker binds
  // the global shortcut so background threads in the LRU don't also fire —
  // and only while the session area is on screen.
  useEffect(() => {
    if (!isActive || !sessionAreaVisible || !setMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && e.ctrlKey && (e.key === "M" || e.key === "m")) {
        e.preventDefault();
        // The browser host has no sandbox gating, so bypass is on the ring
        // by default; the settings kill switch
        // (`permissions.disableBypassPermissionsMode`) is honored and skips it.
        setMode(
          nextModeInCycle(mode, {
            bypassOffered: true,
            bypassDisabled,
          }),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, sessionAreaVisible, setMode, mode, bypassDisabled]);

  // Dismiss the popover on outside-click / Escape.
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

  if (!setMode) return null;

  const colorClass = MODE_TONE_CLASS[modeTone(mode)] ?? "text-muted-foreground";

  return (
    <div ref={rootRef} className="aui-composer-mode-picker relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("thread.permissionMode")}
        className={`aui-composer-mode-pill flex items-center gap-0.5 rounded-full px-2 py-0.5 font-medium text-caption transition-colors hover:bg-accent ${colorClass}`}
      >
        {localizedModeShortTitle(t, mode)}
        <ChevronDownIcon className="size-3 opacity-60" />
      </button>
      {open && (
        <div
          role="menu"
          className="aui-composer-mode-menu absolute bottom-full left-0 z-50 mb-1 min-w-48 overflow-hidden rounded-xl border bg-background p-1 shadow-md"
        >
          {pickerModes(bypassDisabled).map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === mode}
              onClick={() => {
                setMode(m);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span>{localizedModeTitle(t, m)}</span>
              {m === mode && <CheckIcon className="size-3.5 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
