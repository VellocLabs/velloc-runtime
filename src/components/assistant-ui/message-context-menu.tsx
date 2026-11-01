import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { useThreadRuntime } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState, type FC, type RefObject } from "react";
import { createPortal } from "react-dom";

import {
  buildMenuChoices,
  codeTargetOf,
  contextMenuAnchor,
  createChoiceLedger,
  groupMenuChoices,
  messageRowOf,
  snapshotSelection,
  type ActionChoice,
  type MenuOperation,
  type MenuTargetFacts,
} from "@/browser/webview/messageContextMenuModel";
import { markdownToClipboardHtml } from "@/browser/webview/richClipboard";
import { useT } from "@/browser/webview/i18n";
import type { MessageKey } from "@/browser/webview/i18n/messages/en";
import { writeClipboard, writeRichClipboard } from "@/utils/clipboard";
import { markAt, useChapterMarks } from "./chapter-marks";
import { composerShortcutModifiers } from "./composer-send-shortcuts";
import { focusComposerNear, useComposerPassages } from "./composer-passages";
import { userMessageOffersCutActions } from "./inject-message-context";
import { useMessageActionsContext } from "./message-actions-context";

/**
 * The transcript's message context menu (F-22). Opens on a right-click, the
 * menu key or Shift+F10 over a message row; elsewhere — text fields, embedded
 * content, the gaps between rows — the native menu is kept. Each opening
 * freezes the selection and the target into its choices; a choice runs at most
 * once and only against this thread's own session.
 */

type OpenMenu = {
  token: string;
  x: number;
  y: number;
  choices: ActionChoice[];
  /** Focus goes back here on close unless a capture moved it to the composer. */
  returnFocus: HTMLElement | null;
  row: HTMLElement;
};

type Feedback = { key: MessageKey; x: number; y: number; nonce: number };

/** The row's plain text: a reply's text parts (its Markdown source), a prompt's words. */
function entryTextOf(message: { role: string; content: readonly unknown[] }): string {
  const texts = message.content.flatMap((part) => {
    const typed = part as { type?: unknown; text?: unknown };
    return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
  });
  return texts.join(message.role === "assistant" ? "\n\n" : "\n");
}

let menuTokenCounter = 0;

