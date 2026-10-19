import { useEffect, useRef, type ReactElement } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentUnit,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

import { searchMatchCount } from "@/components/assistant-ui/codemirror-search-count";
import { baseName } from "@/utils/paths";

/**
 * Lazy CodeMirror 6 file viewer/editor for the right-panel Files view; `readOnly`
 * toggles view/edit, and editing is explicit-save with dirty tracking via `onDirtyChange`.
 * Statically imports the whole `@codemirror/*` stack, so it MUST only be reached through
 * a dynamic `import()` to keep the editor off the boot bundle.
 */

/** Imperative handle FilePanel drives from its header (e.g. the Search button).
 *  Exposed via the `onReady` prop so every `@codemirror` symbol stays inside
 *  this lazily-loaded module — FilePanel imports only this TYPE (erased at
 *  build), never the editor packages. */
export type CodeMirrorApi = {
  /** Open the find panel and focus its input. */
  openSearch: () => void;
  /** Move the cursor to 1-based `line` (clamped to the document) and scroll it
   *  to the vertical center — the landing half of a `path:42` mention. Focuses
   *  the editor so the active-line highlight marks the landing spot. */
  revealLine: (line: number) => void;
  /** Current editor text (for saving). */
  getValue: () => string;
  /** Record `savedText` as the new saved baseline and recompute dirty against
   *  the live doc — so edits made DURING an async save stay dirty rather than
   *  being wrongly marked clean. */
  markSaved: (savedText: string) => void;
  /** Force the doc to `text`, discarding unsaved edits and clearing dirty — the
   *  "reload from disk" action, which deliberately BYPASSES the no-clobber
   *  guard the passive content sync applies. */
  reloadContent: (text: string) => void;
  /** Set the doc to `text` WITHOUT touching the saved baseline — restoring a
   *  stashed unsaved draft, which must come back DIRTY (the baseline is still
   *  what's on disk). The inverse of `reloadContent`. */
  restoreDraft: (text: string) => void;
};

/** Token colors map to the `--syntax-*` variables (defined per-theme in
 *  `globals.css`) so highlighting stays theme-correct without a second JS
 *  theme. Intentionally leaves plain identifiers/operators/punctuation at the
 *  inherited `--foreground` so highlighted code reads calm, not noisy. */
const highlightStyle = HighlightStyle.define([
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "var(--syntax-comment)",
    fontStyle: "italic",
  },
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.moduleKeyword,
      t.definitionKeyword,
      t.modifier,
    ],
    color: "var(--syntax-keyword)",
  },
  {
    tag: [t.self, t.null, t.atom, t.bool],
    color: "var(--syntax-constant)",
  },
  {
    tag: [t.number, t.integer, t.float],
    color: "var(--syntax-number)",
  },
  {
    tag: [t.string, t.special(t.string), t.regexp, t.character, t.attributeValue],
    color: "var(--syntax-string)",
  },
  { tag: [t.escape], color: "var(--syntax-constant)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName],
    color: "var(--syntax-function)",
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.macroName],
    color: "var(--syntax-type)",
  },
  {
    tag: [t.propertyName, t.attributeName],
    color: "var(--syntax-property)",
  },
  {
    tag: [t.constant(t.variableName), t.standard(t.variableName)],
    color: "var(--syntax-constant)",
  },
  { tag: [t.tagName, t.angleBracket], color: "var(--syntax-tag)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--syntax-comment)" },
  { tag: [t.heading], color: "var(--syntax-keyword)", fontWeight: "bold" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--syntax-link)", textDecoration: "underline" },
  { tag: [t.invalid], color: "var(--destructive)" },
]);

/** Editor chrome (background/gutter/selection/search panel/folding). All colors
 *  reference the app's CSS variables so the one theme works in both light and
 *  dark. Mirrors the plain viewer's look: `text-code`, mono font, one code line per row, no
 *  line wrapping so code keeps its formatting and scrolls horizontally. */
