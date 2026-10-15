import * as React from "react";
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, LockIcon, SmartphoneIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

import { writeClipboard } from "../../../../utils/clipboard";
import type { RemoteAccessState } from "../../../runtimeHub/remoteAccessDriver";
import type { RemoteState } from "../../../runtimeHub/remoteCapability";
import type { RuntimeConnection } from "../../../runtimeClient/RuntimeConnection";
import { useT } from "../../i18n";
import { describeUserAgent } from "../../remote/userAgentLabel";
import {
  SettingsCard,
  SettingsSection,
  SettingsSubpageLayout,
} from "../SettingsSubpageLayout";

/**
 * Remote access — the settings page for the desktop's embedded relay (F-24). All
 * state comes from the `remote/state` topic and every mutation is a `remote.*`
 * action (P-3). Renders only when the connection may `remote.pairList` AND
 * `access.supported` is true. Security: the listener binds 0.0.0.0; one long-lived
 * pairing per enable, minted by the runtime; nothing is persisted guest-side.
 * "Regenerate access link" (`remote.resetSharing`) kills the old link everywhere.
 */

/** The page's whole read of `remote/state` — exported for the render test. */
export type RemoteAccessPageState = {
  access: RemoteAccessState;
  pairings: RemoteState["pairings"];
  /** The connected devices, one row each. Absent/empty falls back to the
   *  count — an older runtime publishes no rows, and "0 devices" under a
   *  non-zero count would be a worse answer than no list at all. */
  connections?: NonNullable<RemoteState["connections"]>;
};

/** What the section needs from the runtime connection, no more. */
export type RemoteAccessConnection = Pick<RuntimeConnection, "request" | "subscribe">;

type PairingRow = RemoteState["pairings"][number];

/**
 * The one live pairing's URL fragment (`remote.currentPairing`). Security: the
 * published `pairings` deliberately omit the secret.
 */
type CurrentPairing = { pairId: string; fragment: string };

async function readCurrentPairing(
  conn: RemoteAccessConnection,
): Promise<CurrentPairing | null> {
  try {
    const result = await conn.request<CurrentPairing | null>("remote.currentPairing", {});
    if (result && typeof result.fragment === "string" && result.fragment !== "") {
      return result;
    }
    return null;
  } catch {
    // The page degrades to its "no link yet" note rather than erroring.
    return null;
  }
}

/** An address row's display class, decided once and shared by the label and
 *  the sort. */
type AddressKind = "loopback" | "physical" | "virtual";

/**
 * Cosmetic classification of an address for labelling and ordering (the bind is
 * 0.0.0.0 regardless): physical NIC vs virtual adapter, by address prefix and
 * interface name (`vEthernet (…)` is Hyper-V).
 */
function classifyAddress(a: { address: string; interfaceName: string }): AddressKind {
  if (a.address === "127.0.0.1" || a.address === "::1") return "loopback";
  if (a.address.startsWith("172.26.")) return "virtual"; // WSL / Hyper-V
  const name = a.interfaceName.toLowerCase();
  if (
    /(vethernet|wsl|hyper-v|default switch|docker|vmware|virtualbox|vbox|vpn|tailscale|zerotier|wireguard|tunnel|tap|tun)/.test(
      name,
    )
  ) {
    return "virtual";
  }
  return "physical";
}

/** RFC 1918 — the ranges a home or office LAN hands out. A physical NIC on
 *  one of these is the likeliest address another device can reach. */
