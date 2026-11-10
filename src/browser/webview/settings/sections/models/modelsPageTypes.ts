import type { ProviderConnectionKind } from "../../providerFormHelpers";

/** A pointer drag of a provider row, live from press to release. */
export type ProviderDragState = {
  id: string;
  /** The order at the press: a release on it writes nothing. */
  start: string[];
  preview: string[];
  /** The row the last move swapped with, until the pointer is over the dragged row again. */
  passed: string | null;
  /** Removes the drag's window listeners. */
  detach: () => void;
};

/** A built-in provider's sign-in flow: busy while it runs, plus the device code to show. */
export type OAuthState = {
  busy: boolean;
  userCode?: string;
  verificationUri?: string;
};

/** Which of the page's two views is showing — see the component doc. */
export type PageView = "home" | "edit";

/** A provider listed on the home page. */
export type AddedProviderRow = {
  id: string;
  label: string;
  iconSvg: string | undefined;
  custom: boolean;
  /** Built-ins only — custom providers carry no live verification state. */
  connected: boolean;
  /** The line under the name: subscription, API key, local or custom. */
  kind: ProviderConnectionKind;
};

/** The provider a Remove / Delete confirmation is for. */
export type DeleteTarget = { id: string; name: string; custom: boolean };

export type ProviderStatus = "idle" | "verifying" | "ready" | "draft" | "error";

export type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; modelCount?: number; verifiedAtMs?: number }
  | { status: "failed"; errorCode?: string };
