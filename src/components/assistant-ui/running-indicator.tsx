import {
  useEffect,
  useId,
  useRef,
  useState,
  type FC,
  type RefObject,
} from "react";
import { useAssistantState } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { isRunStatusRowInView, publishRunStatusRow } from "./run-status-row";
import { compactCount } from "@/utils/humanize/compactCount";
import { useTurnTimer } from "@/hooks/useTurnTimer";
import { isMessageKey, useT, type TranslateFn } from "@/browser/webview/i18n";
import type { MessageKey } from "@/browser/webview/i18n/messages/en";
import {
  useNexusSessionStatus,
  useSessionStatusChannel,
} from "@/browser/webview/topbar/useNexusSessionStatus";
import { useSessionBusy } from "@/components/assistant-ui/session-busy-context";
import { useLiveTurnOutputTokens } from "@/browser/webview/TokenUsageIndicator";
import type { NexusCurrentSessionPhase } from "@/browser/bridge/protocol/ui";

/**
 * Running indicator after the last message, part of the conversation: an animated
 * mark plus a live status line, both removed when the turn ends. Scrolled out of
 * view, the floating scroll button paints the animation (`publishRunStatusRow`,
 * F-22). The status text follows
 * `useNexusSessionStatus` plus live token usage; the run gate reads the session port,
 * like the composer's Send/Stop gate (`resolveRunningIndicatorVisibility`).
 */

// Thinking-phase verb progression. The model gives us no "almost done" signal,
// so we escalate the wording by how long
// the current thinking phase has run. Pure + exported for unit tests: the
// translator is a PARAMETER (not a `useT()` call inside) so these stay callable
// outside React, and a test can drive them under any locale.
export function thinkingVerb(t: TranslateFn, thinkingElapsedMs: number): string {
  if (thinkingElapsedMs >= 20_000) return t("statusBar.almostDoneThinking");
  if (thinkingElapsedMs >= 8_000) return t("statusBar.thinkingMore");
  return t("statusBar.thinking");
}

export type RunningRetryInput = {
  remainingSeconds: number;
  /**
   * Seconds the retry attempt has been in flight (ticks up once the
   * countdown reached 0 — see protocol/ui.ts). Absent from an old worker's
   * payload; the status falls back to the static "starting retry" label.
   */
  inFlightSeconds?: number;
  attempt: number;
  maxRetries: number;
  errorKind?: string;
  /**
   * Catalog key of the failure classification
   * (`ProviderConnectivityIssue.titleKey`) — resolved with `t()` here, so
   * the reason follows the webview's locale. Untrusted on arrival (a NEWER
   * worker can send a key this catalog build doesn't know), hence the
   * `isMessageKey` gate before `t()`.
   */
  errorTitleKey?: string;
  /** Legacy pre-i18n classification text from old workers. Shown as-is. */
  errorTitle?: string;
  errorDetail?: string;
};

export type RunningStatusInput = {
  phase: NexusCurrentSessionPhase;
  activeName?: string | null;
  activeRetry?: RunningRetryInput | null;
  generatedTokens: number;
  thinkingElapsedMs: number;
};

// Catalog keys for the classifier's `ProviderApiErrorKind` slugs
// (utils/providerConnectivity.ts). In the status line this is only reached
// when the retry phase carries neither `errorTitleKey` (current workers) nor
// `errorTitle` (pre-i18n workers) — i.e. a classification with no title at
// all; the transcript's error card resolves through it directly. The map is
// also the membership test: `t()` echoes an unknown key back unchanged, so a
// slug we don't have a key for must never reach it.
const RETRY_ERROR_KIND_KEYS: Record<string, MessageKey> = {
  authentication_failed: "statusBar.retryKind.authentication_failed",
  rate_limit: "statusBar.retryKind.rate_limit",
  invalid_request: "statusBar.retryKind.invalid_request",
  billing_error: "statusBar.retryKind.billing_error",
  server_error: "statusBar.retryKind.server_error",
  repetitive_tool_calls: "statusBar.retryKind.repetitive_tool_calls",
  refusal: "statusBar.retryKind.refusal",
  unknown: "statusBar.retryKind.unknown",
};

/**
 * Translated label for a `ProviderApiErrorKind` slug, shared by the status line and
 * `ProviderApiErrorCard`. A slug with no catalog key falls back to de-slugged text, so
 * `t()` never echoes a raw dotted key.
 */
