import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import {
  getSearchQuery,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";

/**
 * Match counter (`3/17`) injected into CodeMirror's stock find panel. Only loaded
 * through `CodeMirrorView`, so it stays off the boot bundle.
 */

/**
 * Stop scanning after this many matches. A pathological query on a large file
 * (a single letter in a minified bundle) would otherwise walk the whole
 * document on every keystroke. Reaching the cap shows `17/10000+` rather than a
 * wrong number.
 */
export const SEARCH_MATCH_SCAN_CAP = 10_000;

/**
 * Don't count at all past this document size. The match cap above bounds
 * MATCH-heavy scans, but a query with FEW hits in a huge file still walks the
 * whole document — and the scan re-runs on every keystroke and cursor move
 * while the panel is open. Past this size the counter simply doesn't render
 * (the panel falls back to stock CodeMirror), which is honest: better no
 * number than a number that costs a frame per keypress.
 */
export const SEARCH_COUNT_MAX_DOC_LENGTH = 2_000_000;

export type SearchMatchCount = {
  /** Matches found, up to `SEARCH_MATCH_SCAN_CAP`. */
  total: number;
  /** 1-based index of the selected match; 0 when the selection is not on one. */
  current: number;
  /** The scan stopped at the cap, so `total` is a lower bound. */
  capped: boolean;
};

export const EMPTY_SEARCH_MATCH_COUNT: SearchMatchCount = {
  total: 0,
  current: 0,
  capped: false,
};

/**
 * Count the current query's matches and locate the selected one; `current` is derived
 * from the selection, which is how CodeMirror marks the match you are on. Returns null
 * when the document is too large to count ({@link SEARCH_COUNT_MAX_DOC_LENGTH}).
 */
export function countSearchMatches(
  state: EditorState,
  cap: number = SEARCH_MATCH_SCAN_CAP,
  maxDocLength: number = SEARCH_COUNT_MAX_DOC_LENGTH,
): SearchMatchCount | null {
  if (state.doc.length > maxDocLength) return null;
  const query = getSearchQuery(state);
  if (!query.valid) return EMPTY_SEARCH_MATCH_COUNT;

  const selection = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  let capped = false;
  for (;;) {
    const next = cursor.next();
    if (next.done) break;
    total += 1;
    if (
      current === 0 &&
      next.value.from === selection.from &&
      next.value.to === selection.to
    ) {
      current = total;
    }
    if (total >= cap) {
      capped = true;
      break;
    }
  }
  return { total, current, capped };
}

/**
 * `current/total` — deliberately numeric-only so it needs no translation and
 * stays readable at the panel's 12px font. `0/17` (nothing selected yet, right
 * after the panel opens) and `0/0` (no matches) are both honest readings of the
 * same format. An empty/invalid query renders nothing at all.
 */
export function formatSearchMatchCount(count: SearchMatchCount | null): string {
  if (!count) return "";
  const total = count.capped ? `${count.total}+` : `${count.total}`;
  return `${count.current}/${total}`;
}

const COUNT_CLASS = "cm-search-count";

/** Place the counter directly after the search field, or at the end if CM ever
 *  changes the panel's shape. */
function attachCounter(panel: HTMLElement): HTMLElement {
  const element = document.createElement("span");
  element.className = COUNT_CLASS;
  element.setAttribute("data-testid", "cm-search-count");
  // Announce the running count to screen readers as the user types, without
  // stealing focus from the input.
  element.setAttribute("aria-live", "polite");
  const input = panel.querySelector<HTMLElement>("input[name=search]");
  if (input?.parentElement) input.insertAdjacentElement("afterend", element);
  else panel.append(element);
  return element;
}

class SearchMatchCountPlugin implements PluginValue {
  private element: HTMLElement | null = null;

  constructor(private readonly view: EditorView) {
    this.sync();
  }

  update(update: ViewUpdate): void {
    const queryChanged = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(setSearchQuery)),
    );
    // The panel is created/destroyed outside our update cycle, so also re-sync
    // whenever our element has been detached with it.
    if (
      update.docChanged ||
      update.selectionSet ||
      queryChanged ||
      this.element?.isConnected !== true
    ) {
      this.sync();
    }
  }

  destroy(): void {
    this.element?.remove();
    this.element = null;
  }

  private sync(): void {
    const panel = searchPanelOpen(this.view.state)
      ? this.view.dom.querySelector<HTMLElement>(".cm-panel.cm-search")
      : null;
    if (!panel) {
      // Panel closed — drop the node rather than leaving a stale count behind.
      this.element?.remove();
      this.element = null;
      return;
    }
    if (!this.element?.isConnected) this.element = attachCounter(panel);
    const query = getSearchQuery(this.view.state);
    this.element.textContent = query.valid
      ? formatSearchMatchCount(countSearchMatches(this.view.state))
      : "";
  }
}

/** Extension: keeps a `current/total` readout in the find panel while it's open. */
export function searchMatchCount(): Extension {
  return ViewPlugin.fromClass(SearchMatchCountPlugin);
}
