import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { useT } from "../../i18n";

export type DiscoveredModel = {
  id: string;
  selected: boolean;
};

/**
 * "Discover models": fetches the endpoint's list with the CURRENT (possibly unsaved)
 * config and returns the selected ids, marked `incomplete`. A discovery failure is NOT
 * a connection failure — many gateways don't implement `/models`.
 */
export function DiscoverModelsDialog({
  open,
  onOpenChange,
  existingModelIds,
  fetchModels,
  onAddSelected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already-configured model ids (excluded from the list). */
  existingModelIds: string[];
  /** Async fetch — resolves to model id strings, or throws on failure. */
  fetchModels: () => Promise<string[]>;
  onAddSelected: (modelIds: string[]) => void;
}) {
  const t = useT();
  const [models, setModels] = React.useState<DiscoveredModel[]>([]);
  const [search, setSearch] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [notSupported, setNotSupported] = React.useState(false);

  // Fetch on open. `fetchModels` is re-created by the parent on every render,
  // so the effect deliberately keys off `open` alone — listing it would
  // re-probe the endpoint on each keystroke in the connection form.
  const fetchRef = React.useRef(fetchModels);
  fetchRef.current = fetchModels;
  const existingRef = React.useRef(existingModelIds);
  existingRef.current = existingModelIds;

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSearch("");
    setNotSupported(false);
    setModels([]);
    setLoading(true);
    fetchRef
      .current()
      .then((ids) => {
        if (cancelled) return;
        const existing = new Set(existingRef.current);
        const fresh = ids.filter((id) => !existing.has(id));
        // An endpoint that answers with an EMPTY list is indistinguishable
        // from one that doesn't implement discovery — both leave the user
        // adding models by hand, which is what this state says.
        if (ids.length === 0) {
          setNotSupported(true);
        }
        setModels(fresh.map((id) => ({ id, selected: true })));
      })
      .catch(() => {
        if (!cancelled) setNotSupported(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, search]);

  const toggle = (id: string) => {
    setModels((prev) =>
      prev.map((m) => (m.id === id ? { ...m, selected: !m.selected } : m)),
    );
  };

  const selectedIds = models.filter((m) => m.selected).map((m) => m.id);

  const handleAdd = () => {
    onAddSelected(selectedIds);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="discover-models-dialog">
        <DialogHeader>
          <DialogTitle>{t("settings.models.discoverModelsTitle")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          {loading ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              {t("settings.models.loadingCatalog")}
            </p>
          ) : notSupported ? (
            <div className="py-4 text-center" data-testid="discover-unsupported">
              <p className="text-sm">
                {t("settings.models.discoverNotSupported")}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {t("settings.models.discoverManualHint")}
              </p>
            </div>
          ) : (
            <>
              <p className="text-muted-foreground text-xs">
                {t("settings.models.discoverHint")}
              </p>

              <Input
                data-testid="discover-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("settings.models.discoverSearch")}
              />

              <div className="max-h-60 overflow-y-auto rounded-md border">
                {filtered.length === 0 ? (
                  <p className="text-muted-foreground p-3 text-center text-sm">
                    {t("settings.models.noModelsYet")}
                  </p>
                ) : (
                  filtered.map((m) => (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-accent/40"
                    >
                      <input
                        type="checkbox"
                        checked={m.selected}
                        onChange={() => toggle(m.id)}
                        data-testid={`discover-model-${m.id}`}
                        className="size-4 rounded border-input accent-primary"
                      />
                      <span className="font-mono text-xs">{m.id}</span>
                    </label>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("settings.models.cancel")}
          </Button>
          {!notSupported && !loading ? (
            <Button
              size="sm"
              data-testid="discover-add-selected"
              disabled={selectedIds.length === 0}
              onClick={handleAdd}
            >
              {t("settings.models.addSelected")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
