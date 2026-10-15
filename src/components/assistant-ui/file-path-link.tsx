import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  extractFilePathCandidates,
  resolveCandidatePath,
} from "@/utils/filePathDetection";
import { useFilePathContext } from "@/components/assistant-ui/file-path-context";
import { useRightPanelContent } from "@/components/assistant-ui/right-panel-content-context";

/**
 * A model-mentioned file path, rendered as plain text until the host confirms the file
 * exists, then openable in the Files view via an appended `>>` marker (no link styling,
 * no layout shift), so a mis-detected path degrades to plain text.
 */
export const PathChip: FC<{
  /** Path as written, minus any `:line` suffix. */
  path: string;
  /** Optional 1-based line from a `path:42` mention — the Files view reveals
   *  it (cursor + centered scroll) once the editor mounts. */
  line?: number;
  /** Original text to render (may include the `:42` suffix). */
  children?: ReactNode;
  className?: string;
}> = ({ path, line, children, className }) => {
  const { projectRoot, probe } = useFilePathContext();
  const { openFile } = useRightPanelContent();

  const resolved = useMemo(
    () => resolveCandidatePath(path, projectRoot),
    [path, projectRoot],
  );
  // Seed from the cache so an already-probed path (the common case — the same
  // file gets mentioned repeatedly) never flashes through the plain state.
  const [exists, setExists] = useState<boolean | undefined>(() =>
    resolved && probe ? probe.peek(resolved) : undefined,
  );

  useEffect(() => {
    if (!resolved || !probe) return;
    const cached = probe.peek(resolved);
    if (cached !== undefined) {
      setExists(cached);
      return;
    }
    let cancelled = false;
    void probe.check(resolved).then((found) => {
      if (!cancelled) setExists(found);
    });
    return () => {
      cancelled = true;
    };
  }, [resolved, probe]);

  const openable = exists === true && resolved !== null && !!openFile;
  if (!openable) return <>{children}</>;

  return (
    <span
      role="button"
      tabIndex={0}
      data-slot="file-path-link"
      data-file-path={resolved}
      data-file-line={line}
      title={`Open ${resolved}`}
      onClick={() => openFile?.({ path: resolved, line })}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openFile?.({ path: resolved, line });
      }}
      className={cn(
        "aui-file-path-link cursor-pointer rounded-sm hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
      <span
        aria-hidden="true"
        data-slot="file-path-open-marker"
        className="ml-0.5 select-none font-medium text-muted-foreground"
      >
        {">>"}
      </span>
    </span>
  );
};

/**
 * Plain text with its detected file paths made openable — the non-markdown
 * counterpart of `remarkFilePaths` for surfaces that render raw strings
 * (user-message text, which is not markdown). Splits the text around each
 * candidate and wraps only the path runs; everything else renders verbatim, so
 * a text with no paths costs one regex pass and renders as the same string.
 */
export const TextWithFilePaths: FC<{ text: string }> = ({ text }) => {
  const candidates = useMemo(() => extractFilePathCandidates(text), [text]);
  if (candidates.length === 0) return <>{text}</>;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.index > cursor) {
      nodes.push(text.slice(cursor, candidate.index));
    }
    nodes.push(
      <PathChip
        key={`fp-${candidate.index}`}
        path={candidate.path}
        line={candidate.line}
      >
        {candidate.raw}
      </PathChip>,
    );
    cursor = candidate.index + candidate.raw.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
};