const baseTheme = EditorView.theme({
  "&": {
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontSize: "var(--nx-code-size)",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "var(--nx-code-leading)",
    overflow: "auto",
  },
  ".cm-content": { padding: "0.25rem 0" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "color-mix(in oklch, var(--muted-foreground) 60%, transparent)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 0.25rem 0 0.75rem" },
  ".cm-foldGutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 0.25rem",
    // CM's default fold markers (⌄ / ›) render at the tiny code font — scale
    // them up so they're a comfortable click target and clearly visible.
    fontSize: "1.05rem",
    lineHeight: "var(--nx-code-leading)",
    cursor: "pointer",
    color: "color-mix(in oklch, var(--muted-foreground) 70%, transparent)",
  },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--foreground)" },
  // Active line only once the viewer is focused, so an unfocused file doesn't
  // sit with line 1 permanently highlighted.
  "&.cm-focused .cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--muted-foreground) 10%, transparent)",
  },
  "&.cm-focused .cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--muted-foreground) 10%, transparent)",
    color: "var(--foreground)",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--primary) 28%, transparent)",
  },
  // Other occurrences of the current selection (highlightSelectionMatches).
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in oklch, var(--primary) 16%, transparent)",
    borderRadius: "2px",
  },
  // Find-panel matches.
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklch, var(--syntax-number) 28%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklch, var(--syntax-keyword) 42%, transparent)",
  },
  // The search panel itself — themed to the app's card/border tokens and sized
  // up from CM's cramped defaults. The panel is laid out as a single centered
  // flex row (CM's default per-child margins are reset in favor of a uniform
  // gap) so the fields, buttons and checkbox labels all align on one baseline.
  ".cm-panels": {
    backgroundColor: "var(--card)",
    color: "var(--foreground)",
    border: "none",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "1px solid var(--border)",
  },
  ".cm-panel.cm-search": {
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.375rem",
    // Right padding reserves room for the absolutely-positioned close button.
    padding: "0.5rem 2.5rem 0.5rem 0.625rem",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--nx-caption-size)",
  },
  // Reset CM's default `.2em .6em` margins — the flex `gap` spaces everything.
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label":
    {
      margin: "0",
    },
  ".cm-panel.cm-search .cm-textfield": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "0.375rem",
    padding: "0.25rem 0.5rem",
    fontSize: "var(--nx-caption-size)",
    minHeight: "1.75rem",
    minWidth: "12rem",
  },
  // Match counter (`3/17`), injected right after the search field by
  // `searchMatchCount()`. Tabular figures + a min width so the panel's controls
  // don't jitter sideways as the numbers change while typing.
  ".cm-panel.cm-search .cm-search-count": {
    minWidth: "3.5rem",
    fontVariantNumeric: "tabular-nums",
    fontSize: "var(--nx-caption-size)",
    color: "var(--muted-foreground)",
    whiteSpace: "nowrap",
    userSelect: "none",
  },
  ".cm-panel.cm-search .cm-button": {
    backgroundColor: "var(--background)",
    backgroundImage: "none",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "0.375rem",
    padding: "0.25rem 0.625rem",
    fontSize: "var(--nx-caption-size)",
    minHeight: "1.75rem",
    textTransform: "none",
    cursor: "pointer",
  },
  ".cm-panel.cm-search .cm-button:hover": {
    backgroundColor: "var(--muted)",
  },
  // Checkbox + label: inline-flex so the box is vertically centered with its
  // text (CM's default baseline-aligns them, which reads as misaligned).
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "var(--nx-caption-size)",
    whiteSpace: "nowrap",
    color: "var(--muted-foreground)",
  },
  ".cm-panel.cm-search label input[type=checkbox]": {
    margin: "0",
    accentColor: "var(--primary)",
    cursor: "pointer",
  },
  // Close button (a bare `×` by default) → a proper centered, hit-area'd icon
  // button pinned to the panel's right edge.
  ".cm-panel.cm-search [name=close]": {
    position: "absolute",
    top: "50%",
    right: "0.5rem",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.5rem",
    height: "1.5rem",
    padding: "0",
    margin: "0",
    border: "none",
    borderRadius: "0.375rem",
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    fontSize: "1.125rem",
    lineHeight: "1",
    cursor: "pointer",
  },
  ".cm-panel.cm-search [name=close]:hover": {
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
  },
});

