import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { RewindButton } from "@/components/assistant-ui/rewind-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PartLineProvider } from "@/components/assistant-ui/part-line-context";
import { CollapsibleUserMessageText, getCollapsibleUserMessageText, userMessageTranscriptLine } from "@/components/assistant-ui/user-message-text";
import { UserMessageAttachments } from "@/components/assistant-ui/attachment";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  useAssistantState,
  useThreadRuntime,
} from "@assistant-ui/react";
import { GitBranchIcon, XIcon } from "lucide-react";
import {
  type FC,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useComposerPassages } from "./composer-passages";
import { ChapterMarkBadge } from "./chapter-marks";
import { quotedBody, quotedNote } from "@/browser/webview/capturedPassages";
import { readQuotedPassage } from "@/browser/webview/replyQuote";
import { ModUserMessageSite, type ModUserMessageProps } from "./mod-render";
import { restoreNextMessageIntoComposer } from "./next-message-strip";
import { injectStateOfCustom, InjectMessagesContext, userMessageOffersCutActions } from "./inject-message-context";
import { useT } from "@/browser/webview/i18n";
import { useMessageActionsContext } from "@/components/assistant-ui/message-actions-context";
import {
  MessageCopyButton,
  RowClock,
  recordFirstMessageMounted,
  userMessagePlainText,
} from './message-row-shared';

// The web-default image part is a bare `<img src={dataUrl}>` with no loading
// hints, so every pasted screenshot in the transcript decodes eagerly — a full
// 4-bytes/px bitmap per image, viewport or not. Same element, same (absent)
// styling, plus the two decode-memory attributes: `lazy` defers decode until
// the image nears the viewport (and lets the browser drop decoded data for
// scrolled-away history, compounding with the virtualized list's culling),
// `async` keeps the decode off the paint-critical path. Zero visual change.
const LazyUserImagePart: FC = () => (
  <MessagePartPrimitive.Image loading="lazy" decoding="async" />
);
const USER_PART_COMPONENTS = { Image: LazyUserImagePart } as const;
// A mod's `text` rewrite stands in for the text parts; an image still draws.
const USER_NON_TEXT_PART_COMPONENTS = { Text: () => null, Image: LazyUserImagePart } as const;

function userMessageHasNonTextParts(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => (part as { type?: unknown } | null)?.type !== "text");
}