export function providerApiErrorKindLabel(
  t: TranslateFn,
  kind: string,
): string {
  const key = RETRY_ERROR_KIND_KEYS[kind];
  return key ? t(key) : kind.replace(/_/g, " ");
}

// The status line is a single truncating row; a provider that answers with a
// full JSON body would push everything else off-screen.
const MAX_RETRY_DETAIL_CHARS = 120;

/**
 * Why the retry is happening, e.g.
 * "Provider service unavailable · HTTP 503 upstream connect timeout".
 * Pure + exported for unit tests. Empty string → no reason segment.
 */
export function retryReasonText(
  t: TranslateFn,
  retry: RunningRetryInput,
): string {
  // Classification label ladder: the catalog KEY (resolved here, so it
  // follows the webview's locale) → a pre-i18n worker's already-resolved
  // English title, shown as-is → the kind label. The `isMessageKey`
  // gate keeps a key from a NEWER worker (one this catalog build doesn't
  // know) from rendering as a raw dotted key — it falls through the ladder
  // instead.
  const label =
    (retry.errorTitleKey && isMessageKey(retry.errorTitleKey)
      ? t(retry.errorTitleKey)
      : "") ||
    retry.errorTitle?.trim() ||
    (retry.errorKind ? providerApiErrorKindLabel(t, retry.errorKind) : "");
  // The provider text is multi-line often enough (stack traces, JSON) that it
  // has to be flattened before it can share a one-line status row.
  const detail = (retry.errorDetail ?? "").replace(/\s+/g, " ").trim();
  const short =
    detail.length > MAX_RETRY_DETAIL_CHARS
      ? `${detail.slice(0, MAX_RETRY_DETAIL_CHARS - 1).trimEnd()}…`
      : detail;
  const segments: string[] = [];
  if (label) segments.push(label);
  if (short && short.toLowerCase() !== label.toLowerCase()) segments.push(short);
  return segments.join(" · ");
}

/**
 * Compose the live progress string, e.g. "thinking · 1.8k tokens",
 * "almost done thinking · 12k tokens", or "Read · 1.8k tokens" while a tool
 * runs. When a retry is in progress, shows the countdown plus why instead.
 * Pure + exported for unit tests. Empty string → render no text.
 */
export function runningStatusText(
  t: TranslateFn,
  {
    phase,
    activeName,
    activeRetry,
    generatedTokens,
    thinkingElapsedMs,
  }: RunningStatusInput,
): string {
  // Retry countdown takes priority over all other status
  if (activeRetry) {
    const { remainingSeconds, inFlightSeconds, attempt, maxRetries } =
      activeRetry;
    // At zero the wait is over and the attempt is in flight — the phase stays
    // `retry` until the provider's first stream event, which for a
    // stream-idle timeout is minutes. Count the in-flight time UP so the line
    // visibly progresses; without `inFlightSeconds` (old worker) fall back to
    // the static "starting retry" label rather than a frozen fake timer.
    const countdown =
      remainingSeconds > 0
        ? t("statusBar.retryingIn", {
            seconds: remainingSeconds,
            attempt,
            maxRetries,
          })
        : inFlightSeconds !== undefined
          ? t("statusBar.retryInFlight", {
              attempt,
              maxRetries,
              seconds: inFlightSeconds,
            })
          : t("statusBar.startingRetry", { attempt, maxRetries });
    const reason = retryReasonText(t, activeRetry);
    return reason ? `${countdown} · ${reason}` : countdown;
  }

  const segments: string[] = [];
  if (phase === "tool" || phase === "mcp") {
    // A running tool IS the running task; its name is more useful than a count.
    // Tool names are identifiers, not chrome — never translated.
    segments.push(activeName ? activeName : t("statusBar.runningTask"));
  } else {
    segments.push(thinkingVerb(t, thinkingElapsedMs));
  }
  // Only show tokens when there is a real positive count. Some providers/models
  // don't report usage in their stream events, so `generatedTokens` is 0 (see
  // useLiveTurnOutputTokens → numOrZero) — omit it entirely rather than render a
  // misleading "0 tokens".
  if (generatedTokens > 0) {
    segments.push(t("statusBar.tokens", { count: compactCount(generatedTokens) }));
  }
  return segments.join(" · ");
}

/**
 * Is the status cluster showing? Both inputs ride the session port, not the
 * `currentStateChanged` broadcast, whose phase can freeze mid-turn. `sessionBusy`
 * covers the gaps where `isRunning` is false (provider retry, before the first message).
 */