/** Shared editor extensions (search / fold / matching / history / nav). Work in
 *  both modes: `history()` records nothing while read-only, and the editing
 *  keymaps are inert until `editable` is on (toggled via the compartment). */
const editorTools = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  foldGutter(),
  codeFolding(),
  drawSelection(),
  bracketMatching(),
  highlightSelectionMatches(),
  history(),
  search({ top: true }),
  // `current/total` readout inside the find panel — CM ships no match counter.
  searchMatchCount(),
  syntaxHighlighting(highlightStyle),
  keymap.of([
    ...searchKeymap,
    ...foldKeymap,
    ...historyKeymap,
    indentWithTab,
    ...defaultKeymap,
  ]),
];

export type CodeMirrorViewProps = {
  content: string;
  /** File path/name — used only to pick the language grammar by extension. */
  filename?: string;
  /** Read-only viewer when true; editable when false (host locks during turns). */
  readOnly?: boolean;
  /** Called with an imperative handle once the editor mounts (and `null` when it
   *  unmounts) so the host can drive it — Search button, save, dirty baseline. */
  onReady?: (api: CodeMirrorApi | null) => void;
  /** Fired when the doc diverges from / returns to the saved baseline. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Save request from within the editor (⌘/Ctrl+S). The host performs the
   *  actual write and then calls `api.markSaved()`. */
  onSave?: () => void;
  /**
   * Fired from THIS component's unmount cleanup when the doc still differs
   * from the saved baseline — the last moment the unsaved text exists. The
   * editor reports it itself (rather than the host asking) because unmount
   * cleanups run child-first: by the time the host's own cleanup runs, the
   * view is already destroyed.
   */
  onUnmountWhileDirty?: (draft: { text: string; baseline: string }) => void;
  /** Soft-wrap long lines (default off). */
  wordWrap?: boolean;
  /** Columns a tab shows as and one indent level inserts (default 4). */
  tabSize?: number;
};

function layoutExtensions(wordWrap: boolean, tabSize: number) {
  return [
    EditorState.tabSize.of(tabSize),
    indentUnit.of(" ".repeat(tabSize)),
    wordWrap ? EditorView.lineWrapping : [],
  ];
}

