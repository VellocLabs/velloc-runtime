// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// Hoisted spies + a tiny model of the editor's imperative surface, so the
// FilePanel save/dirty/lock wiring can be exercised without a real editor.
const { mockOpenSearch, mockMarkSaved, mockReload, mockRevealLine, mockRestoreDraft, cm } = vi.hoisted(() => ({
  mockOpenSearch: vi.fn(),
  mockMarkSaved: vi.fn(),
  mockReload: vi.fn(),
  mockRevealLine: vi.fn(),
  mockRestoreDraft: vi.fn(),
  cm: {
    value: "",
    lastContent: undefined as string | undefined,
    readOnly: undefined as boolean | undefined,
    dirty: false,
    onDirtyChange: undefined as ((dirty: boolean) => void) | undefined,
    onSave: undefined as (() => void) | undefined,
    onUnmountWhileDirty: undefined as
      | ((draft: { text: string; baseline: string }) => void)
      | undefined,
  },
}));

// Stub the lazy CodeMirror editor and the markdown renderer so the test
// exercises FilePanel's BRANCHING + editing wiring without the real @codemirror
// stack (needs layout APIs happy-dom lacks) or react-markdown/mermaid. The
// editor stub mirrors the real onReady/getValue/markSaved/onDirtyChange
// contract: it seeds its value from `content` only when `content` changes, so a
// test-driven edit survives re-renders (as the real doc would).
vi.mock("@/components/assistant-ui/CodeMirrorView", () => ({
  default: (props: {
    content: string;
    filename?: string;
    readOnly?: boolean;
    onReady?: (api: {
      openSearch: () => void;
      revealLine: (line: number) => void;
      getValue: () => string;
      markSaved: (savedText: string) => void;
      reloadContent: (text: string) => void;
      restoreDraft: (text: string) => void;
    }) => void;
    onDirtyChange?: (dirty: boolean) => void;
    onSave?: () => void;
    onUnmountWhileDirty?: (draft: { text: string; baseline: string }) => void;
  }) => {
    if (cm.lastContent !== props.content) {
      cm.value = props.content;
      cm.lastContent = props.content;
    }
    cm.readOnly = props.readOnly;
    cm.onDirtyChange = props.onDirtyChange;
    cm.onSave = props.onSave;
    cm.onUnmountWhileDirty = props.onUnmountWhileDirty;
    // Mirror the real editor's unmount contract: hand the dirty doc out at
    // destroy time (the parent's own cleanup runs after the view is gone).
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(
      () => () => {
        if (cm.dirty) {
          cm.onUnmountWhileDirty?.({
            text: cm.value,
            baseline: cm.lastContent ?? "",
          });
        }
      },
      [],
    );
    props.onReady?.({
      openSearch: mockOpenSearch,
      revealLine: mockRevealLine,
      getValue: () => cm.value,
      markSaved: (savedText: string) => {
        mockMarkSaved(savedText);
        cm.value = savedText;
        cm.dirty = false;
        cm.onDirtyChange?.(false);
      },
      reloadContent: (text: string) => {
        mockReload(text);
        cm.value = text;
        cm.lastContent = text;
        cm.dirty = false;
        cm.onDirtyChange?.(false);
      },
      restoreDraft: (text: string) => {
        mockRestoreDraft(text);
        cm.value = text;
        cm.dirty = true;
        cm.onDirtyChange?.(true);
      },
    });
    return createElement(
      "div",
      { "data-testid": "cm-view", "data-readonly": String(props.readOnly) },
      props.filename ?? "",
    );
  },
}));
vi.mock("@/components/assistant-ui/static-markdown", () => ({
  StaticMarkdown: ({ content }: { content: string }) =>
    createElement("div", { "data-testid": "static-md" }, content),
}));

import {
  FilePanel,
  __resetUnsavedFileDraftsForTests,
} from "../browser/webview/FilePanel";
import { I18nProvider } from "../browser/webview/i18n";

afterEach(() => {
  cleanup();
  __resetUnsavedFileDraftsForTests();
  mockOpenSearch.mockClear();
  mockMarkSaved.mockClear();
  mockReload.mockClear();
  mockRevealLine.mockClear();
  mockRestoreDraft.mockClear();
  cm.value = "";
  cm.dirty = false;
  cm.onUnmountWhileDirty = undefined;
  cm.lastContent = undefined;
  cm.readOnly = undefined;
  cm.onDirtyChange = undefined;
  cm.onSave = undefined;
});

