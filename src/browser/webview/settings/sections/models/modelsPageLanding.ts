/**
 * Where the Models page lands when a router's settings app asked for it
 * (F-27, `$.provider.openSettings`).
 * Contract: navigation alone. A landing opens an editor, the add menu, the
 * custom provider form or the list; it never adds or changes a provider, so
 * it opens editors directly and never through the add shortcut that sets a
 * keyless provider up.
 */
import * as React from "react";

import type { ModelsSettingsTarget } from "../../../../runtimeProtocol/modContributions";

/** One ask; `seq` changes with each, so the same target asked twice lands twice. */
export type ModelsLandingRequest = { target: ModelsSettingsTarget; seq: number };

export type ModelsLanding = { go: "edit"; id: string } | { go: "menu" } | { go: "custom" } | { go: "home" };

/**
 * What the page lists: the ids of its provider rows, of the providers its add
 * menu offers, and of the routers among them.
 */
export type ModelsPageLists = { added: readonly string[]; addable: readonly string[]; routers: readonly string[] };

/**
 * A provider the page has no row for lands on the list; a definition it can
 * neither show nor add lands on the add menu. A router is set up in its own
 * settings app, so it is never landed on.
 */
export function modelsLandingFor(target: ModelsSettingsTarget, lists: ModelsPageLists): ModelsLanding {
  const editable = (id: string, among: readonly string[]) => among.includes(id) && !lists.routers.includes(id);
  if (target.kind === "provider") return editable(target.provider, lists.added) ? { go: "edit", id: target.provider } : { go: "home" };
  if (target.kind === "definition") {
    return editable(target.definition, lists.added) || editable(target.definition, lists.addable)
      ? { go: "edit", id: target.definition }
      : { go: "menu" };
  }
  if (target.kind === "addMenu") return { go: "menu" };
  return target.kind === "custom" ? { go: "custom" } : { go: "home" };
}

export type ModelsLandingActions = {
  edit: (id: string) => void;
  menu: () => void;
  custom: () => void;
  home: () => void;
};

/**
 * Carries each request out once, as soon as the page's lists are loaded.
 * `actions` is read when the landing happens; null while the page cannot act.
 * A request that arrives while the open editor holds unsaved edits is
 * dropped: the page stays where the person is.
 */
export function useModelsLanding(
  request: ModelsLandingRequest | null | undefined,
  ready: boolean,
  lists: ModelsPageLists,
  actions: React.RefObject<ModelsLandingActions | null>,
  unsavedEdits: boolean,
): void {
  const handled = React.useRef<number | null>(null);
  const latest = React.useRef({ lists, unsavedEdits });
  latest.current = { lists, unsavedEdits };
  React.useEffect(() => {
    const act = actions.current;
    if (!request || !ready || !act || handled.current === request.seq) return;
    handled.current = request.seq;
    if (latest.current.unsavedEdits) return;
    const landing = modelsLandingFor(request.target, latest.current.lists);
    if (landing.go === "edit") act.edit(landing.id);
    else act[landing.go]();
  }, [request, ready, actions]);
}
