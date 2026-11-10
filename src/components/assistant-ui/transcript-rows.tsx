import { CodeReviewMessage } from './code-review-card';
import { BackgroundResultsCard } from "@/components/assistant-ui/background-results-card";
import { TeamMessageCard } from "@/components/assistant-ui/team-message-card";
import { Button } from "@/components/ui/button";
import { ComposerPrimitive, MessagePrimitive, useAssistantState } from "@assistant-ui/react";
import { BookmarkCheckIcon, Minimize2Icon } from "lucide-react";
import { type FC, type ReactNode } from "react";
import { useT } from "@/browser/webview/i18n";
import { compactCount } from "@/utils/humanize/compactCount";
import { ProviderApiErrorCard } from './provider-api-error-card';
import { useMessageCustomString } from './message-row-shared';
import { ReplyRow } from './reply-row';
import { UserMessage } from './user-message';

// Centered, muted transcript divider — used for the `Interrupted` marker
// and the `Compacted conversation · saved …` boundary so both read as the
// same kind of cut-point in the conversation. A thin 1px rule grows with
// `flex-1` on each side so it stretches to the full `--thread-max-width`
// (matching message-bubble alignment), with an optional leading icon
// (e.g. the compact-boundary's compress glyph) ahead of the label.
const TranscriptDivider: FC<{
  label: string;
  dataRole: string;
  icon?: ReactNode;
}> = ({ label, dataRole, icon }) => {
  return (
    <MessagePrimitive.Root
      className="aui-transcript-divider-root mx-auto flex w-full max-w-(--thread-max-width) items-center gap-3 px-2 py-1"
      data-role={dataRole}
    >
      <span
        aria-hidden="true"
        className="aui-transcript-divider-rule h-px min-w-0 flex-1 bg-border"
      />
      <span className="aui-transcript-divider-text flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs select-none">
        {icon}
        {label}
      </span>
      <span
        aria-hidden="true"
        className="aui-transcript-divider-rule h-px min-w-0 flex-1 bg-border"
      />
    </MessagePrimitive.Root>
  );
};

/** A teammate's mailbox message — its own card, never the raw envelope.
 *  Driven by `metadata.custom.sourceType === "team_message"` (see
 *  `teamMessageThreadMessage`). */
const TeamMessage: FC = () => {
  const from = useMessageCustomString("teamMessageFrom") ?? "";
  // Absent on an entry converted by a build before display names: the key
  // was the only name there was, so it is the display too.
  const fromDisplay = useMessageCustomString("teamMessageFromDisplay") ?? from;
  const trust = useMessageCustomString("teamMessageTrust");
  const kind = useMessageCustomString("teamMessageKind");
  const bodyField = useMessageCustomString("teamMessageBody");
  // The body also rides the message's first text part (export / a11y copy),
  // which is what an entry converted by an older build carries.
  const fallbackBody = useAssistantState((s) => {
    const content = s.message.content;
    const first = Array.isArray(content) ? content[0] : undefined;
    return first?.type === "text" ? first.text : "";
  });
  return (
    <TeamMessageCard
      parsed={{
        from,
        fromDisplay,
        trust: trust === "untrusted" ? "untrusted" : "trusted",
        kind:
          kind === "turn_end" || kind === "shutdown" || kind === "system"
            ? kind
            : "message",
        body: bodyField ?? fallbackBody,
      }}
    />
  );
};

const BackgroundResultsMessage: FC = () => {
  const kindField = useMessageCustomString("backgroundResultKind");
  const textField = useMessageCustomString("backgroundResultText");
  // Older entries carry the text as the message's first text part instead.
  const fallbackText = useAssistantState((s) => {
    const content = s.message.content;
    const first = Array.isArray(content) ? content[0] : undefined;
    return first?.type === "text" ? first.text : "";
  });
  return (
    <BackgroundResultsCard
      kind={kindField === "subagent" ? "subagent" : "shell"}
      text={textField ?? fallbackText}
    />
  );
};

