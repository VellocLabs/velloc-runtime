import { CheckIcon, Loader2Icon } from "lucide-react";

import { useT } from "../../../i18n";

/**
 * The API-key field's label row. A stored key is said ONCE, as "Saved ✓" at
 * the end of this row — not again in the placeholder and a hint below. And it
 * says "saved", never "verified": the host only knows the last probe with
 * this key succeeded, and "verified" reads as the vendor vouching for it.
 */
export function ApiKeyLabel({ state, testId }: { state: ApiKeyRowState | null; testId: string }) {
  const t = useT();
  return (
    <span className="flex items-center justify-between gap-2">
      <span className="font-medium">{t("settings.models.apiKey")}</span>
      {state === "saving" ? (
        <span
          className="flex items-center gap-1 text-muted-foreground text-xs"
          data-testid={testId}
          data-state={state}
          role="status"
        >
          {t("settings.models.apiKeySaving")}
          <Loader2Icon className="size-3.5 animate-spin" />
        </span>
      ) : state ? (
        <span
          className="flex items-center gap-1 text-success text-xs"
          data-testid={testId}
          data-state={state}
          role={state === "updated" ? "status" : undefined}
        >
          {t(state === "updated" ? "settings.models.apiKeyUpdated" : "settings.models.apiKeySaved")}
          <CheckIcon className="size-3.5" />
        </span>
      ) : null}
    </span>
  );
}

/**
 * The key row's state: `saving` from the first keystroke of a typed key until
 * its save settles, `updated` once a typed key was stored, `saved` for a key
 * stored before.
 */
export type ApiKeyRowState = "saving" | "updated" | "saved";
