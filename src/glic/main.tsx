import '@/styles/globals.css'
// Self-hosted Geist fonts, imported here (not from globals.css) so Vite emits
// the woff2 files as content-hashed assets.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { readBuildTimeFromDocument, setBuildTime } from '../branding/buildInfo'
import { getProductName } from '../branding/productName'
import { nexusBootAndRender } from '../browser/boot/nexusBoot'
import {
  readRemotePairing,
  reloadOnPairingLink,
  type RemotePairingParse,
} from '../browser/boot/remotePairing'
import { installGuestColorScheme } from '../browser/boot/guestColorScheme'
import { installChunkLoadFailureOverlay } from '../browser/boot/chunkLoadFailure'
import { installGuestTextSize } from '../browser/boot/guestTextSize'
import { installGuestWindowErrorLogging } from '../browser/boot/guestWindowErrors'
import { installHostThemeListener } from '../browser/boot/hostTheme'
import {
  checkUrlInterfaceVersion,
  NEXUS_INTERFACE_VERSION,
} from '../browser/bridge/browserBridgeProtocol'
import { isTraceLogUrlFlagEnabled } from '../utils/traceLogGate'

// Boot mark: module entry begins running, after ES module imports resolved.
declare global {
  // eslint-disable-next-line no-var
  var __nexusBootMarks: Record<string, number> | undefined
}
;(globalThis as { __nexusBootMarks?: Record<string, number> }).__nexusBootMarks = {
  ...((globalThis as { __nexusBootMarks?: Record<string, number> })
    .__nexusBootMarks ?? {}),
  reactModuleStartMs: Date.now(),
}

// Publish the build time, read synchronously from the index.html <meta> (not a
// `define`, which would change chunk hashes on every build).
setBuildTime(readBuildTimeFromDocument())

// Apply the centralized product name to the document title as early as
// possible so users see the host-supplied brand instead of the static
// pre-JS fallback in index.html. The host (custom_browser) passes the
// name via the `?product=` URL query parameter; see
// src/branding/productName.ts.
if (typeof document !== 'undefined') {
  document.title = getProductName()
}

// Before any import() below can fail: a chunk that cannot load stops the
// whole UI behind one overlay with a Reload button (chunkLoadFailure.ts).
if (typeof window !== 'undefined') installChunkLoadFailureOverlay(window)

// Stamp this client's colour scheme before anything paints: the `.dark`
// token set in globals.css is selected solely by this class. 'system' resolves
// against THIS client's (prefers-color-scheme: dark) — a remote browser's OS,
// the desktop panel's OS. See src/browser/boot/guestColorScheme.ts.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  installGuestColorScheme(window, document.documentElement)
  // The chosen type-scale step, stamped before the first paint for the same
  // reason as the colour scheme: `globals.css` derives every `text-prose` /
  // `text-body` size from `<html data-text-size>`. See
  // src/browser/boot/guestTextSize.ts.
  installGuestTextSize(document.documentElement)
  // Live Chrome colours from the host (`nexus-theme` messages, sent after
  // the bridge bootstrap and on every theme change) override the built-in
  // palette token by token. Installed here, before the `nexus-init` ack, so
  // the host's first post cannot be missed. See src/browser/boot/hostTheme.ts.
  installHostThemeListener(window, document.documentElement, (message, details) =>
    console.info('[NexusTrace][GuestEntry]', message, details),
  )
}

function readQueryParam(name: string): string | undefined {
  return new URLSearchParams(window.location.search).get(name) ?? undefined
}

// Uncaught errors and rejections, logged — the browser's ResizeObserver loop
// notice at debug level, as it is not an error (guestWindowErrors.ts).
installGuestWindowErrorLogging(globalThis as unknown as Window)

// The boot welcome is now painted by the parent Chromium WebUI
// (`<nexus-welcome>` rendered by `nexus_view.ts`) so the user sees one
// continuous welcome from open until the React shell signals
// `nexus.ui.showHostLayout`. This guest no longer paints a pre-React
// splash — its container can sit empty while React boots; the parent's
// welcome overlay covers the gap.

