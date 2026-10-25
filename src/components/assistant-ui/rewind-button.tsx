import { useState, type FC } from "react";
import { HistoryIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/browser/webview/i18n";

/**
 * The "Rewind to here" message action. Rewind discards everything after the
 * message, so it asks first through an in-app modal: `window.confirm` is
 * suppressed in the webview guest and returns false without showing anything.
 */
export const RewindButton: FC<{ onRewind: () => void }> = ({ onRewind }) => {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <TooltipIconButton
        tooltip={t("action.rewind")}
        onClick={() => setConfirming(true)}
      >
        <HistoryIcon />
      </TooltipIconButton>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("action.rewind")}</DialogTitle>
            <DialogDescription>{t("action.rewindConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              {t("thread.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="confirm-rewind"
              onClick={() => {
                setConfirming(false);
                onRewind();
              }}
            >
              {t("action.rewindConfirmAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