export function resolveRunningIndicatorVisibility(params: {
  isRunning: boolean;
  sessionBusy: boolean;
}): boolean {
  return params.isRunning || params.sessionBusy;
}

// The goo `<filter>` id MUST be unique per mounted instance (shared ids can make an SVG
// vanish), so it derives from useId(). The `<svg>` carries `text-primary`, so only the
// animation follows the accent. `compact` is the tab-icon size.
export const RunningBlob: FC<{ compact?: boolean }> = ({ compact }) => {
  const gooId = `nexus-blob-goo-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className="nexus-running-blob text-primary"
      data-size={compact ? "compact" : undefined}
      viewBox="0 0 30 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <filter
          id={gooId}
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="b" />
          <feColorMatrix
            in="b"
            type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -8"
            result="g"
          />
          <feComposite in="SourceGraphic" in2="g" operator="atop" />
        </filter>
      </defs>
      <g filter={`url(#${gooId})`} fill="currentColor">
        {/* Three orbiters placed evenly on a circle (radius 8 from the 15,15
            center, at 0°/120°/240°); the group spins to orbit them together. */}
        <g className="nexus-blob-orbit">
          <circle cx="23" cy="15" r="4" />
          <circle cx="11" cy="21.93" r="4" />
          <circle cx="11" cy="8.07" r="4" />
        </g>
        {/* Pulsing center — swells to merge with the orbiters under the goo,
            then shrinks to pinch apart. */}
        <circle className="nexus-blob-core" cx="15" cy="15" r="4" />
      </g>
    </svg>
  );
};

/**
 * Presentational row, free of assistant-ui / bridge hooks. `running` gates the whole
 * status cluster, which is removed rather than frozen when the turn ends; a settled
 * row carries only the idle notice.
 */
export const RunningIndicatorView: FC<{
  running: boolean;
  elapsed: string;
  statusText: string;
  /**
   * A sentence about the settled conversation (why the composer offers "Continue"),
   * shown only while `running` is false.
   */
  idleNotice?: string;
  rowRef?: RefObject<HTMLDivElement | null>;
}> = ({ running, elapsed, statusText, idleNotice, rowRef }) => {
  if (!running && !idleNotice) return null;
  return (
    <div
      ref={rowRef}
      data-testid="nexus-running-indicator"
      data-slot="nexus-run-status"
      data-running={running ? "true" : undefined}
      className={cn(
        "aui-running-indicator mx-auto flex min-h-8 w-full max-w-(--thread-max-width) shrink-0 items-center gap-2 px-2 text-foreground/80",
        // A settled row sits under the last answer's action bar, not on it.
        !running && "mt-4",
      )}
    >
      {running ? (
        <>
          <RunningBlob />
          {/* Order: [blob] [elapsed time] [status text]. */}
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-none text-muted-foreground">
            {/* Never shrinks or wraps: as a flex item its min-content width is
                its longest word, so a long status text would break "16m 51s". */}
            <span className="shrink-0 whitespace-nowrap tabular-nums">
              {elapsed}
            </span>
            {statusText ? (
              <>
                <span aria-hidden="true" className="opacity-50">
                  ·
                </span>
                {/* Truncates, so the full string stays hoverable. Tabular digits
                    keep the per-second counters from nudging the line width. */}
                <span
                  className="min-w-0 truncate tabular-nums"
                  title={statusText}
                >
                  {statusText}
                </span>
              </>
            ) : null}
          </span>
        </>
      ) : (
        <span
          data-testid="status-bar-idle-notice"
          className="min-w-0 truncate text-[13px] leading-none text-muted-foreground"
          title={idleNotice}
        >
          {idleNotice}
        </span>
      )}
    </div>
  );
};

/**
 * Publishes whether `rowRef`'s row is inside the conversation viewport's visible
 * band (above the sticky composer footer) while the run is active, and clears
 * the entry when the run ends or the thread unmounts.
 */
