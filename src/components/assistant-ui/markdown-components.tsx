import {
  type CodeHeaderProps,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import { type FC, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { PathChip } from "@/components/assistant-ui/file-path-link";
import { FILE_PATH_TAG } from "@/components/assistant-ui/remarkFilePaths";
import { cn } from "@/lib/utils";
import { asWholeFilePath } from "@/utils/filePathDetection";
import { writeClipboard } from "@/utils/clipboard";
import { useT } from "@/browser/webview/i18n";

/**
 * The shared markdown element map; callers memoize it. The `code` entry reads
 * assistant-ui's PreContext, so `StaticMarkdown` must override `code`/`pre`.
 */

export const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const t = useT();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code) return;
    copyToClipboard(code);
  };

  return (
    <div className="aui-code-header-root mt-[0.75em] flex items-center justify-between rounded-t-lg border border-border/50 border-b-0 bg-muted/50 px-3 py-1.5 text-caption">
      <span className="aui-code-header-language font-medium text-muted-foreground lowercase">
        {language}
      </span>
      <TooltipIconButton tooltip={t('action.copy')} onClick={onCopy}>
        {!isCopied && <CopyIcon />}
        {isCopied && <CheckIcon />}
      </TooltipIconButton>
    </div>
  );
};

export const useCopyToClipboard = ({
  copiedDuration = 3000,
}: {
  copiedDuration?: number;
} = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value) return;

    // Success-gated: the "copied" state (and its re-click lock) only ever
    // reflects a REAL copy. `writeClipboard` also falls back to
    // `document.execCommand` when `navigator.clipboard` rejects (guest
    // webview without clipboard permission / document focus), which was
    // the silent-failure cause of the low success rate.
    void writeClipboard(value).then((ok) => {
      if (!ok) return;
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
};

/** Styling shared by every fenced code block `<pre>` (the assistant-ui path
 *  and StaticMarkdown's own `pre` override). */
export const MARKDOWN_PRE_CLASS =
  "aui-md-pre overflow-x-auto rounded-t-none rounded-b-lg border border-border/50 border-t-0 bg-muted/30 p-3 text-code";

/** The whole-content path of an inline `code` span, or null. Children are the
 *  raw markdown text, so anything other than a single string is prose-with-
 *  markup and not a bare path. */
function inlineCodeFilePath(
  children: React.ReactNode,
): { path: string; line?: number } | null {
  if (typeof children !== "string") return null;
  const candidate = asWholeFilePath(children);
  return candidate ? { path: candidate.path, line: candidate.line } : null;
}

/** Styling shared by inline `code` spans. */
export const MARKDOWN_INLINE_CODE_CLASS =
  "aui-md-inline-code rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.9em] break-all";

export const sharedMarkdownComponents = {
  h1: ({ className, ...props }: React.ComponentPropsWithoutRef<"h1">) => (
    <h1
      className={cn(
        "aui-md-h1 mt-[2.25em] mb-[0.5em] scroll-m-20 font-semibold text-[1.75em] leading-[1.25] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }: React.ComponentPropsWithoutRef<"h2">) => (
    <h2
      className={cn(
        "aui-md-h2 mt-[1.875em] mb-[0.5em] scroll-m-20 font-semibold text-[1.375em] leading-[1.25] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }: React.ComponentPropsWithoutRef<"h3">) => (
    <h3
      className={cn(
        "aui-md-h3 mt-[1.5em] mb-[0.5em] scroll-m-20 font-semibold text-[1.125em] leading-[1.3] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }: React.ComponentPropsWithoutRef<"h4">) => (
    <h4
      className={cn(
        "aui-md-h4 mt-[1.25em] mb-[0.5em] scroll-m-20 font-semibold text-[1em] leading-[1.3] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }: React.ComponentPropsWithoutRef<"h5">) => (
    <h5
      className={cn(
        "aui-md-h5 mt-[1.25em] mb-[0.5em] font-semibold text-[0.875em] leading-[1.3] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }: React.ComponentPropsWithoutRef<"h6">) => (
    <h6
      className={cn(
        "aui-md-h6 mt-[1.25em] mb-[0.5em] font-semibold text-[0.875em] leading-[1.3] text-muted-foreground first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }: React.ComponentPropsWithoutRef<"p">) => (
    <p
      className={cn(
        "aui-md-p my-[0.75em] wrap-break-word first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  // Decode-memory attributes only — deliberately NO sizing/layout classes, so
  // an image renders exactly as it does today. `lazy` keeps images in
  // scrolled-away markdown undecoded (a decoded bitmap is ~4 bytes/px however
  // small it displays); `async` keeps the decode off the paint-critical path.
  img: ({ loading, decoding, ...props }: React.ComponentPropsWithoutRef<"img">) => (
    // eslint-disable-next-line jsx-a11y/alt-text -- alt comes from the markdown source via props
    <img loading={loading ?? "lazy"} decoding={decoding ?? "async"} {...props} />
  ),
  a: ({ className, ...props }: React.ComponentPropsWithoutRef<"a">) => (
    <a
      className={cn(
        "aui-md-a text-primary underline underline-offset-2 hover:text-primary/80",
        className,
      )}
      rel="noopener noreferrer"
      {...props}
    />
  ),
  blockquote: ({
    className,
    ...props
  }: React.ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className={cn(
        "aui-md-blockquote my-[0.75em] border-muted-foreground/30 border-l-2 pl-3 text-muted-foreground italic",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }: React.ComponentPropsWithoutRef<"ul">) => (
    <ul
      className={cn(
        "aui-md-ul my-[0.75em] ml-4 list-disc marker:text-muted-foreground [&>li]:mt-[0.25em]",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }: React.ComponentPropsWithoutRef<"ol">) => (
    <ol
      className={cn(
        "aui-md-ol my-[0.75em] ml-4 list-decimal marker:text-muted-foreground [&>li]:mt-[0.25em]",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }: React.ComponentPropsWithoutRef<"hr">) => (
    <hr
      className={cn("aui-md-hr my-[1.5em] border-border", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }: React.ComponentPropsWithoutRef<"table">) => (
    <table
      className={cn(
        "aui-md-table my-[0.75em] w-full border-separate border-spacing-0 overflow-y-auto",
        className,
      )}
      {...props}
    />
  ),
  th: ({ className, ...props }: React.ComponentPropsWithoutRef<"th">) => (
    <th
      className={cn(
        "aui-md-th bg-muted px-2 py-1 text-left font-medium first:rounded-tl-lg last:rounded-tr-lg [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }: React.ComponentPropsWithoutRef<"td">) => (
    <td
      className={cn(
        "aui-md-td border-border border-b border-l px-2 py-1 text-left last:border-r [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }: React.ComponentPropsWithoutRef<"tr">) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-bl-lg [&:last-child>td:last-child]:rounded-br-lg",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }: React.ComponentPropsWithoutRef<"li">) => (
    <li
      className={cn("aui-md-li wrap-break-word", className)}
      {...props}
    />
  ),
  sup: ({ className, ...props }: React.ComponentPropsWithoutRef<"sup">) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-caption [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }: React.ComponentPropsWithoutRef<"pre">) => (
    <pre className={cn(MARKDOWN_PRE_CLASS, className)} {...props} />
  ),
  code: function Code({
    className,
    ...props
  }: React.ComponentPropsWithoutRef<"code">) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    // An inline code span whose ENTIRE content is a file path is the most
    // common way the model writes one (`src/a/b.ts`), and the backticks already
    // assert "this is an identifier, not prose" — so it needs no heuristics
    // beyond the whole-string match. Fenced blocks are left verbatim.
    const wholePath = isCodeBlock ? null : inlineCodeFilePath(props.children);
    const body =
      wholePath === null ? (
        props.children
      ) : (
        <PathChip path={wholePath.path} line={wholePath.line}>
          {props.children}
        </PathChip>
      );
    return (
      <code
        className={cn(!isCodeBlock && MARKDOWN_INLINE_CODE_CLASS, className)}
        {...props}
      >
        {body}
      </code>
    );
  },
  // Prose paths, produced by `remarkFilePaths`. The element carries the parsed
  // path/line; its children are the original text, so an unconfirmed path
  // renders exactly as it was written.
  [FILE_PATH_TAG]: ({
    path,
    line,
    children,
  }: {
    path?: string;
    line?: string;
    children?: React.ReactNode;
  }) =>
    path ? (
      <PathChip
        path={path}
        line={line === undefined ? undefined : Number.parseInt(line, 10)}
      >
        {children}
      </PathChip>
    ) : (
      <>{children}</>
    ),
  CodeHeader,
};
