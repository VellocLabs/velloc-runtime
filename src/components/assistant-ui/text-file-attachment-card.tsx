import { AttachmentPrimitive } from "@assistant-ui/react";
import { XIcon } from "lucide-react";
import { useEffect, useState, type FC, type ReactNode } from "react";
import { useT } from "@/browser/webview/i18n";
import {
  TEXT_PREVIEW_HEAD_BYTES,
  decodeTextHead,
  textAttachmentBadge,
  textPreviewLines,
} from "@/browser/webview/textAttachmentPreview";

/** Preview lines of `file`'s head: `undefined` while reading, `null` if binary. */
function useTextFileHead(file: Blob): string[] | null | undefined {
  const [lines, setLines] = useState<string[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setLines(undefined);
    file
      .slice(0, TEXT_PREVIEW_HEAD_BYTES)
      .arrayBuffer()
      .then(
        (head) => {
          const text = decodeTextHead(new Uint8Array(head));
          if (live) setLines(textPreviewLines(text));
        },
        () => {
          if (live) setLines(null);
        },
      );
    return () => {
      live = false;
    };
  }, [file]);
  return lines;
}

/**
 * A pending text file shown as a thumbnail of its first lines, with the
 * extension badge and name along the bottom. Renders `fallback` when the
 * file's head turns out to be binary.
 */
export const ComposerTextFileAttachmentCard: FC<{
  file: Blob;
  name: string;
  fallback: ReactNode;
}> = ({ file, name, fallback }) => {
  const t = useT();
  const lines = useTextFileHead(file);
  if (lines === null) return <>{fallback}</>;
  const badge = textAttachmentBadge(name);
  return (
    <AttachmentPrimitive.Root
      className="aui-composer-text-attachment relative shrink-0"
      data-testid="composer-text-attachment"
      role="group"
      aria-label={name}
      title={name}
    >
      <span className="flex h-20 w-28 flex-col overflow-hidden rounded-xl border bg-base-surface">
        <span
          aria-hidden="true"
          data-testid="composer-text-attachment-preview"
          className="min-h-0 flex-1 overflow-hidden px-2 pt-1.5 font-mono text-[7px] leading-[1.35] text-muted-foreground [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
        >
          {(lines ?? []).map((line, index) => (
            <span key={index} className="block whitespace-pre">
              {line || " "}
            </span>
          ))}
        </span>
        <span className="flex min-w-0 items-center gap-1 border-t px-1.5 py-1 text-[10px] text-foreground">
          {badge && (
            <span className="shrink-0 rounded bg-muted px-1 text-[8px] font-semibold leading-3.5 text-muted-foreground">
              {badge}
            </span>
          )}
          <span className="min-w-0 truncate font-medium">{name}</span>
        </span>
      </span>
      <AttachmentPrimitive.Remove asChild>
        <button
          type="button"
          className="aui-composer-attachment-remove absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow-sm transition-opacity hover:opacity-80"
          aria-label={t("attachment.remove")}
        >
          <XIcon className="size-3" />
        </button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};
