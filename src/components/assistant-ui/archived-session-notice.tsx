import { useContext, type FC } from "react";
import { ArchiveRestoreIcon } from "lucide-react";
import { useT } from "@/browser/webview/i18n";
import { ArchivedSessionContext } from "./thread-contexts";

/**
 * The line above the composer of an archived session: the composer is held
 * until the person unarchives it here, and the same transcript carries on.
 * Renders nothing for any other session. (F-36)
 */
export const ArchivedSessionNotice: FC = () => {
  const t = useT();
  const archived = useContext(ArchivedSessionContext);
  if (!archived) return null;

  return (
    <div
      role="status"
      data-slot="archived-session-notice"
      data-testid="archived-session-notice"
      className="flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1">{t("composer.archivedNotice")}</span>
      <button
        type="button"
        data-testid="archived-session-unarchive"
        onClick={() => archived.onUnarchive()}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 font-medium transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArchiveRestoreIcon className="size-3.5 shrink-0" />
        {t("sidebar.unarchive")}
      </button>
    </div>
  );
};