/** Drive the editor stub as if the user typed — set the live value and flip
 *  dirty, exactly like the real editor's update listener would. */
function simulateEdit(value: string) {
  act(() => {
    cm.value = value;
    cm.dirty = true;
    cm.onDirtyChange?.(true);
  });
}

const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

// The right panel bounds how many tab bodies stay mounted, and an unsaved edit
// lives ONLY in the mounted editor's doc — so the panel exempts a dirty file
// view from eviction based on what FilePanel reports here. If this contract
// breaks, unsaved typing gets silently released with the body.
describe("FilePanel — unsaved-edit reporting", () => {
  it("reports dirty by path, and reports clean again on save", async () => {
    const onDirtyChange = vi.fn();
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText: vi.fn(async () => "const x = 1\n"),
        writeFileText: vi.fn(async () => true),
        onDirtyChange,
      }),
    );
    await screen.findByTestId("cm-view");
    expect(onDirtyChange).toHaveBeenLastCalledWith("/repo/foo.ts", false);

    simulateEdit("const x = 2\n");
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith("/repo/foo.ts", true),
    );

    act(() => {
      cm.onDirtyChange?.(false);
    });
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith("/repo/foo.ts", false),
    );
  });

  it("reports clean on unmount, so the flag can't outlive the editor", async () => {
    const onDirtyChange = vi.fn();
    const { unmount } = render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText: vi.fn(async () => "const x = 1\n"),
        writeFileText: vi.fn(async () => true),
        onDirtyChange,
      }),
    );
    await screen.findByTestId("cm-view");
    simulateEdit("edited\n");
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith("/repo/foo.ts", true),
    );

    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith("/repo/foo.ts", false);
  });
});

// A `path:42` transcript mention opens the file AND lands on the line. The
// reveal can arrive before the (lazy, async) editor exists, and clicking the
// same `path:42` again must re-center — hence the nonce edge-trigger.
describe("FilePanel — line reveal", () => {
  it("reveals the requested line once the editor is ready", async () => {
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText: vi.fn(async () => "const x = 1\n"),
        reveal: { line: 42, nonce: 1 },
      }),
    );
    await screen.findByTestId("cm-view");
    await waitFor(() => expect(mockRevealLine).toHaveBeenCalledWith(42));
  });

  it("re-reveals when the nonce bumps, even for the same line", async () => {
    const props = {
      target: { path: "/repo/foo.ts" },
      readFileText: vi.fn(async () => "const x = 1\n"),
    };
    const { rerender } = render(
      createElement(FilePanel, { ...props, reveal: { line: 7, nonce: 1 } }),
    );
    await screen.findByTestId("cm-view");
    await waitFor(() => expect(mockRevealLine).toHaveBeenCalledTimes(1));

    // Same line, new click → new nonce → jump again.
    rerender(
      createElement(FilePanel, { ...props, reveal: { line: 7, nonce: 2 } }),
    );
    await waitFor(() => expect(mockRevealLine).toHaveBeenCalledTimes(2));

    // A re-render with the SAME nonce (parent re-rendered for other reasons,
    // the object identity changed) must NOT jump again.
    rerender(
      createElement(FilePanel, { ...props, reveal: { line: 7, nonce: 2 } }),
    );
    await screen.findByTestId("cm-view");
    expect(mockRevealLine).toHaveBeenCalledTimes(2);
  });
});

