import * as React from "react";
import { KeyRoundIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/browser/webview/i18n";
import type { McpAuthControls } from "@/browser/webview/mcpAuthView";
import { useCan } from "@/browser/webview/useCan";

/**
 * Sign-in for one MCP server (F-10), read from `mcpAuth/status`: a Sign in
 * button, the "finish in the window" wait with Cancel, the client id form
 * when the server's authorization service registers no apps, the last error,
 * and Sign out once signed in.
 */
export function McpSignInPanel({ url, auth }: { url: string; auth?: McpAuthControls }) {
  const t = useT();
  const canSignIn = useCan("mcpAuth", "signIn");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const server = auth?.serverState(url);
  const phase = server?.phase ?? "needs-sign-in";

  const run = (work: () => Promise<void>) => {
    setRequestError(null);
    work().catch((error: unknown) => {
      setRequestError(error instanceof Error ? error.message : String(error));
    });
  };

  let body: React.ReactNode;
  if (!auth?.state?.available) {
    body = <p className="text-muted-foreground text-sm">{t("mcpAuth.unavailable")}</p>;
  } else if (phase === "signing-in") {
    body = (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">{t("mcpAuth.signingIn")}</p>
        <Button variant="outline" size="sm" data-testid="mcp-sign-in-cancel" onClick={() => run(() => auth.cancel(url))}>
          {t("mcpAuth.cancel")}
        </Button>
      </div>
    );
  } else if (phase === "signed-in") {
    body = (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">{t("mcpAuth.signedIn")}</p>
        <Button variant="outline" size="sm" data-testid="mcp-sign-out" onClick={() => run(() => auth.signOut(url))}>
          {t("mcpAuth.signOut")}
        </Button>
      </div>
    );
  } else if (!canSignIn) {
    body = <p className="text-muted-foreground text-sm">{t("mcpAuth.notAllowed")}</p>;
  } else if (server?.needsClient) {
    const submit = () => {
      const id = clientId.trim();
      const secret = clientSecret.trim();
      if (!id) return;
      run(() => auth.signIn({ url, clientId: id, ...(secret ? { clientSecret: secret } : {}) }));
    };
    body = (
      <form
        className="flex flex-col gap-3"
        data-testid="mcp-sign-in-client"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="text-sm">{t("mcpAuth.needsClient")}</p>
        {server.redirectUri ? (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t("mcpAuth.redirectUri")}</span>
            <code data-testid="mcp-sign-in-redirect" className="select-all break-all rounded bg-muted px-2 py-1 text-xs">
              {server.redirectUri}
            </code>
          </div>
        ) : null}
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("mcpAuth.clientId")}</span>
          <Input
            data-testid="mcp-sign-in-client-id"
            value={clientId}
            autoComplete="off"
            onChange={(event) => setClientId(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("mcpAuth.clientSecret")}</span>
          <Input
            data-testid="mcp-sign-in-client-secret"
            type="password"
            value={clientSecret}
            autoComplete="off"
            onChange={(event) => setClientSecret(event.target.value)}
          />
        </label>
        <div className="flex justify-end">
          <Button type="submit" size="sm" data-testid="mcp-sign-in" disabled={!clientId.trim()}>
            {t("mcpAuth.signIn")}
          </Button>
        </div>
      </form>
    );
  } else {
    body = (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">{t("mcpAuth.needsSignIn")}</p>
        <Button size="sm" data-testid="mcp-sign-in" onClick={() => run(() => auth.signIn({ url }))}>
          {t("mcpAuth.signIn")}
        </Button>
      </div>
    );
  }

  const error = requestError ?? (phase !== "signing-in" ? server?.lastError : undefined);
  return (
    <section
      data-testid="mcp-sign-in-panel"
      data-phase={phase}
      className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3"
    >
      <div className="flex items-start gap-2">
        <KeyRoundIcon aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">{body}</div>
      </div>
      {error ? (
        <p role="alert" data-testid="mcp-sign-in-error" className="text-destructive text-xs">
          {t("mcpAuth.failed", { reason: error })}
        </p>
      ) : null}
    </section>
  );
}