function useRunStatusRowPublisher(params: {
  sessionId: string | undefined;
  active: boolean;
  rowRef: RefObject<HTMLDivElement | null>;
}): void {
  const { sessionId, active, rowRef } = params;
  const [offscreen, setOffscreen] = useState(false);

  useEffect(() => {
    setOffscreen(false);
    const row = rowRef.current;
    if (!active || !row || typeof IntersectionObserver === "undefined") return;
    const viewport = row.closest<HTMLElement>(".aui-thread-viewport");
    if (!viewport) return;
    const footer = viewport.querySelector<HTMLElement>(
      ".aui-thread-viewport-footer",
    );
    let observer: IntersectionObserver | null = null;
    const observe = () => {
      observer?.disconnect();
      const footerHeight = footer?.offsetHeight ?? 0;
      observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1];
          if (!entry?.rootBounds) return;
          setOffscreen(
            !isRunStatusRowInView(entry.boundingClientRect, entry.rootBounds),
          );
        },
        {
          root: viewport,
          rootMargin: `0px 0px -${footerHeight}px 0px`,
          threshold: [0, 0.25, 0.5, 0.75, 1],
        },
      );
      observer.observe(row);
    };
    observe();
    const footerResize =
      footer && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(observe)
        : null;
    if (footer) footerResize?.observe(footer);
    return () => {
      footerResize?.disconnect();
      observer?.disconnect();
    };
  }, [active, rowRef]);

  useEffect(() => {
    if (!sessionId) return;
    publishRunStatusRow(sessionId, active ? { inView: !offscreen } : null);
  }, [sessionId, active, offscreen]);
  useEffect(() => {
    if (!sessionId) return;
    return () => publishRunStatusRow(sessionId, null);
  }, [sessionId]);
}

export const RunningIndicator: FC<{
  sessionId?: string;
  /**
   * Whether this session is the foreground (visible) one. The worker only
   * broadcasts `session.currentStateChanged` (phase/active) for the foreground
   * session, so the phase-derived status TEXT is only meaningful there; for a
   * backgrounded session `phase` is stale. Background thread trees are
   * `display:none`, so we simply render nothing off-foreground. Defaults to
   * true for standalone/single-session use.
   */
  isForeground?: boolean;
  /** See `RunningIndicatorView.idleNotice`. Supplied by the Thread, which owns
   *  the continue-conversation contexts. */
  idleNotice?: string;
}> = ({ sessionId, isForeground = true, idleNotice }) => {
  const t = useT();
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const sessionBusy = useSessionBusy();
  const statusChannel = useSessionStatusChannel();
  // Phase/active drive the status TEXT only (tool name, retry countdown); the
  // run gate above is what decides whether any of it is on screen.
  const { phase, active } = useNexusSessionStatus(statusChannel, sessionId);
  const generatedTokens = useLiveTurnOutputTokens();
  const rowRef = useRef<HTMLDivElement | null>(null);

  const showIndicator = resolveRunningIndicatorVisibility({
    isRunning,
    sessionBusy,
  });

  // Per-turn elapsed time. Start a fresh turn when the run begins; stamp an end
  // time when it stops so the NEXT turn restarts the clock at 0 instead of
  // continuing this one (the label itself is unmounted while stopped).
  const [turn, setTurn] = useState<{ start: number; end: number | null } | null>(
    null,
  );
  useEffect(() => {
    setTurn((prev) => {
      if (showIndicator) {
        return !prev || prev.end !== null ? { start: Date.now(), end: null } : prev;
      }
      return prev && prev.end === null ? { ...prev, end: Date.now() } : prev;
    });
  }, [showIndicator]);
  const elapsed = useTurnTimer({
    since: turn?.start ?? Date.now(),
    live: showIndicator,
    until: turn?.end ?? undefined,
  });

  // Track when the current 'thinking' phase began so the verb can escalate, and
  // tick once a second while thinking so it advances even with no new events.
  // Each thinking BURST restarts the timer (a thinking→tool→thinking cycle resets
  // the verb to "thinking") — intentional: the verb reflects the current burst,
  // not cumulative thinking time across the turn.
  const thinkingSinceRef = useRef<number | null>(null);
  useEffect(() => {
    thinkingSinceRef.current = phase === "thinking" ? Date.now() : null;
  }, [phase]);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!showIndicator || phase !== "thinking") return;
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [showIndicator, phase]);

  const thinkingElapsedMs = thinkingSinceRef.current
    ? Date.now() - thinkingSinceRef.current
    : 0;

  const statusText = runningStatusText(t, {
    phase,
    activeName: active?.name,
    activeRetry: active?.retry,
    generatedTokens,
    thinkingElapsedMs,
  });

  const visible = isForeground && showIndicator;
  useRunStatusRowPublisher({
    sessionId,
    active: visible,
    rowRef,
  });

  if (!isForeground) return null;
  return (
    <RunningIndicatorView
      running={showIndicator}
      elapsed={elapsed}
      statusText={statusText}
      idleNotice={idleNotice}
      rowRef={rowRef}
    />
  );
};
