import * as React from "react";
import { ChevronRightIcon, CircleAlertIcon, PlugIcon, SearchIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT, type TranslateFn } from "@/browser/webview/i18n";
import { cn } from "@/lib/utils";
import type { McpServerOrigin } from "@/mcp/serverOrigin";
import type { McpToolSummary } from "@/mcp/toolSummary";
import type { McpAuthControls } from "@/browser/webview/mcpAuthView";
import { McpSignInPanel } from "./mcp-sign-in-panel";

/**
 * One MCP server in detail (F-9, F-10): its status, origin, transport and
 * version, then the instructions it sent at initialize, then its tools — each a row that expands to the full description
 * and its parameters. Opened from a Connectors card row and from the MCP
 * settings page.
 */

export type McpServerDetail = {
  name: string;
  /** `needs-auth`: it waits for a sign-in (F-10), offered with `signInUrl`. */
  status?: "connected" | "failed" | "needs-auth";
  signInUrl?: string;
  origin?: McpServerOrigin;
  transport?: string;
  version?: string;
  toolCount?: number;
  tools?: readonly McpToolSummary[];
  /** The server's initialize `instructions`; shown as plain text, never markup. */
  instructions?: string;
  error?: string;
};

/** More tools than this shows the filter field. */
const FILTER_THRESHOLD = 6;
/** An error longer than this starts clamped with a Show more toggle. */
const ERROR_CLAMP_CHARS = 240;
/** Instructions with more lines or characters than these start clamped
 *  (`line-clamp-6`) with a Show more toggle. */
const INSTRUCTIONS_CLAMP_LINES = 6;
const INSTRUCTIONS_CLAMP_CHARS = 480;

function originLabel(origin: McpServerOrigin | undefined, t: TranslateFn): string | null {
  switch (origin?.kind) {
    case "settings":
      return t("mcpServers.originSettings");
    case "project":
      return t("mcpServers.originProject");
    case "plugin":
      return t("mcpServers.originPlugin", { plugin: origin.plugin });
    default:
      return null;
  }
}

