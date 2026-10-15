import { Button } from "@/components/ui/button";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAssistantState,
  useAui,
  useComposerRuntime,
} from "@assistant-ui/react";
import {
  ChevronRightIcon,
  FileTextIcon,
  PaperclipIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FC,
} from "react";
import { useT } from "@/browser/webview/i18n";
import type { TranslateFn } from "@/browser/webview/i18n/translate";
import { useCan } from "@/browser/webview/useCan";
import {
  countPastedTextLines,
  isPastedTextAttachmentName,
  mergePastedTextIntoDraft,
  pastedTextPreview,
} from "@/browser/webview/pastedTextAttachment";

/**
 * Host-routed attachment picker: the `<webview>` guest's `<input type=file>` can't raise
 * a native chooser, so the host's `ui.pickAttachmentFiles` is used when provided. The
 * host route is `full`; when absent, or when the connection may not use it, the
 * paperclip falls back to `<input type=file>`.
 */
export type ComposerAttachmentPicker = () => Promise<File[]>;
const ComposerAttachmentPickerContext =
  createContext<ComposerAttachmentPicker | null>(null);
export const ComposerAttachmentPickerProvider =
  ComposerAttachmentPickerContext.Provider;

/**
 * Composer capability flags for the active model. `supportsImageInput: false` disables
 * image paste and makes `BrowserComposerAttachmentAdapter` reject image files.
 * Defaults to fully capable.
 */
export type ComposerModelCapabilities = {
  supportsImageInput: boolean;
};
const ComposerModelCapabilitiesContext =
  createContext<ComposerModelCapabilities>({ supportsImageInput: true });
export const ComposerModelCapabilitiesProvider =
  ComposerModelCapabilitiesContext.Provider;
export const useComposerModelCapabilities = (): ComposerModelCapabilities =>
  useContext(ComposerModelCapabilitiesContext);

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex flex-wrap gap-2 px-1">
      <ComposerPrimitive.Attachments
        components={{
          Attachment: ComposerAttachmentItem,
          Document: ComposerAttachmentItem,
          File: ComposerAttachmentItem,
        }}
      />
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  const t = useT();
  const hostPick = useContext(ComposerAttachmentPickerContext);
  // A full grant and a tree with no capability provider both answer true, so
  // the desktop keeps its host picker.
  const canHostPick = useCan("ui", "pickAttachmentFiles");
  const pick = canHostPick ? hostPick : null;
  const composer = useComposerRuntime();
  const [picking, setPicking] = useState(false);

  const handleHostPick = useCallback(async () => {
    if (!pick || picking) return;
    setPicking(true);
    try {
      const files = await pick();
      for (const file of files) {
        try {
          await composer.addAttachment(file);
        } catch (error) {
          // A single rejected file (unsupported type) must not abort the rest.
          console.warn("Failed to add picked attachment:", file.name, error);
        }
      }
    } catch (error) {
      console.warn("Attachment picker failed:", error);
    } finally {
      setPicking(false);
    }
  }, [pick, picking, composer]);

  // Fallback path: no host picker wired, or none this connection may use ⇒
  // use assistant-ui's built-in `<input type=file>` chooser (works on hosts
  // whose WebContents routes RunFileChooser — mock/dev/browser and a remote
  // client's own tab, not the `<webview>` guest).
  if (!pick) {
    return (
      <ComposerPrimitive.AddAttachment asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="aui-composer-add-attachment size-8 rounded-full text-muted-foreground hover:text-foreground"
          aria-label={t('attachment.add')}
        >
          <PaperclipIcon className="size-4" />
        </Button>
      </ComposerPrimitive.AddAttachment>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={picking}
      onClick={handleHostPick}
      className="aui-composer-add-attachment size-8 rounded-full text-muted-foreground hover:text-foreground"
      aria-label={t('attachment.add')}
    >
      <PaperclipIcon className="size-4" />
    </Button>
  );
};

const ComposerAttachmentItem: FC = () => {
  const name = useAssistantState((s) => s.attachment.name);
  if (isPastedTextAttachmentName(name)) return <PastedTextAttachmentCard />;
  return <ComposerFileAttachmentChip />;
};