function renderError(container: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  container.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:color-mix(in oklab, var(--destructive) 8%, var(--background));color:var(--foreground);font-family:ui-sans-serif,system-ui,sans-serif;">
      <section style="max-width:760px;width:100%;padding:24px 28px;border-radius:24px;background:var(--card);border:1px solid color-mix(in oklab, var(--destructive) 35%, transparent);box-shadow:0 16px 48px oklch(0 0 0 / 8%);display:grid;gap:12px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--destructive);">Boot Failed</div>
        <h1 style="margin:0;font-size:clamp(2rem,5vw,3.25rem);line-height:1.05;">Real bridge host not attached</h1>
        <div style="color:var(--muted-foreground);line-height:1.6;">This page is meant to run inside the app's webview host. The host must send <code>nexus-init</code>, then a <code>nexus-bridge-bootstrap</code> with the SharedWorker port pair so bridge requests can flow.</div>
        <pre style="margin:0;padding:16px;border-radius:16px;background:var(--muted);color:var(--foreground);white-space:pre-wrap;word-break:break-word;font-size:13px;">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
        <div style="color:var(--muted-foreground);line-height:1.6;">For local browser-only testing, use <code>/</code>. For the real host, load <code>/</code> (i.e. <code>index.html</code>) inside the app's webview instead of opening it in a normal tab.</div>
      </section>
    </main>
  `
}

// Hard block for a bridge interface-version mismatch: the page was loaded
// from a `/v<K>/` path whose K differs from this bundle's compiled-in
// NEXUS_INTERFACE_VERSION — the deploy (or a cache/mirror) served the
// wrong bundle at a versioned path. Unlike renderError this is a
// deterministic, terminal state — no retry loop: the fix is updating the
// browser / fixing the deploy and reloading.
function renderVersionBlock(
  container: HTMLElement,
  mismatch: { pathVersion: number; guestVersion: number },
): void {
  const productName = getProductName()
  container.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:color-mix(in oklab, var(--warning) 8%, var(--background));color:var(--foreground);font-family:ui-sans-serif,system-ui,sans-serif;">
      <section style="max-width:760px;width:100%;padding:24px 28px;border-radius:24px;background:var(--card);border:1px solid color-mix(in oklab, var(--warning) 35%, transparent);box-shadow:0 16px 48px oklch(0 0 0 / 8%);display:grid;gap:12px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--warning-emphasis);">Version Mismatch</div>
        <h1 style="margin:0;font-size:clamp(2rem,5vw,3.25rem);line-height:1.05;">${productName} needs an update</h1>
        <div style="color:var(--muted-foreground);line-height:1.6;">The app requested bridge interface <strong>v${mismatch.pathVersion}</strong> (from the page path), but this web build speaks <strong>v${mismatch.guestVersion}</strong>. To avoid silent misbehavior the app will not start across mismatched versions.</div>
        <div style="color:var(--muted-foreground);line-height:1.6;">Update ${productName} to the latest version, then reload this panel. If you self-host the web app, redeploy so the <code>/v${mismatch.pathVersion}/</code> path serves the matching build.</div>
      </section>
    </main>
  `
}

async function main(): Promise<void> {
  const container = document.getElementById('app')
  if (!container) {
    throw new Error('Could not find #app container for the glic entrypoint.')
  }

  // Interface-version tripwire — synchronous, before any host handshake,
  // so it works no matter how the bridge protocol itself evolves. The
  // binary derives the `/v<N>/` path it loads from its own compiled-in
  // constant; if this bundle's constant disagrees with the path it was
  // served at, the two sides speak different bridge contracts. An
  // unversioned path (dev server, frozen root) skips the check — dev
  // drift is caught by the binary's ninja-time gate instead. The
  // diagnostic global mirrors __nexusBootMarks; e2e asserts on it.
  const versionCheck = checkUrlInterfaceVersion(window.location.pathname)
  ;(globalThis as {
    __nexusInterfaceVersions?: { path: number | null; guest: number }
  }).__nexusInterfaceVersions = {
    path: versionCheck.kind === 'unversioned' ? null : versionCheck.pathVersion,
    guest: NEXUS_INTERFACE_VERSION,
  }
  if (versionCheck.kind === 'mismatch') {
    console.error('[GlicEntry] bridge interface version mismatch', versionCheck)
    renderVersionBlock(container, versionCheck)
    return
  }

  // Boot narration — opt-in via the debug URL flags only. The
  // window.error / unhandledrejection handlers above stay ungated:
  // those are error paths that must always reach the console.
  if (isTraceLogUrlFlagEnabled()) {
    console.info('[NexusTrace][GuestEntry] main start', {
      href: window.location.href,
      referrer: document.referrer,
    })
  }

  // The remote fork (F-24): a `#rt=` fragment, a pairing parked in sessionStorage,
  // or one remembered for this listener origin makes this page a remote client
  // (WebSocket boot); `null` is the desktop's own boot.
  const remotePairing: RemotePairingParse | null = readRemotePairing()
  // A link pasted into THIS tab later is a fragment-only navigation (the page
  // already sits at the link's origin + path), which never re-runs the line
  // above — so it reloads instead. Installed for every path: a never-paired
  // page on the bare address falls through to the desktop boot below.
  reloadOnPairingLink()
  if (remotePairing !== null) {
    if (remotePairing.ok) {
      const { remoteBootAndRender } = await import(
        '../browser/boot/remoteBoot'
      )
      await remoteBootAndRender(container, remotePairing.pairing)
    } else {
      // A bad link is a screen, not a boot crash: the remote user cannot see
      // this machine's console, so the reason and the next step render here.
      const { renderRemotePairingError } = await import(
        '../browser/boot/remoteBoot'
      )
      await renderRemotePairingError(container, remotePairing.error)
    }
    return
  }

  await nexusBootAndRender(container, {
    initPayload: {
      cwd: readQueryParam('cwd'),
      projectRoot: readQueryParam('projectRoot'),
      sessionId: readQueryParam('sessionId'),
      sessionStoragePath: readQueryParam('sessionStoragePath'),
      runtimeName: readQueryParam('runtimeName') ?? 'chromium-runtime-glic',
      locale: readQueryParam('locale'),
      timezone: readQueryParam('timezone'),
      userSpecifiedProviderId: readQueryParam('provider'),
      userSpecifiedModel: readQueryParam('model'),
    },
  })
}

void main().catch(error => {
  console.error('[GlicEntry] main() failed', error)
  const container = document.getElementById('app')
  if (!container) {
    throw error
  }
  renderError(container, error)
})