function isPrivateLan(address: string): boolean {
  if (address.startsWith("192.168.") || address.startsWith("10.")) return true;
  const m = /^172\.(\d+)\./.exec(address);
  return m !== null && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

type LinkRow = {
  address: string;
  interfaceName: string;
  kind: AddressKind;
  url: string;
};

/**
 * Split the candidates into the ONE recommended address (the first physical NIC on
 * a private LAN range, else the first physical NIC) and the rest. No physical NIC →
 * no recommendation.
 */
function splitAddresses(rows: LinkRow[]): {
  recommended: LinkRow | null;
  others: LinkRow[];
} {
  const physical = rows.filter((r) => r.kind === "physical");
  const recommended = physical.find((r) => isPrivateLan(r.address)) ?? physical[0] ?? null;
  const rest = rows.filter((r) => r !== recommended);
  const order: Record<AddressKind, number> = { physical: 0, virtual: 1, loopback: 2 };
  return {
    recommended,
    others: rest.sort((x, y) => order[x.kind] - order[y.kind]),
  };
}

/**
 * How long a device has been connected, in whole minutes/hours — the coarsest
 * unit that still answers "is this the tablet I just picked up, or something
 * that has been on since this morning". Seconds would tick in a list that
 * only republishes when a device joins or leaves, and would be stale the
 * moment it was painted.
 */
function connectedForLabel(
  connectedAt: number,
  now: number,
  t: ReturnType<typeof useT>,
): string {
  const minutes = Math.floor(Math.max(0, now - connectedAt) / 60_000);
  if (minutes < 1) return t("settings.remoteAccess.deviceJustNow");
  if (minutes < 60)
    return t("settings.remoteAccess.deviceForMinutes", { count: minutes });
  return t("settings.remoteAccess.deviceForHours", {
    count: Math.floor(minutes / 60),
  });
}

/**
 * One connected device: the UA's label, else the client kind (never "Unknown
 * device"), then a permission badge and the age — a `manager` device can change this
 * page's settings.
 */
function DeviceRow({
  device,
  now,
}: {
  device: NonNullable<RemoteState["connections"]>[number];
  now: number;
}) {
  const t = useT();
  const described = describeUserAgent(device.userAgent, (browser, os) =>
    t("settings.remoteAccess.deviceBrowserOnOs", { browser, os }),
  );
  // The wire value is an identifier; the user reads a word in their own
  // language. A mode this page predates falls back to the raw value rather
  // than to a wrong one.
  const scopeLabel =
    device.scope === "observe"
      ? t("settings.remoteAccess.deviceScopeObserve")
      : device.scope === "control"
        ? t("settings.remoteAccess.deviceScopeControl")
        : device.scope === "manager"
          ? t("settings.remoteAccess.deviceScopeManager")
          : device.scope;
  return (
    <li
      className="flex items-start gap-2 py-2"
      data-testid="remote-access-device"
      data-scope={device.scope}
    >
      <SmartphoneIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 opacity-70"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm">
          {described ?? t("settings.remoteAccess.deviceUnnamed")}
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="muted" size="sm" data-testid="remote-access-device-scope">
            {scopeLabel}
          </Badge>
          <span className="text-muted-foreground truncate text-xs">
            {t("settings.remoteAccess.deviceConnectedSince", {
              since: connectedForLabel(device.connectedAt, now, t),
            })}
          </span>
        </div>
      </div>
    </li>
  );
}

/** The switch card's text, left of the switch: a live dot + the listener
 *  state on one line, the device count on its own line below. They were one
 *  "Running · 0 devices connected" line, which read as "a remote connection
 *  is running" — the listener being up and a device being on are two facts,
 *  so they get two lines. The card carries no "Remote access" label of its
 *  own: the section heading right above already says it. The named devices
 *  have their own section below. */
function StatusLine({ access }: { access: RemoteAccessState }) {
  const t = useT();
  const listening = access.state === "listening";
  let headline: string;
  switch (access.state) {
    case "listening":
      headline = t("settings.remoteAccess.statusRunning");
      break;
    case "starting":
      headline = t("settings.remoteAccess.statusStarting");
      break;
    case "error":
      headline =
        access.error === "port_in_use"
          ? t("settings.remoteAccess.statusPortInUse", { port: access.port })
          : t("settings.remoteAccess.statusError");
      break;
    default:
      headline = t("settings.remoteAccess.statusOff");
  }
  // The count is the C++ listener's own tally. It stays beside the named
  // devices below: the two disagreeing (a socket accepted but not yet paired)
  // is information, not a bug to hide.
  const devices =
    access.clients === 1
      ? t("settings.remoteAccess.devicesConnectedOne")
      : t("settings.remoteAccess.devicesConnected", { count: access.clients });
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5"
      data-testid="remote-access-status"
      data-state={access.state}
    >
      <div className="flex items-center gap-2 text-sm">
        <span
          aria-hidden
          className={`inline-block size-2 shrink-0 rounded-full ${listening ? "bg-success" : "bg-muted-foreground/40"}`}
        />
        <span className={access.state === "error" ? "text-destructive" : "font-medium"}>
          {headline}
        </span>
      </div>
      {listening ? (
        <p className="pl-4 text-muted-foreground text-sm" data-testid="remote-access-device-count">
          {devices}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A copy button for one link, with its own brief Copied / Copy failed. The
 * recommended address gets the primary, fully-labelled one — copying that
 * link is the page's main action — and every other row a quiet outline one.
 */
function CopyLinkButton({ url, primary = false }: { url: string; primary?: boolean }) {
  const t = useT();
  const [feedback, setFeedback] = React.useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    const ok = await writeClipboard(url);
    setFeedback(ok ? "copied" : "failed");
    setTimeout(() => setFeedback("idle"), 2000);
  };

  return (
    <Button
      variant={primary ? "default" : "outline"}
      size="sm"
      className="shrink-0"
      onClick={() => void copy()}
      data-testid="remote-access-copy-link"
    >
      <CopyIcon className="size-4" />
      {feedback === "copied"
        ? t("settings.remoteAccess.copied")
        : feedback === "failed"
          ? t("settings.remoteAccess.copyFailed")
          : primary
            ? t("settings.remoteAccess.copyLinkPrimary")
            : t("settings.remoteAccess.copyLink")}
    </Button>
  );
}

/**
 * One address's copy row: interface name over `address:port`. Security: the full URL
 * carries the pairing secret, so it is never printed — only the tooltip and the copy.
 */
function AddressLinkRow({
  row,
  port,
  recommended,
}: {
  row: LinkRow;
  port: number;
  recommended: boolean;
}) {
  const t = useT();
  const name =
    row.kind === "loopback"
      ? t("settings.remoteAccess.addressThisDeviceName")
      : row.interfaceName;

  return (
    <div
      className={`flex items-center justify-between gap-4 px-4 ${recommended ? "py-4" : "py-2.5"}`}
      data-testid="remote-access-address-link"
      data-address={row.address}
      data-kind={row.kind}
      data-recommended={recommended ? "true" : undefined}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`truncate ${recommended ? "text-sm" : "text-muted-foreground text-xs"}`}
          >
            {name}
          </span>
          {recommended ? (
            <Badge variant="success" size="sm">
              {t("settings.remoteAccess.recommendedBadge")}
            </Badge>
          ) : null}
        </div>
        <p
          className={`truncate font-mono ${recommended ? "mt-1.5 font-medium text-lg" : "text-sm"}`}
          title={row.url}
          data-testid="remote-access-address-label"
        >
          {`${row.address}:${port}`}
        </p>
      </div>
      <CopyLinkButton url={row.url} primary={recommended} />
    </div>
  );
}

/**
 * A disclosure: a chevron + label that opens `children` below it. Styled as
 * a real control (foreground text, a hover background) rather than a muted
 * footnote — "Other available addresses" hid behind a line that read as
 * decoration. `forceMount` keeps the closed content in the DOM (hidden) — the
 * e2e reads a link's tooltip straight off the page, and a row that exists
 * only while expanded would make that read depend on a click nobody asserted.
 */
function Disclosure({
  label,
  defaultOpen = false,
  testId,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  testId: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="-ml-2 flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-foreground/80 text-sm hover:bg-muted hover:text-foreground"
          data-testid={`${testId}-toggle`}
        >
          {open ? (
            <ChevronDownIcon aria-hidden className="size-4" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-4" />
          )}
          {label}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className="mt-2 data-[state=closed]:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function RemoteAccessSection({
  state,
  conn,
}: {
  /** The published `remote/state` (null until the shell's snapshot lands). */
  state: RemoteAccessPageState | null;
  /** The page's runtime connection, for the `remote.*` actions. */
  conn: RemoteAccessConnection | null;
}) {
  const t = useT();
  const [confirmEnable, setConfirmEnable] = React.useState(false);
  /** The device count the switch-off confirmation names, or null when closed. */
  const [confirmDisable, setConfirmDisable] = React.useState<number | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);
  /** The one pairing's fragment, read once the section is shown enabled. */
  const [currentPairing, setCurrentPairing] = React.useState<CurrentPairing | null>(null);

  const access = state?.access ?? null;
  const pairings = state?.pairings ?? null;
  const connections = state?.connections ?? [];

  const setAccess = React.useCallback(
    async (input: { enabled?: boolean; bindAddress?: string; port?: number }) => {
      if (!conn) return;
      try {
        await conn.request("remote.setAccess", input);
      } catch {
        // The next `remote/state` publish (or the unchanged one) is the
        // authoritative state — the controls simply stay where they were.
      }
    },
    [conn],
  );

  // Read the current pairing's fragment whenever the page is showing an
  // enabled listener and a pairing exists. The read is by connection (the
  // topic never carries the secret), and re-runs when the pairing set changes
  // — a re-enable mints a fresh one.
  const livePairing: PairingRow | null = React.useMemo(() => {
    const list = pairings ?? [];
    const now = Date.now();
    return list.find((p) => !p.revoked && p.expiresAt > now) ?? null;
  }, [pairings]);
  const livePairId = livePairing?.pairId ?? null;
  React.useEffect(() => {
    if (!conn || !access?.enabled || !livePairId) {
      setCurrentPairing(null);
      return;
    }
    let live = true;
    void readCurrentPairing(conn).then((p) => {
      if (live) setCurrentPairing(p);
    });
    return () => {
      live = false;
    };
  }, [conn, access?.enabled, livePairId]);

  if (!access || !conn) {
    return (
      <SettingsSubpageLayout title={t("settings.nav.remoteAccess")}>
        <p className="text-muted-foreground text-sm">{t("settings.loading")}</p>
      </SettingsSubpageLayout>
    );
  }

  const toggle = (next: boolean) => {
    if (next) {
      // First enable goes through the risk confirmation. The
      // notice is persistent; this is the one-time "I understand".
      setConfirmEnable(true);
      return;
    }
    // Turning off drops every connected device on the spot — say so first.
    // With nobody connected there is nothing to lose, so no dialog.
    if (access.clients > 0) {
      setConfirmDisable(access.clients);
      return;
    }
    void setAccess({ enabled: false });
  };

  // The share links: the same pairing's fragment on every reachable address,
  // split into the one recommended address and the rest. The bind is 0.0.0.0
  // — these are display candidates, not a choice.
  const linkRows: LinkRow[] = currentPairing
    ? access.addresses.map((a) => ({
        ...a,
        kind: classifyAddress(a),
        url: `http://${a.address}:${access.port}/#${currentPairing.fragment}`,
      }))
    : [];
  const { recommended, others } = splitAddresses(linkRows);

  const resetLink = async () => {
    setConfirmReset(false);
    try {
      // `remote.resetSharing`, not `pairRevoke` + a mint from here: the
      // runtime owns which pairing is THE sharing one (sharingPairing.ts), and
      // does the revoke and the replacement in one step. The new pairing
      // changes `livePairId`, which re-reads the link above.
      await conn.request("remote.resetSharing", {});
    } catch {
      // The next `remote/state` publish is the authoritative state.
    }
  };

  return (
    <SettingsSubpageLayout
      title={t("settings.remoteAccess.title")}
      description={t("settings.remoteAccess.description")}
    >
      {/* Remote access — the master toggle, with the listener state and the
          device count on their own lines under it. Everything else reveals
          on enable; while off this page is exactly one switch. The page is
          sibling sections (switch · connect · access security · connected
          devices), not one section nesting the rest: each gets its own
          heading and the same air above it. */}
      <div data-testid="remote-access-section">
        <SettingsCard>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            {access.enabled ? (
              <StatusLine access={access} />
            ) : (
              // Off: one plain line, no status block — the e2e reads the
              // status's absence as "the page collapsed to the one switch".
              <p className="text-sm">{t("settings.remoteAccess.statusOff")}</p>
            )}
            <Switch
              checked={access.enabled}
              onCheckedChange={toggle}
              data-testid="remote-access-toggle"
              aria-label={t("settings.remoteAccess.enable")}
            />
          </div>
        </SettingsCard>
      </div>

      {access.enabled ? (
        /* Connect from another device — the page's core. The security model
           IS the link: a device on the network can reach the port, but only
           a valid link opens a session. The page picks the address most
           likely to work and puts it first with the primary copy button;
           every other address keeps its own copy button one click away. */
        <SettingsSection
          title={t("settings.remoteAccess.connectTitle")}
          description={t("settings.remoteAccess.connectDescription")}
        >
          {currentPairing ? (
            <div className="flex flex-col gap-3" data-testid="remote-access-links">
              {recommended ? (
                <SettingsCard>
                  <AddressLinkRow row={recommended} port={access.port} recommended />
                </SettingsCard>
              ) : null}
              {others.length > 0 ? (
                // With no recommendation there is nothing above this to
                // pick, so it starts open rather than hiding every link.
                <Disclosure
                  label={t("settings.remoteAccess.otherAddresses")}
                  defaultOpen={recommended === null}
                  testId="remote-access-other-addresses"
                >
                  <SettingsCard>
                    {others.map((row) => (
                      <AddressLinkRow
                        key={row.address}
                        row={row}
                        port={access.port}
                        recommended={false}
                      />
                    ))}
                  </SettingsCard>
                </Disclosure>
              ) : null}
            </div>
          ) : (
            // The runtime's long-lived-pairing read has not
            // answered — say there is no link yet rather than handing out
            // a dead one.
            <p className="text-muted-foreground text-sm" data-testid="remote-access-no-link">
              {t("settings.remoteAccess.noLinkYet")}
            </p>
          )}
        </SettingsSection>
      ) : null}

      {access.enabled ? (
        /* Access security — the link is the credential; the revoke button lives here
           so a leaked link is killed without turning the listener off. */
        <SettingsSection title={t("settings.remoteAccess.securityTitle")}>
          {/* One tight group: the section gap (gap-4) between the callout,
              the details and the button left them scattered. */}
          <div className="flex flex-col gap-2">
            <div
              className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/40 px-4 py-3"
              data-testid="remote-access-security-note"
            >
              <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0 opacity-70" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="font-medium text-sm">
                  {t("settings.remoteAccess.securityNoteTitle")}
                </p>
                <p className="text-muted-foreground text-sm">
                  {t("settings.remoteAccess.securityNote")}
                </p>
              </div>
            </div>
            <Disclosure
              label={t("settings.remoteAccess.securityDetails")}
              testId="remote-access-security-details"
            >
              <p className="text-muted-foreground text-sm">
                {t("settings.remoteAccess.securityDetailsBody")}
              </p>
            </Disclosure>
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmReset(true)}
                data-testid="remote-access-reset-link"
              >
                {t("settings.remoteAccess.resetLink")}
              </Button>
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {access.enabled &&
      access.state === "listening" &&
      (connections.length > 0 || access.clients === 0) ? (
        /* Connected devices — who is on, by name. An empty list is said
           ("No devices connected") only when the listener's own count agrees
           it is empty: a runtime too old to publish rows sends none while
           devices ARE connected, and "none" under a non-zero count would be
           a worse answer than no list — the count above stands alone then.
           Gated on a RUNNING listener like the count itself: a listener that
           is starting or failed to bind has no devices to list, and "No
           devices connected" under "Port in use" reads as if it were up. */
        <SettingsSection
          title={t("settings.remoteAccess.devicesTitle")}
          testId="remote-access-devices-section"
        >
          {connections.length > 0 ? (
            <SettingsCard>
              <ul className="flex flex-col px-4 py-1" data-testid="remote-access-devices">
                {connections.map((device) => (
                  <DeviceRow key={device.connectionId} device={device} now={Date.now()} />
                ))}
              </ul>
            </SettingsCard>
          ) : (
            <p className="text-muted-foreground text-sm" data-testid="remote-access-devices-empty">
              {t("settings.remoteAccess.devicesEmpty")}
            </p>
          )}
        </SettingsSection>
      ) : null}

      {/* The one-time enable confirmation carries the full plaintext warning —
          the page itself stays clean, the warning shows at the moment of the
          decision (F-24's facts, presented in proportion). */}
      <Dialog open={confirmEnable} onOpenChange={setConfirmEnable}>
        <DialogContent data-testid="remote-access-enable-confirm">
          <DialogHeader>
            <DialogTitle>{t("settings.remoteAccess.confirmEnableTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.remoteAccess.confirmEnableBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmEnable(false)}>
              {t("settings.remoteAccess.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirmEnable(false);
                void setAccess({ enabled: true });
              }}
              data-testid="remote-access-enable-confirm-button"
            >
              {t("settings.remoteAccess.confirmEnableButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Switching off while devices are connected disconnects them — the
          link itself survives, which the body says so the user knows a
          later "on" needs no new link. */}
      <Dialog
        open={confirmDisable !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDisable(null);
        }}
      >
        <DialogContent data-testid="remote-access-disable-confirm">
          <DialogHeader>
            <DialogTitle>{t("settings.remoteAccess.disableConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {confirmDisable === 1
                ? t("settings.remoteAccess.disableConfirmBodyOne")
                : t("settings.remoteAccess.disableConfirmBody", {
                    count: confirmDisable ?? 0,
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDisable(null)}>
              {t("settings.remoteAccess.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmDisable(null);
                void setAccess({ enabled: false });
              }}
              data-testid="remote-access-disable-confirm-button"
            >
              {t("settings.remoteAccess.disableConfirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset link is the one destructive action on the page — confirm it
          so a stray click cannot unpair every device. */}
      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent data-testid="remote-access-reset-confirm">
          <DialogHeader>
            <DialogTitle>{t("settings.remoteAccess.resetConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.remoteAccess.resetConfirmBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
              {t("settings.remoteAccess.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void resetLink()}
              data-testid="remote-access-reset-confirm-button"
            >
              {t("settings.remoteAccess.resetConfirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSubpageLayout>
  );
}
