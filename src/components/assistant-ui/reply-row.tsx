import { AssistantMessageBody } from "@/components/assistant-ui/assistant-message-body";
import { ToolLineRangeProvider } from "@/components/assistant-ui/tool-line-range-context";
import { TOOL_LINE_RANGES_KEY } from "@/browser/webview/assistantUiAdapter";
import { StaticMarkdown } from "@/components/assistant-ui/static-markdown";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  useAssistantState,
} from "@assistant-ui/react";
import {
  type FC,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ChapterMarkBadge } from "./chapter-marks";
import { REASONING_ONLY_ROW_KEY } from "@/browser/webview/showReasoning";
import { ModCommandOutputSite, type ModCommandOutputProps } from "./mod-render";
import { useT } from "@/browser/webview/i18n";
import {
  MessageCopyButton,
  RowClock,
  commandOutputField,
  recordFirstMessageMounted,
  useMessageCustomString,
  userMessagePlainText,
} from './message-row-shared';

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

export const ReplyRow: FC = () => {
  useEffect(() => {
    recordFirstMessageMounted("assistant");
  }, []);
  // The action bar floats below the content box; a transparent bridge plus
  // `actionsOpen` state keep it visible while the cursor travels to it.
  const [actionsOpen, setActionsOpen] = useState(false);
  const toolLineRanges = useMessageCustomString(TOOL_LINE_RANGES_KEY);
  // A row that held only reasoning, with Show reasoning off: nothing is left
  // to show, so collapse it rather than draw an empty bubble. Kept mounted
  // (the list indexes rows one-for-one, and the body's first-hydration signal
  // must still fire); the composer's running indicator covers a live one.
  const reasoningOnlyHidden = useAssistantState(
    (s) =>
      (s.message.metadata.custom as Record<string, unknown> | undefined)?.[
        REASONING_ONLY_ROW_KEY
      ] === true,
  );
  // A slash command's output row is a mod's `CommandOutput` site (F-25); asked for only while some loaded hook selects it.
  const messageId = useAssistantState((s) => s.message.id);
  const commandName = useAssistantState((s) => commandOutputField(s.message.metadata, "command"));
  const commandArgs = useAssistantState((s) => commandOutputField(s.message.metadata, "args"));
  const commandText = useAssistantState((s) =>
    commandName === null ? "" : userMessagePlainText(s.message.content),
  );
  const commandProps = useMemo<ModCommandOutputProps | null>(
    () =>
      commandName === null
        ? null
        : { command: commandName, args: commandArgs ?? "", text: commandText, isErrored: false },
    [commandName, commandArgs, commandText],
  );
  const messageBody = (rewrite?: { text: string }) =>
    rewrite ? (
      // A mod's rewrite draws in the row alone, markdown as the row is.
      <StaticMarkdown content={rewrite.text} />
    ) : (
      <ToolLineRangeProvider ranges={toolLineRanges}>
        <AssistantMessageBody />
      </ToolLineRangeProvider>
    );
  return (
    <MessagePrimitive.Root
      className={cn(
        "aui-assistant-message-root fade-in slide-in-from-bottom-1 relative mx-auto w-full max-w-(--thread-max-width) animate-in py-2 duration-150",
        reasoningOnlyHidden && "hidden",
      )}
      data-role="assistant"
    >
      <ChapterMarkBadge messageId={messageId} className="absolute -left-5 top-3.5" />
      {/* `group` wraps ONLY the content (the footer is absolute, so the group's
          box = the message text). The action bar's visibility is driven by
          group-hover on THIS box, NOT the whole padded row — so when the cursor
          is on this message's bar (which floats over the NEXT message's top
          padding), the next message's content isn't hovered and its bar stays
          hidden. Keeps the tight spacing (no reserved padding) while killing
          the hover-bleed onto the next message. */}
      <div
        className="aui-assistant-message-content-group group relative"
        onMouseEnter={() => setActionsOpen(true)}
        onMouseLeave={() => setActionsOpen(false)}
      >
        <div className="aui-assistant-message-content wrap-break-word space-y-2.5 px-2 text-foreground text-prose">
          {/* Publishes the per-tool line ranges for this message so a
              collapsed card can declare which transcript lines it holds.
              Read here because this component is inside the assistant-ui
              provider; the card is not, wherever it is used standalone.
              A command's output row may be drawn by a mod's hook. */}
          {commandProps ? (
            <ModCommandOutputSite requestId={messageId} props={commandProps} drawEngine={messageBody} />
          ) : (
            messageBody()
          )}
          <MessageError />
        </div>
        {/* Hover bridge: a transparent strip in the gap between the message
            text and the action bar. It is a REAL element (not a pseudo) with
            pointer-events-auto, so the cursor travelling from text → gap →
            bar never leaves a hoverable region and the bar stays visible.
            Width spans the bar's area (the bar is left-aligned) plus room to
            catch the cursor coming from the message text. Only meaningful
            while the bar is shown (opacity-0 hides it too), but it must stay
            mounted so mouseenter fires as the cursor enters the gap. */}
        <div
          className="aui-assistant-message-footer-bridge pointer-events-auto absolute top-full left-2 h-2.5 w-64 opacity-0"
          onMouseEnter={() => setActionsOpen(true)}
          onMouseLeave={() => setActionsOpen(false)}
        />
        <div
          className={cn(
            "aui-assistant-message-footer absolute top-full left-2 flex opacity-0 transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
            actionsOpen && "opacity-100 pointer-events-auto",
          )}
          onMouseEnter={() => setActionsOpen(true)}
          onMouseLeave={() => setActionsOpen(false)}
        >
          <AssistantActionBar />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  const t = useT();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      className="aui-assistant-action-bar-root -ml-1 flex gap-1 text-muted-foreground/70 [&_button]:size-5 [&_button]:p-0.5 [&_svg]:size-3.5"
    >
      <MessageCopyButton />
      <RowClock />
    </ActionBarPrimitive.Root>
  );
};
