import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useAssistantState } from "@assistant-ui/react";
import { useActionBarCopy } from "@assistant-ui/core/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type FC } from "react";
import { useT } from "@/browser/webview/i18n";
import { timeAgoLabel } from "@/utils/humanize/timeAgoLabel";
import { writeClipboard } from "@/utils/clipboard";

// Boot instrumentation — capture the first message component to mount.
// Both UserMessage and AssistantMessage call this; the first useEffect to
// fire (whichever message renders first in the list) wins and stamps
// `firstMessageMountedMs`. Gap to `auiThreadFirstCommitMs` attributes the
// per-message-row mount cost relative to assistant-ui's parent commit.
export function recordFirstMessageMounted(role: "user" | "assistant"): void {
  const m = (globalThis as { __nexusBootMarks?: Record<string, number | string> })
    .__nexusBootMarks ?? {};
  if (m.firstMessageMountedMs == null) {
    m.firstMessageMountedMs = Date.now();
    m.firstMessageMountedRole = role;
    (globalThis as { __nexusBootMarks?: Record<string, number | string> })
      .__nexusBootMarks = m;
  }
}

// Relative-time label ("1h ago") shown at the end of each message's action
// bar. Reads the message's `createdAt` (set by the assistant-ui adapter from
// the transcript timestamp); the absolute time is in the `title` tooltip.
export const RowClock: FC = () => {
  const createdAt = useAssistantState((s) => s.message.createdAt);
  if (!createdAt) return null;
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <span
      className="aui-message-timestamp self-center whitespace-nowrap px-1 text-xs text-muted-foreground/60"
      title={date.toLocaleString()}
    >
      {timeAgoLabel(date)}
    </span>
  );
};

/**
 * Message-level copy button: `ActionBarPrimitive.Copy`'s contract, routed through the
 * shared `writeClipboard` util so the copy never silently fails in the guest webview.
 */
export const MessageCopyButton: FC = () => {
  const t = useT();
  const { copy, disabled, isCopied } = useActionBarCopy({
    copyToClipboard: (text) => {
      // The lib's `copy()` resolves its own promise right away and flips
      // isCopied regardless — matching the original ActionBarPrimitive.Copy
      // behavior. The real win here is `writeClipboard`'s execCommand
      // fallback, which makes the write itself succeed far more often in
      // the guest webview than the bare `navigator.clipboard.writeText` the
      // library used.
      void writeClipboard(text);
    },
  });
  if (disabled) return null;
  return (
    <TooltipIconButton tooltip={t('action.copy')} onClick={() => copy()}>
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </TooltipIconButton>
  );
};

/** The row's text as a mod's `UserMessage` site reads it: its text parts,
 *  joined. */
export function userMessagePlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** One field of a slash command's output row stamp (`metadata.custom.
 *  commandOutput`), or null on any other row. */
export function commandOutputField(metadata: unknown, field: "command" | "args"): string | null {
  const stamp = (metadata as { custom?: { commandOutput?: Record<string, unknown> } } | undefined)?.custom
    ?.commandOutput;
  const value = stamp?.[field];
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Transcript row routing: one message index → one component. Each branch subscribes
// only to the fields it needs.
// ---------------------------------------------------------------------------

/** Read a string field off the current message's `metadata.custom`. */
export const useMessageCustomString = (key: string): string | undefined =>
  useAssistantState((s) => {
    const custom = s.message.metadata.custom as
      | Record<string, unknown>
      | undefined;
    const value = custom?.[key];
    return typeof value === "string" ? value : undefined;
  });