const ComposerFileAttachmentChip: FC = () => {
  const t = useT();
  return (
    <AttachmentPrimitive.Root className="aui-composer-attachment flex max-w-full items-center gap-2 rounded-full border bg-muted/60 px-3 py-1 text-xs text-foreground">
      <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">
        <AttachmentPrimitive.Name />
      </span>
      <AttachmentPrimitive.Remove asChild>
        <button
          type="button"
          className="aui-composer-attachment-remove rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          aria-label={t('attachment.remove')}
        >
          <XIcon className="size-3" />
        </button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

/** "Pasted text · N lines", singular-aware. */
export function pastedTextLinesLabel(t: TranslateFn, lines: number): string {
  return lines === 1
    ? t('attachment.pastedTextLinesOne')
    : t('attachment.pastedTextLines', { count: lines });
}

/**
 * A large paste held as a `pasted-text-<n>.txt` attachment (see
 * `pastedTextAttachment.ts`): the ChatGPT card — the paste's first line as
 * the title, and "Show in text field" to turn it back into input.
 */
const PastedTextAttachmentCard: FC = () => {
  const t = useT();
  const file = useAssistantState((s) =>
    "file" in s.attachment ? s.attachment.file : undefined,
  );
  const composer = useComposerRuntime();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!(file instanceof Blob)) return;
    void file.text().then((value) => {
      if (live) setText(value);
    });
    return () => {
      live = false;
    };
  }, [file]);
  const aui = useAui();

  const handleShowInTextField = () => {
    if (text === null) return;
    const draft = composer.getState().text;
    composer.setText(mergePastedTextIntoDraft(draft, text));
    void Promise.resolve(aui.attachment().remove()).catch((error: unknown) => {
        console.warn("Failed to remove pasted-text attachment:", error);
      });
  };

  const label =
    text === null
      ? t('attachment.pastedText')
      : pastedTextLinesLabel(t, countPastedTextLines(text));
  return (
    <AttachmentPrimitive.Root
      className="aui-composer-pasted-text group/pasted relative flex w-64 max-w-full items-center gap-3 rounded-2xl border bg-base-surface px-3 py-2.5 text-foreground"
      data-testid="composer-pasted-text"
      role="group"
      aria-label={label}
      title={label}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-info">
        <FileTextIcon className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">
          {(text !== null && pastedTextPreview(text)) || t('attachment.pastedText')}
        </span>
        <button
          type="button"
          data-testid="composer-pasted-text-show"
          disabled={text === null}
          onClick={handleShowInTextField}
          className="flex w-fit items-center gap-0.5 text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground disabled:opacity-60"
        >
          {t('attachment.showInTextField')}
          <ChevronRightIcon className="size-3" />
        </button>
      </span>
      <AttachmentPrimitive.Remove asChild>
        <button
          type="button"
          className="aui-composer-attachment-remove absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow-sm transition-opacity hover:opacity-80"
          aria-label={t('attachment.remove')}
        >
          <XIcon className="size-3" />
        </button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

/**
 * The uploads a sent user message named, as cards above its bubble (the
 * conversion lifts them out of the prompt's `@"…/.velloc/uploads/…"` prefix —
 * `convertUserContentWithAttachments`). Renders nothing for a message with
 * none.
 */
export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments mb-1.5 flex flex-wrap justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments
        components={{
          Attachment: UserMessageAttachmentItem,
          Document: UserMessageAttachmentItem,
          File: UserMessageAttachmentItem,
        }}
      />
    </div>
  );
};

const UserMessageAttachmentItem: FC = () => {
  const t = useT();
  const name = useAssistantState((s) => s.attachment.name);
  const pasted = isPastedTextAttachmentName(name);
  return (
    <AttachmentPrimitive.Root
      className="aui-user-message-attachment flex max-w-full items-center gap-2 rounded-xl border bg-base-surface px-3 py-1.5 text-xs text-foreground"
      data-testid="user-message-attachment"
      title={name}
    >
      <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">
        {pasted ? t('attachment.pastedText') : name}
      </span>
    </AttachmentPrimitive.Root>
  );
};
