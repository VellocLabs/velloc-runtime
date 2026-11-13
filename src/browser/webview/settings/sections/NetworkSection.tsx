import * as React from "react";

import type { BrowserBridgeTransport } from "../../../bridge/browserBridgeProtocol";
import { useT } from "../../i18n";
import type { SettingsPartId } from "../settingsNav";
import { SettingsSubpageLayout } from "../SettingsSubpageLayout";
import { ProxySection } from "./ProxySection";
import {
  RemoteAccessSection,
  type RemoteAccessConnection,
  type RemoteAccessPageState,
} from "./RemoteAccessSection";

/**
 * The Network page (F-18): the host's proxy and remote access, one section
 * each. `parts` is what this connection may see (`visibleNetworkParts`); the
 * page renders only those. Every control on the page acts at once; a setting
 * that needs several fields to be valid is edited in a dialog and saved as a
 * whole.
 */
export function NetworkSection({
  transport,
  parts,
  remoteState,
  remoteConn,
  focusRemoteAccess = false,
}: {
  transport: BrowserBridgeTransport;
  parts: readonly SettingsPartId[];
  remoteState: RemoteAccessPageState | null;
  remoteConn: RemoteAccessConnection | null;
  /** Scroll the Remote access section into view when it first renders. */
  focusRemoteAccess?: boolean;
}) {
  const t = useT();
  const showProxy = parts.includes("proxy");
  const showRemote = parts.includes("remoteAccess");
  const remoteRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (focusRemoteAccess) remoteRef.current?.scrollIntoView?.({ block: "start" });
    // Mount only: a later re-render must not yank the page back here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SettingsSubpageLayout title={t("settings.network.title")}>
      <div data-testid="settings-network" className="flex flex-col">
        {showProxy ? <ProxySection transport={transport} /> : null}
        {showRemote ? (
          <div ref={remoteRef} className={showProxy ? "mt-8" : undefined}>
            <RemoteAccessSection state={remoteState} conn={remoteConn} />
          </div>
        ) : null}
      </div>
    </SettingsSubpageLayout>
  );
}
