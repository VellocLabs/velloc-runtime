import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BrowserLlmProvider } from "../../../../bridge/protocol/nexus_llm";
import type { CustomProviderRecord } from "../../../../../config/customProviderRegistry";
import type { TranslateFn } from "../../../i18n/translate";
import type { DeleteTarget } from "./modelsPageTypes";

/** Reset confirmation dialog — mirrors the original modal. */
export function renderResetConnectionDialog({
  t,
  resetOpen,
  setResetOpen,
  selectedProvider,
  doReset,
}: {
  t: TranslateFn;
  resetOpen: boolean;
  setResetOpen: Dispatch<SetStateAction<boolean>>;
  selectedProvider: BrowserLlmProvider | undefined;
  doReset: () => Promise<void>;
}) {
  return (
    <Dialog open={resetOpen} onOpenChange={setResetOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("settings.models.resetTitle", {
              provider:
                selectedProvider?.label ??
                t("settings.models.providerFallback"),
            })}
          </DialogTitle>
          <DialogDescription>
            {t("settings.models.resetDescription", {
              provider:
                selectedProvider?.label ??
                t("settings.models.thisProviderFallback"),
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setResetOpen(false)}>
            {t("settings.models.cancel")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void doReset()}
          >
            {t("settings.models.resetConnection")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete a custom provider, or remove a built-in from the home list. The
 * custom wording is deliberately NOT "Reset connection": for a user-created
 * provider it must be obvious that the whole thing goes away, not just the
 * key. A built-in is only disconnected — it stays on offer under "Add
 * provider".
 */
export function renderDeleteProviderDialog({
  t,
  deleteTarget,
  setDeleteTarget,
  confirmDelete,
}: {
  t: TranslateFn;
  deleteTarget: DeleteTarget | null;
  setDeleteTarget: Dispatch<SetStateAction<DeleteTarget | null>>;
  confirmDelete: () => Promise<void>;
}) {
  return (
    <Dialog
      open={deleteTarget !== null}
      onOpenChange={(open) => {
        if (!open) setDeleteTarget(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {deleteTarget?.custom === false
              ? t("settings.models.removeProviderTitle", {
                  name: deleteTarget.name,
                })
              : t("settings.models.deleteProviderTitle", {
                  name: deleteTarget?.name ?? "",
                })}
          </DialogTitle>
          <DialogDescription>
            {deleteTarget?.custom === false
              ? t("settings.models.removeProviderDescription", {
                  name: deleteTarget.name,
                })
              : t("settings.models.deleteProviderDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleteTarget(null)}
          >
            {t("settings.models.cancel")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            data-testid={
              deleteTarget?.custom === false
                ? "models-provider-remove-confirm"
                : "custom-provider-delete-confirm"
            }
            onClick={() => void confirmDelete()}
          >
            {deleteTarget?.custom === false
              ? t("settings.models.removeProviderConfirm")
              : t("settings.models.deleteProviderConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Unsaved-changes guard on the way back to home. */
export function renderDiscardChangesDialog({
  t,
  leaveConfirmOpen,
  setLeaveConfirmOpen,
  creating,
  selectedRecord,
  goHome,
}: {
  t: TranslateFn;
  leaveConfirmOpen: boolean;
  setLeaveConfirmOpen: Dispatch<SetStateAction<boolean>>;
  creating: boolean;
  selectedRecord: CustomProviderRecord | undefined;
  goHome: () => void;
}) {
  return (
    <Dialog open={leaveConfirmOpen} onOpenChange={setLeaveConfirmOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("settings.models.discardUnsavedTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("settings.models.discardUnsavedDescription", {
              name: creating
                ? t("settings.models.newCustomProvider")
                : (selectedRecord?.displayName ?? ""),
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            data-testid="custom-provider-keep-editing"
            onClick={() => setLeaveConfirmOpen(false)}
          >
            {t("settings.models.keepEditing")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            data-testid="custom-provider-discard-confirm"
            onClick={goHome}
          >
            {t("settings.models.discardChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