// An unsaved draft must survive its editor being unmounted — a session switch
// resets the whole tab-body cache (the one path the dirty-view protection
// can't cover), and closing a tab does it directly. The editor hands its doc
// out at destroy time; the next mount of the same path restores it DIRTY.
describe("FilePanel — unsaved drafts survive unmount", () => {
  it("restores the draft (still dirty) when the same path remounts", async () => {
    const readFileText = vi.fn(async () => "const x = 1\n");
    const first = render(
      createElement(FilePanel, {
        target: { path: "/repo/draft.ts" },
        readFileText,
        writeFileText: vi.fn(async () => true),
      }),
    );
    await screen.findByTestId("cm-view");
    simulateEdit("const x = 2 // WIP\n");
    first.unmount();

    const onDirtyChange = vi.fn();
    render(
      createElement(FilePanel, {
        target: { path: "/repo/draft.ts" },
        readFileText,
        writeFileText: vi.fn(async () => true),
        onDirtyChange,
      }),
    );
    await screen.findByTestId("cm-view");
    await waitFor(() =>
      expect(mockRestoreDraft).toHaveBeenCalledWith("const x = 2 // WIP\n"),
    );
    // Restored DIRTY — the draft is still unsaved against disk…
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith("/repo/draft.ts", true),
    );
    // …and same-disk restore raises NO conflict banner.
    expect(screen.queryByTestId("file-panel-conflict")).toBeNull();
  });

  it("raises the conflict banner when the disk moved while the draft was parked", async () => {
    const first = render(
      createElement(FilePanel, {
        target: { path: "/repo/conflict.ts" },
        readFileText: vi.fn(async () => "original\n"),
        writeFileText: vi.fn(async () => true),
      }),
    );
    await screen.findByTestId("cm-view");
    simulateEdit("original + my edit\n");
    first.unmount();

    // The agent wrote the file while the draft was parked.
    render(
      createElement(FilePanel, {
        target: { path: "/repo/conflict.ts" },
        readFileText: vi.fn(async () => "agent rewrote this\n"),
        writeFileText: vi.fn(async () => true),
      }),
    );
    await screen.findByTestId("cm-view");
    await waitFor(() =>
      expect(mockRestoreDraft).toHaveBeenCalledWith("original + my edit\n"),
    );
    // The draft holds the doc; the fresh disk copy is one click away.
    await screen.findByTestId("file-panel-conflict");
  });

  it("a draft is consumed once — a clean remount after restore stays clean", async () => {
    const readFileText = vi.fn(async () => "const x = 1\n");
    const first = render(
      createElement(FilePanel, {
        target: { path: "/repo/once.ts" },
        readFileText,
        writeFileText: vi.fn(async () => true),
      }),
    );
    await screen.findByTestId("cm-view");
    simulateEdit("wip\n");
    first.unmount();

    // Restore + user discards via reload (clears dirty)…
    const second = render(
      createElement(FilePanel, {
        target: { path: "/repo/once.ts" },
        readFileText,
        writeFileText: vi.fn(async () => true),
      }),
    );
    await screen.findByTestId("cm-view");
    await waitFor(() => expect(mockRestoreDraft).toHaveBeenCalledTimes(1));
    act(() => {
      cm.dirty = false;
      cm.onDirtyChange?.(false);
    });
    second.unmount();

    // …so the next mount has nothing to restore.
    render(
      createElement(FilePanel, {
        target: { path: "/repo/once.ts" },
        readFileText,
        writeFileText: vi.fn(async () => true),
      }),
    );
    await screen.findByTestId("cm-view");
    expect(mockRestoreDraft).toHaveBeenCalledTimes(1);
  });
});