export const MessageContextMenu: FC<{
  listRef: RefObject<HTMLElement | null>;
  sessionId?: string;
  isForeground?: boolean;
}> = ({ listRef, sessionId, isForeground }) => {
  const t = useT();
  const thread = useThreadRuntime();
  const passages = useComposerPassages();
  const actions = useMessageActionsContext();
  const chapters = useChapterMarks();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const ledger = useMemo(() => createChoiceLedger(), []);
  const capturedRef = useRef(false);

  // Read at open time through refs, so the listener is bound once.
  const factsRef = useRef({ thread, passages, actions, chapters, sessionId });
  factsRef.current = { thread, passages, actions, chapters, sessionId };

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const row = messageRowOf(event.target, list);
      const messageId = row?.getAttribute("data-message-id");
      if (!row || !messageId) return;
      const { thread, passages, actions, chapters, sessionId } = factsRef.current;
      const message = thread.getState().messages.find((m) => m.id === messageId);
      if (!message || (message.role !== "user" && message.role !== "assistant")) return;
      const doc = list.ownerDocument;
      const custom = (message.metadata as { custom?: unknown } | undefined)?.custom;
      let fork: MenuTargetFacts["fork"] = null;
      if (message.role === "user" && actions.onForkFromMessage && userMessageOffersCutActions(custom)) {
        fork = { kind: "enabled", cut: { side: "before-entry", entryKey: messageId } };
      } else if (message.role === "assistant" && actions.resolveForkAfterResponse) {
        if (message.status?.type === "running") {
          fork = { kind: "disabled", explanationKey: "messageMenu.forkStreaming" };
        } else {
          const cutKey = actions.resolveForkAfterResponse(messageId);
          fork =
            cutKey === null
              ? { kind: "disabled", explanationKey: "messageMenu.forkNotSaved" }
              : { kind: "enabled", cut: { side: "after-response", responseKey: messageId, cutKey } };
        }
      }
      let chapter: MenuTargetFacts["chapter"] = null;
      if (chapters?.mark) {
        // The part under the pointer names the segment: its transcript line.
        const lineHost = (event.target as Element | null)?.closest?.("[data-line-ordinal]");
        const line = lineHost && row.contains(lineHost) ? Number(lineHost.getAttribute("data-line-ordinal")) : NaN;
        const target = chapters.targetFor(messageId, Number.isInteger(line) ? line : null);
        const existing = target ? markAt(chapters.marks, target) : undefined;
        chapter = !target
          ? { kind: "disabled", explanationKey: "chapters.notYet" }
          : existing
            ? { kind: "unmark", markId: existing.id }
            : { kind: "mark", target };
      }
      const choices = buildMenuChoices({
        threadKey: sessionId ?? "",
        entryKey: messageId,
        role: message.role,
        selection: snapshotSelection(doc.getSelection(), list),
        code: codeTargetOf(event.target, row),
        entryText: entryTextOf(message),
        canAttach: passages !== null,
        fork,
        chapter,
      });
      if (choices.length === 0) return;
      event.preventDefault();
      const anchor = contextMenuAnchor(event, row.getBoundingClientRect());
      menuTokenCounter += 1;
      capturedRef.current = false;
      setMenu({
        token: `menu-${menuTokenCounter}`,
        x: anchor.x,
        y: anchor.y,
        choices,
        returnFocus: doc.activeElement instanceof HTMLElement ? doc.activeElement : null,
        row,
      });
    };
    list.addEventListener("contextmenu", onContextMenu);
    return () => list.removeEventListener("contextmenu", onContextMenu);
  }, [listRef]);

  // A menu belongs to the session it opened in: leaving that session closes it.
  useEffect(() => {
    if (isForeground === false) setMenu(null);
  }, [isForeground]);
  useEffect(() => {
    setMenu(null);
  }, [sessionId]);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 2000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const run = (open: OpenMenu, operation: MenuOperation) => {
    const say = (key: MessageKey) =>
      setFeedback((previous) => ({
        key,
        x: open.x,
        y: open.y,
        nonce: (previous?.nonce ?? 0) + 1,
      }));
    switch (operation.command) {
      case "clipboard.write": {
        const material = operation.material;
        const write =
          material.scope === "entry" && material.output === "rich"
            ? writeRichClipboard(material.body, markdownToClipboardHtml(material.body))
            : writeClipboard(material.body);
        void write.then(
          (ok) => say(ok ? "messageMenu.copied" : "messageMenu.copyFailed"),
          () => say("messageMenu.copyFailed"),
        );
        return;
      }
      case "chapter.mark": {
        void chapters?.mark?.(operation.target).then(
          () => say("chapters.marked"),
          () => say("chapters.markFailed"),
        );
        return;
      }
      case "chapter.unmark": {
        void chapters?.unmark?.(operation.markId).catch(() => undefined);
        return;
      }
      case "context.capture": {
        if (!passages) return;
        if (passages.capture(operation.material, open.row)) {
          capturedRef.current = true;
          if (operation.material.method === "range") {
            open.row.ownerDocument.getSelection()?.removeAllRanges();
          }
        }
        return;
      }
      case "thread.derive": {
        const cut = operation.cut;
        if (cut.side === "before-entry") actions.onForkFromMessage?.(cut.entryKey);
        else actions.onForkAfterResponse?.(cut.cutKey);
        return;
      }
    }
  };

  const { modifier } = composerShortcutModifiers(
    typeof navigator !== "undefined" ? navigator.platform : undefined,
  );

  return (
    <>
      <DropdownMenuPrimitive.Root
        open={menu !== null}
        onOpenChange={(open) => {
          if (!open) setMenu(null);
        }}
      >
        <DropdownMenuPrimitive.Trigger asChild>
          <span
            aria-hidden="true"
            tabIndex={-1}
            className="pointer-events-none fixed size-0"
            style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
          />
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          {menu && (
            <DropdownMenuPrimitive.Content
              data-testid="message-context-menu"
              aria-label={t("messageMenu.label")}
              align="start"
              side="bottom"
              sideOffset={2}
              collisionPadding={8}
              loop
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                // The menu's focus trap holds focus until it closes, so an
                // attach hands focus to the composer here.
                if (capturedRef.current) focusComposerNear(menu.row);
                else menu.returnFocus?.focus({ preventScroll: true });
              }}
              className="z-50 min-w-56 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
            >
              {groupMenuChoices(menu.choices).map((group, index) => (
                <DropdownMenuPrimitive.Group key={group[0]?.section ?? index}>
                  {index > 0 && <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />}
                  {group.map((choice) => (
                    <DropdownMenuPrimitive.Item
                      key={choice.choiceKey}
                      data-testid={`message-menu-${choice.choiceKey}`}
                      disabled={choice.availability === "disabled"}
                      aria-description={
                        choice.availability === "disabled" ? t(choice.explanationKey as MessageKey) : undefined
                      }
                      onSelect={() => {
                        if (choice.availability !== "enabled") return;
                        if (!ledger.claim(menu.token, choice.choiceKey)) return;
                        run(menu, choice.operation);
                      }}
                      className="flex cursor-default items-center gap-4 rounded-sm px-2 py-1.5 outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span>{t(choice.labelKey as MessageKey)}</span>
                        {choice.availability === "disabled" && (
                          <span className="text-xs text-muted-foreground">
                            {t(choice.explanationKey as MessageKey)}
                          </span>
                        )}
                      </span>
                      {choice.shortcut === "attachSelection" && (
                        <kbd className="ml-auto font-sans text-xs text-muted-foreground">
                          {t("messageMenu.attachShortcut", { modifier })}
                        </kbd>
                      )}
                    </DropdownMenuPrimitive.Item>
                  ))}
                </DropdownMenuPrimitive.Group>
              ))}
            </DropdownMenuPrimitive.Content>
          )}
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
      {feedback &&
        createPortal(
          <div
            key={feedback.nonce}
            role="status"
            data-testid="message-menu-feedback"
            className="pointer-events-none fixed z-50 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm"
            style={{ left: feedback.x, top: feedback.y }}
          >
            {t(feedback.key)}
          </div>,
          document.body,
        )}
    </>
  );
};