export function McpServerDetailDialog({
  open,
  onOpenChange,
  server,
  toolsLoading,
  toolsError,
  onRetry,
  onManage,
  auth,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: McpServerDetail | null;
  /** Tools are being fetched; the list draws placeholders. */
  toolsLoading?: boolean;
  /** Fetching tools failed with this message. */
  toolsError?: string;
  onRetry?: () => void;
  onManage?: () => void;
  /** Server sign-in; the panel shows while the server needs one. */
  auth?: McpAuthControls;
}) {
  const t = useT();
  return (
    <Dialog open={open && server !== null} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="mcp-server-detail"
        className="flex max-h-[85vh] max-w-xl flex-col gap-0 p-0"
        // Escape closes this dialog only, not the card popover behind it.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          onOpenChange(false);
        }}
      >
        {server ? (
          <DetailBody
            key={server.name}
            server={server}
            toolsLoading={toolsLoading}
            toolsError={toolsError}
            onRetry={onRetry}
            auth={auth}
            t={t}
          />
        ) : null}
        <DialogFooter className="border-t px-5 py-3 sm:justify-between">
          {onManage ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="mcp-server-detail-manage"
              onClick={() => {
                onOpenChange(false);
                onManage();
              }}
            >
              {t("mcpServers.manage")}
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" data-testid="mcp-server-detail-done" onClick={() => onOpenChange(false)}>
            {t("mcpServers.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailBody({
  server,
  toolsLoading,
  toolsError,
  onRetry,
  auth,
  t,
}: {
  server: McpServerDetail;
  toolsLoading?: boolean;
  toolsError?: string;
  onRetry?: () => void;
  auth?: McpAuthControls;
  t: TranslateFn;
}) {
  const [query, setQuery] = React.useState("");
  const [openTool, setOpenTool] = React.useState<string | null>(null);
  const needsAuth = server.status === "needs-auth";
  // A server waiting for a sign-in has no tools to list, like a failed one.
  const failed = server.status === "failed" || needsAuth;
  const origin = originLabel(server.origin, t);
  const tools = server.tools ?? [];
  const count = server.tools ? tools.length : server.toolCount;
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? tools.filter(
        (tool) =>
          tool.name.toLowerCase().includes(needle) ||
          (tool.description?.toLowerCase().includes(needle) ?? false),
      )
    : tools;
  const error = failed ? server.error : toolsError;

  return (
    <>
      <DialogHeader className="gap-1.5 border-b px-5 pt-5 pb-4 text-start">
        <div className="flex min-w-0 items-center gap-3 pe-6">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <PlugIcon aria-hidden strokeWidth={1.5} className="size-[18px] text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <DialogTitle
                data-testid="mcp-server-detail-name"
                className="truncate text-base"
                title={server.name}
              >
                {server.name}
              </DialogTitle>
              {server.status ? (
                <Badge
                  variant={needsAuth ? "warning" : failed ? "destructive" : "success"}
                  size="sm"
                  data-testid="mcp-server-detail-status"
                  data-status={server.status}
                  className="shrink-0 gap-1"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      needsAuth ? "bg-warning" : failed ? "bg-destructive" : "bg-success",
                    )}
                  />
                  {needsAuth
                    ? t(
                        auth?.serverState(server.signInUrl)?.needsCredentials
                          ? "mcpServers.needsCredentials"
                          : "mcpServers.needsAuth",
                      )
                    : failed
                      ? t("mcpServers.failed")
                      : t("mcpServers.connected")}
                </Badge>
              ) : null}
            </div>
            <DialogDescription asChild>
              <div
                data-testid="mcp-server-detail-meta"
                className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs"
              >
                {origin ? <span className="max-w-[16rem] truncate">{origin}</span> : null}
                {server.transport ? (
                  <Badge variant="muted" size="sm">
                    {server.transport.toUpperCase()}
                  </Badge>
                ) : null}
                {server.version ? (
                  <span className="max-w-[10rem] truncate" title={server.version}>
                    {t("mcpServers.version", { version: server.version })}
                  </span>
                ) : null}
                {count !== undefined ? (
                  <span data-testid="mcp-server-detail-count">
                    {count === 1 ? t("mcpServers.toolsOne") : t("mcpServers.toolsMany", { count })}
                  </span>
                ) : null}
              </div>
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="min-h-0 overflow-y-auto px-5 py-4">
        {needsAuth && server.signInUrl ? <McpSignInPanel url={server.signInUrl} auth={auth} /> : null}
        {error && !needsAuth ? <ErrorPanel message={error} onRetry={failed ? undefined : onRetry} t={t} /> : null}

        {!failed && server.instructions ? (
          <InstructionsSection text={server.instructions} spaced={Boolean(error)} t={t} />
        ) : null}

        {!failed ? (
          <section className={cn("flex flex-col gap-2", error || server.instructions ? "mt-4" : null)}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {t("mcpServers.toolsHeading")}
              </h3>
              {tools.length > FILTER_THRESHOLD ? (
                <div className="relative w-44">
                  <SearchIcon
                    aria-hidden
                    className="-translate-y-1/2 pointer-events-none absolute start-2 top-1/2 size-3.5 text-muted-foreground"
                  />
                  <Input
                    data-testid="mcp-server-detail-filter"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("mcpServers.filterPlaceholder")}
                    aria-label={t("mcpServers.filterPlaceholder")}
                    className="h-7 ps-7 text-xs"
                  />
                </div>
              ) : null}
            </div>

            {toolsLoading ? (
              <div data-testid="mcp-server-detail-loading" className="flex flex-col gap-2" aria-busy>
                <span className="sr-only">{t("mcpServers.loadingTools")}</span>
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex flex-col gap-1.5 rounded-lg border border-border/60 px-3 py-2.5">
                    <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                    <div className="h-2.5 w-4/5 animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : tools.length === 0 ? (
              error ? null : (
                <p data-testid="mcp-server-detail-empty" className="py-6 text-center text-muted-foreground text-sm">
                  {t("mcpServers.noTools")}
                </p>
              )
            ) : visible.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground text-sm">
                {t("mcpServers.noMatch", { query: query.trim() })}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
                {visible.map((tool) => (
                  <ToolRow
                    key={tool.name}
                    tool={tool}
                    expanded={openTool === tool.name}
                    onToggle={() => setOpenTool((current) => (current === tool.name ? null : tool.name))}
                    t={t}
                  />
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </>
  );
}

function InstructionsSection({ text, spaced, t }: { text: string; spaced: boolean; t: TranslateFn }) {
  const long =
    text.length > INSTRUCTIONS_CLAMP_CHARS || text.split("\n").length > INSTRUCTIONS_CLAMP_LINES;
  const [full, setFull] = React.useState(false);
  const bodyId = React.useId();
  return (
    <section
      data-testid="mcp-server-detail-instructions"
      data-expanded={long ? full : undefined}
      className={cn("flex flex-col gap-2", spaced ? "mt-4" : null)}
    >
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {t("mcpServers.instructionsHeading")}
      </h3>
      <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
        <p
          id={bodyId}
          data-testid="mcp-server-detail-instructions-text"
          className={cn(
            "whitespace-pre-wrap break-words text-foreground/90 text-xs leading-relaxed",
            long && !full && "line-clamp-6",
          )}
        >
          {text}
        </p>
        {long ? (
          <button
            type="button"
            data-testid="mcp-server-detail-instructions-toggle"
            aria-expanded={full}
            aria-controls={bodyId}
            className="mt-1.5 font-medium text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setFull((value) => !value)}
          >
            {full ? t("mcpServers.showLess") : t("mcpServers.showMore")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ErrorPanel({ message, onRetry, t }: { message: string; onRetry?: () => void; t: TranslateFn }) {
  const long = message.length > ERROR_CLAMP_CHARS;
  const [full, setFull] = React.useState(false);
  return (
    <div
      data-testid="mcp-server-detail-error"
      className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-destructive text-xs"
    >
      <CircleAlertIcon aria-hidden className="mt-px size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className={cn("whitespace-pre-wrap break-words", !full && "line-clamp-4")}>{message}</p>
        {long || onRetry ? (
          <div className="mt-1.5 flex gap-3">
            {long ? (
              <button
                type="button"
                className="font-medium underline-offset-2 hover:underline"
                onClick={() => setFull((value) => !value)}
              >
                {full ? t("mcpServers.showLess") : t("mcpServers.showMore")}
              </button>
            ) : null}
            {onRetry ? (
              <button
                type="button"
                data-testid="mcp-server-detail-retry"
                className="font-medium underline-offset-2 hover:underline"
                onClick={onRetry}
              >
                {t("mcpServers.retry")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolRow({
  tool,
  expanded,
  onToggle,
  t,
}: {
  tool: McpToolSummary;
  expanded: boolean;
  onToggle: () => void;
  t: TranslateFn;
}) {
  const panelId = React.useId();
  const params = tool.params ?? [];
  return (
    <li data-testid="mcp-server-detail-tool" data-name={tool.name} data-expanded={expanded}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full min-w-0 items-start gap-2 px-3 py-2.5 text-start outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium font-mono text-[13px]" title={tool.name}>
              {tool.name}
            </span>
            {tool.readOnly ? (
              <Badge variant="muted" size="sm" className="shrink-0">
                {t("mcpServers.readOnly")}
              </Badge>
            ) : null}
          </span>
          {!expanded ? (
            <span
              data-testid="mcp-server-detail-tool-summary"
              className="mt-0.5 line-clamp-2 break-words text-muted-foreground text-xs"
            >
              {tool.description ?? t("mcpServers.noDescription")}
            </span>
          ) : null}
        </span>
      </button>
      {expanded ? (
        <div id={panelId} className="flex flex-col gap-3 px-3 pb-3 ps-[34px]">
          <p
            data-testid="mcp-server-detail-tool-description"
            className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-foreground/90 text-xs leading-relaxed"
          >
            {tool.description ?? t("mcpServers.noDescription")}
          </p>
          <div data-testid="mcp-server-detail-tool-params" className="flex flex-col gap-1.5">
            <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
              {t("mcpServers.parameters")}
            </span>
            {params.length === 0 ? (
              <span className="text-muted-foreground text-xs">{t("mcpServers.noParameters")}</span>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {params.map((param) => (
                  <li
                    key={param.name}
                    data-required={param.required ? "true" : undefined}
                    className="flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[11px]"
                  >
                    <code className="truncate font-mono" title={param.name}>
                      {param.name}
                    </code>
                    {param.type ? <span className="shrink-0 text-muted-foreground">{param.type}</span> : null}
                    {param.required ? (
                      <span className="shrink-0 text-warning">{t("mcpServers.required")}</span>
                    ) : null}
                  </li>
                ))}
                {tool.paramsOmitted ? (
                  <li className="px-1 py-0.5 text-[11px] text-muted-foreground">
                    {t("mcpServers.moreParameters", { count: tool.paramsOmitted })}
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}