describe("FilePanel", () => {
  it("prompts to open a file when no path is set", () => {
    render(createElement(FilePanel, { target: null }));
    expect(screen.getByText(/No file open/)).toBeTruthy();
  });

  it("takes the empty-state text from the locale catalog, not a hard-coded literal", () => {
    // Rendered under the German catalog the empty state must be German — this
    // fails if the string is an English literal at the call site.
    render(
      createElement(
        I18nProvider,
        { locale: "de" },
        createElement(FilePanel, { target: null }),
      ),
    );
    expect(screen.getByText(/Keine Datei geöffnet/)).toBeTruthy();
    expect(screen.queryByText(/No file open/)).toBeNull();
  });

  it("renders a code file through the lazy CodeMirror viewer", async () => {
    const readFileText = vi.fn(async () => "const x = 1\n");
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
      }),
    );
    const view = await screen.findByTestId("cm-view");
    expect(view.textContent).toBe("/repo/foo.ts");
    expect(readFileText).toHaveBeenCalledWith("/repo/foo.ts");
    expect(screen.queryByTestId("static-md")).toBeNull();
    expect(
      document.querySelector('[data-slot="file-panel-view-toggle"]'),
    ).toBeNull();
  });

  it("keeps the header copy button always visible (not hover-revealed)", async () => {
    const readFileText = vi.fn(async () => "const x = 1\n");
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
      }),
    );
    await screen.findByTestId("cm-view");
    const copyBtn = document.querySelector(
      '[data-slot="file-copy-button"]',
    ) as HTMLElement;
    expect(copyBtn).toBeTruthy();
    expect(copyBtn.className).not.toContain("opacity-0");
  });

  it("opens the editor's find panel from the header Search button", async () => {
    const readFileText = vi.fn(async () => "const x = 1\n");
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
      }),
    );
    const searchBtn = await screen.findByTestId("file-panel-search");
    fireEvent.click(searchBtn);
    expect(mockOpenSearch).toHaveBeenCalledTimes(1);
  });

  it("shows a read-only viewer with NO Save button when the host has no writer", async () => {
    const readFileText = vi.fn(async () => "const x = 1\n");
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
      }),
    );
    const view = await screen.findByTestId("cm-view");
    expect(view.getAttribute("data-readonly")).toBe("true");
    expect(screen.queryByTestId("file-panel-save")).toBeNull();
  });

  it("offers editing + explicit save for a code file when a writer is present", async () => {
    const readFileText = vi.fn(async () => "const x = 1\n");
    const writeFileText = vi.fn(async () => true);
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
        writeFileText,
      }),
    );
    const view = await screen.findByTestId("cm-view");
    expect(view.getAttribute("data-readonly")).toBe("false");
    // Save is present but disabled while clean.
    const save = screen.getByTestId("file-panel-save");
    expect(isDisabled(save)).toBe(true);
    expect(screen.queryByTestId("file-panel-dirty")).toBeNull();

    // Edit → Save enables, dirty dot appears.
    simulateEdit("const x = 2\n");
    expect(isDisabled(save)).toBe(false);
    expect(screen.getByTestId("file-panel-dirty")).toBeTruthy();

    // Save writes the current text, rebaselines, and clears dirty.
    fireEvent.click(save);
    await waitFor(() =>
      expect(writeFileText).toHaveBeenCalledWith("/repo/foo.ts", "const x = 2\n"),
    );
    expect(mockMarkSaved).toHaveBeenCalledWith("const x = 2\n");
    await waitFor(() =>
      expect(screen.queryByTestId("file-panel-dirty")).toBeNull(),
    );
  });

  it("saves on ⌘/Ctrl+S from within the editor", async () => {
    const readFileText = vi.fn(async () => "a\n");
    const writeFileText = vi.fn(async () => true);
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
        writeFileText,
      }),
    );
    await screen.findByTestId("cm-view");
    simulateEdit("a-edited\n");
    await act(async () => {
      cm.onSave?.();
    });
    await waitFor(() =>
      expect(writeFileText).toHaveBeenCalledWith("/repo/foo.ts", "a-edited\n"),
    );
  });

  it("locks the editor read-only and disables Save while a turn is running", async () => {
    const readFileText = vi.fn(async () => "const x = 1\n");
    const writeFileText = vi.fn(async () => true);
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
        writeFileText,
        editingLocked: true,
      }),
    );
    const view = await screen.findByTestId("cm-view");
    expect(view.getAttribute("data-readonly")).toBe("true");
    const save = screen.getByTestId("file-panel-save");
    expect(isDisabled(save)).toBe(true);
    // Even with unsaved changes, a locked turn keeps Save disabled and never writes.
    simulateEdit("const x = 2\n");
    expect(isDisabled(save)).toBe(true);
    fireEvent.click(save);
    expect(writeFileText).not.toHaveBeenCalled();
  });

  it("surfaces a save error and keeps the edits dirty", async () => {
    const readFileText = vi.fn(async () => "a\n");
    const writeFileText = vi.fn(async () => {
      throw new Error("disk full");
    });
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
        writeFileText,
      }),
    );
    await screen.findByTestId("cm-view");
    simulateEdit("a-edited\n");
    fireEvent.click(screen.getByTestId("file-panel-save"));
    await waitFor(() =>
      expect(screen.getByTestId("file-panel-save-error").textContent).toContain(
        "disk full",
      ),
    );
    // Still dirty (nothing was persisted).
    expect(screen.getByTestId("file-panel-dirty")).toBeTruthy();
    expect(mockMarkSaved).not.toHaveBeenCalled();
  });

  it("silently refreshes a CLEAN file after a turn writes it on disk", async () => {
    const readFileText = vi
      .fn()
      .mockResolvedValueOnce("v1\n")
      .mockResolvedValue("v2\n");
    const writeFileText = vi.fn(async () => true);
    const props = (locked: boolean) => ({
      target: { path: "/repo/foo.ts" },
      readFileText,
      writeFileText,
      editingLocked: locked,
    });
    // Mount mid-turn (locked); the initial load reads v1.
    const { rerender } = render(createElement(FilePanel, props(true)));
    await screen.findByTestId("cm-view");
    await waitFor(() => expect(cm.value).toBe("v1\n"));
    // Turn ends → re-read → v2. No unsaved edits, so it adopts silently.
    rerender(createElement(FilePanel, props(false)));
    await waitFor(() => expect(cm.value).toBe("v2\n"));
    expect(screen.queryByTestId("file-panel-conflict")).toBeNull();
  });

  it("manual Refresh re-reads a clean file and adopts the on-disk copy", async () => {
    // The turn-end auto-refresh only fires on the active session's lock→unlock;
    // a file changed out of band (background task / sub-agent) never cycles it.
    // The header Refresh button re-reads on demand — no lock transition here.
    const readFileText = vi
      .fn()
      .mockResolvedValueOnce("v1\n")
      .mockResolvedValue("v2\n");
    const writeFileText = vi.fn(async () => true);
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
        writeFileText,
      }),
    );
    await screen.findByTestId("cm-view");
    await waitFor(() => expect(cm.value).toBe("v1\n"));
    fireEvent.click(screen.getByTestId("file-panel-refresh"));
    await waitFor(() => expect(cm.value).toBe("v2\n"));
    expect(screen.queryByTestId("file-panel-conflict")).toBeNull();
  });

  it("a null re-read (no client) keeps the content instead of blanking it", async () => {
    // `null` means nothing could read — not an emptied file. Adopting "" would
    // blank a clean editor, and the next save would truncate the file on disk.
    const readFileText = vi
      .fn()
      .mockResolvedValueOnce("v1\n")
      .mockResolvedValue(null);
    const writeFileText = vi.fn(async () => true);
    const props = (locked: boolean) => ({
      target: { path: "/repo/foo.ts" },
      readFileText,
      writeFileText,
      editingLocked: locked,
    });
    const { rerender } = render(createElement(FilePanel, props(false)));
    await screen.findByTestId("cm-view");
    await waitFor(() => expect(cm.value).toBe("v1\n"));
    fireEvent.click(screen.getByTestId("file-panel-refresh"));
    await waitFor(() => expect(readFileText).toHaveBeenCalledTimes(2));
    // Turn-end re-read takes the same path.
    rerender(createElement(FilePanel, props(true)));
    rerender(createElement(FilePanel, props(false)));
    await waitFor(() => expect(readFileText).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cm.value).toBe("v1\n");
    expect(screen.queryByTestId("file-panel-conflict")).toBeNull();
  });

  it("a null initial read shows the unavailable error, not an empty editor", async () => {
    const readFileText = vi.fn(async () => null);
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
        writeFileText: vi.fn(async () => true),
      }),
    );
    await waitFor(() => expect(readFileText).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("cm-view")).toBeNull();
  });

  it("manual Refresh raises a conflict when there are unsaved edits and disk moved", async () => {
    const readFileText = vi
      .fn()
      .mockResolvedValueOnce("v1\n")
      .mockResolvedValue("v2-agent\n");
    const writeFileText = vi.fn(async () => true);
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
        writeFileText,
      }),
    );
    await screen.findByTestId("cm-view");
    await waitFor(() => expect(cm.value).toBe("v1\n"));
    // Unsaved edits, then a manual Refresh finds a moved-on-disk copy.
    simulateEdit("mine\n");
    fireEvent.click(screen.getByTestId("file-panel-refresh"));
    await screen.findByTestId("file-panel-conflict");
    // The edits are preserved (not clobbered) and stay dirty until resolved.
    expect(cm.value).toBe("mine\n");
    expect(screen.getByTestId("file-panel-dirty")).toBeTruthy();
  });

  it("raises a conflict banner and Reload adopts the on-disk copy", async () => {
    const readFileText = vi
      .fn()
      .mockResolvedValueOnce("v1\n")
      .mockResolvedValue("v2-agent\n");
    const writeFileText = vi.fn(async () => true);
    const props = (locked: boolean) => ({
      target: { path: "/repo/foo.ts" },
      readFileText,
      writeFileText,
      editingLocked: locked,
    });
    const { rerender } = render(createElement(FilePanel, props(false)));
    await screen.findByTestId("cm-view");
    await waitFor(() => expect(cm.value).toBe("v1\n"));
    // User edits, then a turn runs and writes the file, then ends.
    simulateEdit("mine\n");
    rerender(createElement(FilePanel, props(true)));
    rerender(createElement(FilePanel, props(false)));
    await screen.findByTestId("file-panel-conflict");

    // Reload → editor takes the on-disk text, dirty clears, banner dismisses.
    fireEvent.click(screen.getByTestId("file-panel-reload"));
    await waitFor(() =>
      expect(screen.queryByTestId("file-panel-conflict")).toBeNull(),
    );
    expect(mockReload).toHaveBeenCalledWith("v2-agent\n");
    expect(cm.value).toBe("v2-agent\n");
    expect(screen.queryByTestId("file-panel-dirty")).toBeNull();
  });

  it("Keep mine dismisses the conflict and preserves the edits", async () => {
    const readFileText = vi
      .fn()
      .mockResolvedValueOnce("v1\n")
      .mockResolvedValue("v2-agent\n");
    const writeFileText = vi.fn(async () => true);
    const props = (locked: boolean) => ({
      target: { path: "/repo/foo.ts" },
      readFileText,
      writeFileText,
      editingLocked: locked,
    });
    const { rerender } = render(createElement(FilePanel, props(false)));
    await screen.findByTestId("cm-view");
    await waitFor(() => expect(cm.value).toBe("v1\n"));
    simulateEdit("mine\n");
    rerender(createElement(FilePanel, props(true)));
    rerender(createElement(FilePanel, props(false)));
    await screen.findByTestId("file-panel-conflict");

    // Keep mine → banner gone, edits intact, still dirty (next save overwrites).
    fireEvent.click(screen.getByTestId("file-panel-keep-mine"));
    await waitFor(() =>
      expect(screen.queryByTestId("file-panel-conflict")).toBeNull(),
    );
    expect(mockReload).not.toHaveBeenCalled();
    expect(cm.value).toBe("mine\n");
    expect(screen.getByTestId("file-panel-dirty")).toBeTruthy();
  });

  it("renders markdown via the markdown renderer, with no editor tools", async () => {
    const readFileText = vi.fn(async () => "# Title\n");
    const writeFileText = vi.fn(async () => true);
    render(
      createElement(FilePanel, {
        target: { path: "/repo/plan.md" },
        readFileText,
        writeFileText,
      }),
    );
    expect(await screen.findByTestId("static-md")).toBeTruthy();
    expect(screen.queryByTestId("cm-view")).toBeNull();
    expect(
      document.querySelector('[data-slot="file-panel-view-toggle"]'),
    ).toBeTruthy();
    expect(screen.queryByTestId("file-panel-search")).toBeNull();
    expect(screen.queryByTestId("file-panel-save")).toBeNull();
  });

  it("routes markdown Raw through the editor body but stays view-only (no Save)", async () => {
    const readFileText = vi.fn(async () => "# Title\n");
    const writeFileText = vi.fn(async () => true);
    render(
      createElement(FilePanel, {
        target: { path: "/repo/plan.md" },
        readFileText,
        writeFileText,
      }),
    );
    await screen.findByTestId("static-md");
    fireEvent.click(
      document.querySelector('[data-slot="file-panel-view-raw"]') as HTMLElement,
    );
    const view = await screen.findByTestId("cm-view");
    expect(view.getAttribute("data-readonly")).toBe("true");
    expect(screen.getByTestId("file-panel-search")).toBeTruthy();
    // Markdown is a viewer even in Raw — no Save affordance.
    expect(screen.queryByTestId("file-panel-save")).toBeNull();
  });

  it("surfaces a read error and shows no editor or Save button", async () => {
    const readFileText = vi.fn(async () => {
      throw new Error("boom");
    });
    render(
      createElement(FilePanel, {
        target: { path: "/repo/foo.ts" },
        readFileText,
        writeFileText: vi.fn(async () => true),
      }),
    );
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    expect(screen.queryByTestId("cm-view")).toBeNull();
    expect(screen.queryByTestId("file-panel-save")).toBeNull();
  });
});
