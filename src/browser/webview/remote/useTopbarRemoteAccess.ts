/**
 * The desktop top bar's remote-access inputs (F-24): the connected-device
 * count and the connect button's link source. Read from the page's shared
 * `remote/state` store, and only by a connection that may read the topic at
 * all (the desktop, a manager). Both are empty unless remote access is on and
 * the Remote access settings section is one this connection may open: the
 * button leads there, and must not land anywhere else.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import { isSettingsSectionVisible } from '../settings/settingsNav'
import type { RemoteConnectSource } from '../topbar/RemoteConnectButton'
import type { CapabilityQuery } from '../useCan'
import { useRemoteAccessView } from './remoteAccessView'

export function useTopbarRemoteAccess(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  capabilities: CapabilityQuery,
  remoteClient: boolean,
): { remoteDeviceCount: number; remoteConnect: RemoteConnectSource | undefined } {
  const { view, connection } = useRemoteAccessView(
    runtimeConnection,
    capabilities.can('remote', 'pairList'),
  )
  const reachable =
    !!view?.access.enabled &&
    isSettingsSectionVisible(
      'remoteAccess',
      capabilities,
      view.access.supported === true,
      undefined,
      remoteClient,
    )
  // The live pairing's id: a new one (Regenerate) re-reads the link.
  const pairingKey =
    view?.pairings.find(p => !p.revoked && p.expiresAt > Date.now())?.pairId ?? null
  const remoteConnect = React.useMemo(
    () =>
      reachable && view && connection
        ? { access: view.access, pairingKey, connection }
        : undefined,
    [reachable, view, connection, pairingKey],
  )
  return { remoteDeviceCount: reachable && view ? view.access.clients : 0, remoteConnect }
}