/** The quotes a sent prompt carried, each with its reply under it, drawn above the person's words, in order. */
const UserMessageQuote: FC = () => {
  const quotes = useAssistantState((s) => {
    const list = (s.message.metadata as { custom?: { quotes?: unknown } } | undefined)?.custom?.quotes;
    return Array.isArray(list) ? (list as unknown[]) : null;
  });
  const passages = (quotes ?? []).flatMap((value) => {
    const passage = readQuotedPassage(value);
    return passage === null ? [] : [passage];
  });
  if (passages.length === 0) return null;
  return (
    <>
      {passages.map((passage, index) => {
        const note = quotedNote(passage);
        return (
          <div key={index} className="mb-1.5">
            <blockquote
              data-testid="user-message-quote"
              className="aui-user-message-quote border-l-2 border-primary/60 pl-2.5 text-sm text-muted-foreground whitespace-pre-wrap break-words"
            >
              {quotedBody(passage)}
            </blockquote>
            {note && (
              <p
                dir="auto"
                data-testid="user-message-quote-note"
                className="aui-user-message-quote-note mt-1 text-sm whitespace-pre-wrap break-words"
              >
                {note}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
};

export const UserMessage: FC = () => {
  const collapsibleText = useAssistantState((s) =>
    getCollapsibleUserMessageText(s.message.content),
  );
  // The transcript line this message was read from, so a search jump can land inside
  // the user bubble (`userMessageTranscriptLine`); null for a live, unpersisted turn.
  const line = useAssistantState((s) =>
    userMessageTranscriptLine(s.message.content, s.message.metadata),
  );

  // Plain-Enter input: `pending` bubbles (not yet handed to the model) and
  // `landed` ones (state-backed, or rendered from their queued_command).
  // (Primitive selectors: a fresh object per read would re-render forever.)
  const t = useT();
  const injectState = useAssistantState((s) =>
    injectStateOfCustom(
      (s.message.metadata as { custom?: unknown } | undefined)?.custom,
    ),
  );
  const offersCutActions = useAssistantState((s) =>
    userMessageOffersCutActions(
      (s.message.metadata as { custom?: unknown } | undefined)?.custom,
    ),
  );
  const messageId = useAssistantState((s) => s.message.id);
  const inject = injectState === null ? null : { state: injectState, uuid: messageId };
  const injectPending = injectState === "pending";
  const { removeInjectMessage } = useContext(InjectMessagesContext);
  // The THREAD composer: inside a message, `useComposerRuntime()` is that
  // message's edit composer, and the text would vanish into it.
  const threadRuntime = useThreadRuntime();
  const passages = useComposerPassages();
  const handleRemoveInject = () => {
    if (!inject || !removeInjectMessage) return;
    void removeInjectMessage(inject.uuid).then((result) => {
      if (result.ok) {
        restoreNextMessageIntoComposer(threadRuntime.composer, result.text ?? null, passages?.store);
      }
    });
  };

  useEffect(() => {
    recordFirstMessageMounted("user");
  }, []);
  // Hover-retention bridge — same rationale as AssistantMessage. The bar floats
  // BELOW the bubble (top-full): the actions belong to the message you are
  // pointing at, and an above-bubble bar reads as belonging to the PREVIOUS
  // turn. It is absolutely positioned and only takes pointer events while this
  // message is hovered, so it still can't steal clicks from the next message's
  // code-block copy button when idle.
  const [actionsOpen, setActionsOpen] = useState(false);
  // The props a mod's `UserMessage` site reads (F-25); asked for only
  // while some loaded hook selects the site.
  const [expanded, setExpanded] = useState(false);
  const plainText = useAssistantState((s) => userMessagePlainText(s.message.content));
  const hasNonTextParts = useAssistantState((s) => userMessageHasNonTextParts(s.message.content));
  const promptPlugin = useAssistantState((s) => {
    const stamp = (s.message.metadata as { custom?: { pluginPrompt?: { plugin?: unknown; asUser?: unknown } } } | undefined)
      ?.custom?.pluginPrompt;
    return typeof stamp?.plugin === "string" ? stamp.plugin : null;
  });
  const promptAsUser = useAssistantState(
    (s) =>
      (s.message.metadata as { custom?: { pluginPrompt?: { asUser?: unknown } } } | undefined)?.custom?.pluginPrompt
        ?.asUser === true,
  );
  const modProps = useMemo<ModUserMessageProps>(
    () => ({
      text: collapsibleText ?? plainText,
      origin:
        promptPlugin !== null
          ? { kind: "plugin", name: promptPlugin, ...(promptAsUser ? { asUser: true as const } : {}) }
          : { kind: "unclassified" },
      isExpanded: collapsibleText ? expanded : true,
    }),
    [collapsibleText, plainText, promptPlugin, promptAsUser, expanded],
  );
  const userBubbleBody = (rewrite?: { text: string }) => (
    <PartLineProvider line={line}>
      <UserMessageQuote />
      {rewrite ? (
        <>
          <CollapsibleUserMessageText text={rewrite.text} expanded={expanded} onExpandedChange={setExpanded} />
          {hasNonTextParts ? <MessagePrimitive.Parts components={USER_NON_TEXT_PART_COMPONENTS} /> : null}
        </>
      ) : collapsibleText ? (
        <CollapsibleUserMessageText text={collapsibleText} expanded={expanded} onExpandedChange={setExpanded} />
      ) : (
        <MessagePrimitive.Parts components={USER_PART_COMPONENTS} />
      )}
    </PartLineProvider>
  );
  const userBubble = (rewrite?: { text: string }) =>
    injectPending ? (
      // Pending (not yet handed to the model): the bubble itself says so —
      // dashed outline, dimmed — and the explanation is a hover tooltip,
      // never an extra line under the message.
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="aui-user-message-content wrap-break-word peer max-w-full min-w-0 overflow-x-hidden rounded-2xl border border-dashed border-muted-foreground/40 bg-muted/60 px-3.5 py-2 text-foreground/70 empty:hidden"
            data-line-ordinal={line === null ? undefined : String(line)}
            data-testid="inject-message-status"
          >
            {userBubbleBody(rewrite)}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">{t("composer.injectPending")}</TooltipContent>
      </Tooltip>
    ) : (
      <div
        className="aui-user-message-content wrap-break-word peer max-w-full min-w-0 overflow-x-hidden rounded-2xl bg-muted px-3.5 py-2 text-foreground empty:hidden"
        data-line-ordinal={line === null ? undefined : String(line)}
      >
        {userBubbleBody(rewrite)}
      </div>
    );

  return (
    <MessagePrimitive.Root
      className="aui-user-message-root fade-in slide-in-from-bottom-1 mx-auto grid w-full max-w-(--thread-max-width) animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_minmax(0,auto)] content-start gap-y-2 px-2 py-2 text-prose duration-150 [&:where(>*)]:col-start-2"
      data-role="user"
      data-testid={inject ? "inject-message" : undefined}
      data-inject-state={inject?.state}
      data-inject-uuid={inject?.uuid}
    >
      <div
        className="aui-user-message-content-wrapper group relative col-start-2 flex min-w-0 flex-col items-end"
        onMouseEnter={() => setActionsOpen(true)}
        onMouseLeave={() => setActionsOpen(false)}
      >
        <ChapterMarkBadge messageId={messageId} className="absolute -left-5 top-2.5" />
        <UserMessageAttachments />
        {/* The bubble declares the line so the reveal lands ON it: a short
            message flashes as one box, with the arrow at its left edge. The
            long-message renderer stamps its visible text too, one level
            deeper (via PartLineProvider), so the walk stops on the text and
            never opens the "show full" toggle just to look inside.
            A mod's `UserMessage` hook may draw the row instead. */}
        <ModUserMessageSite requestId={messageId} props={modProps} drawEngine={userBubble} />
        {injectPending && removeInjectMessage && (
          // Overlaid on the bubble's corner (the column is as wide as the
          // bubble), shown on hover / keyboard focus — no line of its own.
          <button
            type="button"
            data-testid="inject-message-remove"
            className="absolute -top-2 -left-2 z-10 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t("composer.injectRemove")}
            title={t("composer.injectRemove")}
            onClick={handleRemoveInject}
          >
            <XIcon className="size-3" />
          </button>
        )}
        {/* Hover bridge (user): transparent strip between the bubble and the action bar
            below it. Interactive only while this message is hovered (`group-hover`), so
            it never sits live over the next message's clicks. */}
        <div
          className="aui-user-action-bar-bridge pointer-events-none group-hover:pointer-events-auto absolute top-full right-0 h-2.5 w-12 opacity-0"
          onMouseEnter={() => setActionsOpen(true)}
          onMouseLeave={() => setActionsOpen(false)}
        />
        {/* Absolute (not in flow) so it never shifts the next message, anchored
            just BELOW the bubble (top-full) — the bar reads as belonging to the
            message it is attached to. `z-10` keeps it above the next message it
            overhangs, and it stays `pointer-events-none` until this message is
            hovered so it can't steal clicks from that message's own controls.
            Visibility is driven by the hover bridge above (content OR bar
            hovered); the CSS group-hover classes are kept as a no-JS
            fallback. */}
        <div
          className={cn(
            "aui-user-action-bar-wrapper absolute top-full right-0 z-10 flex opacity-0 transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 peer-empty:hidden",
            actionsOpen && "opacity-100 pointer-events-auto",
          )}
          onMouseEnter={() => setActionsOpen(true)}
          onMouseLeave={() => setActionsOpen(false)}
        >
          <UserActionBar cutActions={offersCutActions} />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

// "Fork from here" — a custom (non-primitive) action. Reads the message's id
// (=== transcript uuid, set by the adapter) and calls the host's fork handler,
// which copies the transcript prefix into a new session. Renders nothing when
// no handler is wired (e.g. tests / storybook).
// "Rewind to here" — restore the conversation to this point, discarding what
// came after (confirmed in `RewindButton`). Implemented host-side as
// fork-to-cut + switch + delete-original; here it just calls the handler.
const RewindAction: FC = () => {
  const { onRewindToMessage } = useMessageActionsContext();
  const messageId = useAssistantState((s) => s.message.id);
  if (!onRewindToMessage || !messageId) return null;
  return <RewindButton onRewind={() => onRewindToMessage(messageId)} />;
};

const ForkAction: FC = () => {
  const t = useT();
  const { onForkFromMessage } = useMessageActionsContext();
  const messageId = useAssistantState((s) => s.message.id);
  if (!onForkFromMessage || !messageId) return null;
  return (
    <TooltipIconButton
      tooltip={t('action.fork')}
      onClick={() => onForkFromMessage(messageId)}
    >
      <GitBranchIcon />
    </TooltipIconButton>
  );
};

// NOT `hideWhenRunning`: these actions (copy / rewind / fork) act on a message
// that is already committed to the transcript, so they stay usable while the
// turn streams — hiding them meant hovering a user message during a run showed
// nothing at all, and "fork this prompt into a new thread" is exactly what you
// reach for while the current answer is still coming.
// `cutActions` is false on a mid-turn inject row: Rewind / Fork would cut at an
// id that is not a transcript entry there (see `userMessageOffersCutActions`).
const UserActionBar: FC<{ cutActions?: boolean }> = ({ cutActions = true }) => {
  const t = useT();
  return (
    <ActionBarPrimitive.Root
      className="aui-user-action-bar-root flex items-center gap-1 text-muted-foreground/70 [&_button]:size-5 [&_button]:p-0.5 [&_svg]:size-3.5"
    >
      <MessageCopyButton />
      {cutActions && <RewindAction />}
      {cutActions && <ForkAction />}
      <RowClock />
    </ActionBarPrimitive.Root>
  );
};
