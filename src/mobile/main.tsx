/**
 * The phone entry of the remote page (F-24): `mobile.html`. Always a remote client — it reads the
 * pairing the way the desktop entry's remote path does, then boots the same connection with the
 * phone shell mounted instead of the desktop one. No pairing renders the link-error screen.
 */
import '@/styles/globals.css'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { readBuildTimeFromDocument, setBuildTime } from '../branding/buildInfo'
import { getProductName } from '../branding/productName'
import { installChunkLoadFailureOverlay } from '../browser/boot/chunkLoadFailure'
import { installGuestColorScheme } from '../browser/boot/guestColorScheme'
import { installGuestTextSize } from '../browser/boot/guestTextSize'
import { installPhoneTypeScale } from '../browser/boot/phoneTypeScale'
import { installGuestWindowErrorLogging } from '../browser/boot/guestWindowErrors'
import { readRemotePairing, reloadOnPairingLink } from '../browser/boot/remotePairing'
import type { ShellComponent } from '../browser/boot/renderShell'

setBuildTime(readBuildTimeFromDocument())
document.title = getProductName()
installChunkLoadFailureOverlay(window)
installGuestColorScheme(window, document.documentElement)
installGuestTextSize(document.documentElement)
installPhoneTypeScale(document.documentElement)
installGuestWindowErrorLogging(globalThis as unknown as Window)

function loadMobileShell(): Promise<ShellComponent> {
  return import('./MobileShell').then(m => m.MobileShell)
}

async function main(): Promise<void> {
  const container = document.getElementById('app')
  if (!container) throw new Error('Could not find #app container for the mobile entrypoint.')

  const pairing = readRemotePairing()
  reloadOnPairingLink()
  const remoteBoot = await import('../browser/boot/remoteBoot')
  if (pairing === null) {
    await remoteBoot.renderRemotePairingError(container, 'malformed')
    return
  }
  if (!pairing.ok) {
    await remoteBoot.renderRemotePairingError(container, pairing.error)
    return
  }
  await remoteBoot.remoteBootAndRender(container, pairing.pairing, loadMobileShell)
}

void main().catch((error: unknown) => {
  console.error('[MobileEntry] main() failed', error)
})