export default function CodeMirrorView({
  content,
  filename,
  readOnly = true,
  onReady,
  onDirtyChange,
  onSave,
  onUnmountWhileDirty,
  wordWrap = false,
  tabSize = 4,
}: CodeMirrorViewProps): ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onUnmountWhileDirtyRef = useRef(onUnmountWhileDirty);
  onUnmountWhileDirtyRef.current = onUnmountWhileDirty;
  // Saved baseline + last-reported dirty state, for change tracking.
  const baselineRef = useRef(content);
  const dirtyRef = useRef(false);
  // Compartments (reconfigurable without rebuilding state, so the doc + undo
  // history survive): the async language grammar, editability — toggled
  // when the host locks editing while a turn runs — and wrap / tab size.
  const languageComp = useRef(new Compartment());
  const editableComp = useRef(new Compartment());
  const layoutComp = useRef(new Compartment());

  // Create the editor once. Content/language/editability are applied by the
  // effects below so switching files reuses this instance (and its chunk).
  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: content,
        extensions: [
          ...editorTools,
          editableComp.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          // ⌘/Ctrl+S → save request. Always returns true to swallow the browser
          // "save page" dialog; the host decides whether a write happens (no-op
          // when the doc is clean or editing is locked).
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
          ]),
          // Track dirty against the saved baseline; notify only on transitions.
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const doc = update.state.doc;
            const base = baselineRef.current;
            const dirty = doc.length !== base.length || doc.toString() !== base;
            if (dirty !== dirtyRef.current) {
              dirtyRef.current = dirty;
              onDirtyChangeRef.current?.(dirty);
            }
          }),
          baseTheme,
          languageComp.current.of([]),
          layoutComp.current.of(layoutExtensions(wordWrap, tabSize)),
        ],
      }),
    });
    viewRef.current = view;
    onReadyRef.current?.({
      openSearch: () => {
        view.focus();
        openSearchPanel(view);
      },
      revealLine: (line: number) => {
        const doc = view.state.doc;
        const clamped = Math.max(1, Math.min(line, doc.lines));
        const pos = doc.line(clamped).from;
        view.focus();
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "center" }),
        });
      },
      getValue: () => view.state.doc.toString(),
      markSaved: (savedText: string) => {
        baselineRef.current = savedText;
        const doc = view.state.doc;
        const dirty =
          doc.length !== savedText.length || doc.toString() !== savedText;
        if (dirty !== dirtyRef.current) {
          dirtyRef.current = dirty;
          onDirtyChangeRef.current?.(dirty);
        }
      },
      reloadContent: (text: string) => {
        const current = view.state.doc.toString();
        baselineRef.current = text;
        if (current !== text) {
          view.dispatch({
            changes: { from: 0, to: current.length, insert: text },
          });
        }
        if (dirtyRef.current) {
          dirtyRef.current = false;
          onDirtyChangeRef.current?.(false);
        }
      },
      restoreDraft: (text: string) => {
        // Baseline untouched: the update listener sees doc != baseline and
        // reports dirty, which is the point — restored edits are still unsaved.
        const current = view.state.doc.toString();
        if (current !== text) {
          view.dispatch({
            changes: { from: 0, to: current.length, insert: text },
          });
        }
      },
    });
    return () => {
      // Last chance to save the user's typing from a released/unmounted body:
      // hand the dirty doc (and its disk baseline, for conflict detection on
      // restore) to the host before the view is destroyed.
      if (dirtyRef.current) {
        onUnmountWhileDirtyRef.current?.({
          text: view.state.doc.toString(),
          baseline: baselineRef.current,
        });
      }
      onReadyRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // Create-once: props are seeded here and kept in sync by the effects below
    // (the standard CodeMirror-in-React pattern).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle editability in place (host lock/unlock) without dropping the doc or
  // undo history.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableComp.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: layoutComp.current.reconfigure(layoutExtensions(wordWrap, tabSize)),
    });
  }, [wordWrap, tabSize]);

  // Reflect an external content change (fresh load / re-read) into the doc — but
  // NEVER clobber unsaved edits. Adopted content becomes the new saved baseline
  // so the view reads clean against what's on disk.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (content === baselineRef.current) return; // already in sync
    if (dirtyRef.current) return; // unsaved edits — keep them
    const current = view.state.doc.toString();
    baselineRef.current = content;
    if (current !== content) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: content },
      });
    }
  }, [content]);

  // Resolve + apply the language grammar for this filename (async, code-split).
  useEffect(() => {
    let cancelled = false;
    const desc = filename
      ? LanguageDescription.matchFilename(languages, baseName(filename))
      : null;
    if (!desc) {
      viewRef.current?.dispatch({
        effects: languageComp.current.reconfigure([]),
      });
      return;
    }
    void desc
      .load()
      .then((support) => {
        if (cancelled) return;
        viewRef.current?.dispatch({
          effects: languageComp.current.reconfigure(support),
        });
      })
      .catch(() => {
        // Unknown/failed grammar → stay plain (still line-numbered + themed).
      });
    return () => {
      cancelled = true;
    };
  }, [filename]);

  return (
    <div
      ref={parentRef}
      data-testid="code-mirror-view"
      className="aui-cm-host h-full overflow-hidden rounded-md border bg-muted/30"
    />
  );
}