// Compact-boundary marker — same divider style as Interrupted, with a leading
// compress glyph and the pre-compact token count when known. Driven by
// `metadata.custom.sourceType === "compact_boundary"` set in
// `assistantUiAdapter.convertTranscriptMessage`.
const CompactBoundaryDivider: FC = () => {
  const t = useT();
  const preTokens = useAssistantState((s) => {
    const custom = s.message.metadata.custom as
      | Record<string, unknown>
      | undefined;
    return typeof custom?.preTokens === "number" ? custom.preTokens : undefined;
  });
  return (
    <TranscriptDivider
      label={
        preTokens === undefined
          ? t("thread.compactedConversation")
          : t("thread.compactedSaved", { tokens: compactCount(preTokens) })
      }
      dataRole="compact-boundary"
      icon={<Minimize2Icon className="size-3.5" aria-hidden="true" />}
    />
  );
};

// Background memory extraction saved topic files (the `memory_saved` system
// message). Divider style like the compact boundary — a status note between
// turns, not a bubble.
const MemorySavedDivider: FC = () => {
  const t = useT();
  const text = useMessageCustomString("memorySavedText");
  return (
    <TranscriptDivider
      label={text ?? t("thread.savedMemory")}
      dataRole="memory-saved"
      icon={<BookmarkCheckIcon className="size-3.5" aria-hidden="true" />}
    />
  );
};

// Boot marks for the first and last message routing render; frozen once
// `firstMessageMountedMs` is set.
function recordMessageRoutingMark(): void {
  const m = (globalThis as { __nexusBootMarks?: Record<string, number> })
    .__nexusBootMarks ?? {};
  if (m.firstMessageMountedMs != null) return;
  const now = Date.now();
  if (m.firstMessageRenderPropMs == null) {
    m.firstMessageRenderPropMs = now;
  }
  m.lastMessageRenderPropMs = now;
  (globalThis as { __nexusBootMarks?: Record<string, number> })
    .__nexusBootMarks = m;
}

const HistoryRow: FC = () => {
  const t = useT();
  recordMessageRoutingMark();
  const role = useAssistantState((s) => s.message.role);
  const sourceType = useMessageCustomString("sourceType");

  // Synthetic stop-interrupt marker — rendered as a dashed centered divider
  // rather than a full message bubble. Driven by
  // `metadata.custom.sourceType === "interrupt"` set in
  // `assistantUiAdapter.convertTranscriptMessage`.
  if (sourceType === "interrupt") {
    return (
      <TranscriptDivider
        label={t("thread.interrupted")}
        dataRole="interrupt"
      />
    );
  }
  if (sourceType === "code-review") return <CodeReviewMessage />;
  if (sourceType === "team_message") return <TeamMessage />;
  if (sourceType === "background_results") return <BackgroundResultsMessage />;
  if (sourceType === "compact_progress") {
    return (
      <TranscriptDivider
        label={t("thread.compactingConversation")}
        dataRole="compact-progress"
        icon={
          <Minimize2Icon className="size-3.5 animate-pulse" aria-hidden="true" />
        }
      />
    );
  }
  if (sourceType === "compact_boundary") return <CompactBoundaryDivider />;
  if (sourceType === "provider_api_error") return <ProviderApiErrorCard />;
  if (sourceType === "memory_saved") return <MemorySavedDivider />;
  if (role === "user") return <UserMessage />;
  return <ReplyRow />;
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-edit-composer-wrapper mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 py-3">
      <ComposerPrimitive.Root className="aui-edit-composer-root ml-auto flex w-full max-w-[85%] flex-col rounded-2xl bg-muted">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent p-4 text-foreground text-composer outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-3 mb-3 flex items-center gap-2 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm">Update</Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

/**
 * Row routing for every `ThreadPrimitive.MessageByIndex`. Module-level so its identity
 * is stable: `MessageByIndex` is memoized on `(index, components)`.
 */
// Exported for the row render tests.
export const TRANSCRIPT_MESSAGE_COMPONENTS = {
  Message: HistoryRow,
  EditComposer,
} as const;
