import * as React from "react";
import { CheckIcon, CircleAlertIcon, PlugIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT, type TranslateFn } from "@/browser/webview/i18n";
import type { SessionMcpServerView } from "@/browser/worker/workerProtocol";

/**
 * The session's MCP servers as a table (F-9, F-10): each settled server with
 * where it is configured, its transport and its status — a failed one with
 * its error. Opened from a Connectors card row; Manage opens the MCP
 * settings page.
 */

function originLabel(server: SessionMcpServerView, t: TranslateFn): string | null {
  switch (server.origin?.kind) {
    case "settings":
      return t("mcpServers.originSettings");
    case "project":
      return t("mcpServers.originProject");
    case "plugin":
      return t("mcpServers.originPlugin", { plugin: server.origin.plugin });
    default:
      return null;
  }
}

export function McpServersDialog({
  open,
  onOpenChange,
  servers,
  folder,
  onManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  servers: readonly SessionMcpServerView[];
  folder?: string;
  onManage?: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="mcp-servers-dialog"
        className="max-w-2xl"
        // Escape closes this dialog only, not the card popover behind it.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          onOpenChange(false);
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("mcpServers.title")}</DialogTitle>
          {folder ? (
            <DialogDescription data-testid="mcp-servers-folder" className="truncate font-mono text-xs">
              {folder}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{t("mcpServers.title")}</DialogDescription>
          )}
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <thead>
              <tr className="border-b text-start text-muted-foreground text-xs">
                <th className="w-[45%] py-2 text-start font-medium">{t("mcpServers.server")}</th>
                <th className="w-[30%] py-2 text-start font-medium">{t("mcpServers.type")}</th>
                <th className="py-2 text-start font-medium">{t("mcpServers.status")}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => {
                const origin = originLabel(server, t);
                const failed = server.status === "failed";
                return (
                  <tr
                    key={server.name}
                    data-testid="mcp-servers-row"
                    data-name={server.name}
                    data-status={server.status}
                    className="border-b align-top last:border-b-0"
                  >
                    <td className="py-2.5 pe-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <PlugIcon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium" title={server.name}>
                          {server.name}
                        </span>
                      </div>
                      {failed && server.error ? (
                        <p
                          data-testid="mcp-servers-error"
                          className="mt-1 ms-6 line-clamp-3 break-words text-destructive text-xs"
                        >
                          {server.error}
                        </p>
                      ) : null}
                    </td>
                    <td className="py-2.5 pe-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        {origin ? (
                          <span data-testid="mcp-servers-origin" className="truncate">
                            {origin}
                          </span>
                        ) : null}
                        {server.transport ? (
                          <Badge variant="muted" size="sm" data-testid="mcp-servers-transport">
                            {server.transport.toUpperCase()}
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2.5">
                      {failed ? (
                        <span className="flex items-center gap-1.5 text-destructive">
                          <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
                          {t("mcpServers.failed")}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <CheckIcon aria-hidden className="size-4 shrink-0" />
                          <span className="sr-only">{t("mcpServers.connected")}</span>
                          {server.toolCount !== undefined ? (
                            <span data-testid="mcp-servers-tools" className="text-muted-foreground">
                              {server.toolCount === 1
                                ? t("mcpServers.toolsOne")
                                : t("mcpServers.toolsMany", { count: server.toolCount })}
                            </span>
                          ) : null}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <DialogFooter className="sm:justify-between">
          {onManage ? (
            <Button
              size="sm"
              data-testid="mcp-servers-manage"
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
          <Button variant="outline" size="sm" data-testid="mcp-servers-done" onClick={() => onOpenChange(false)}>
            {t("mcpServers.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
