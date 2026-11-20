// One surface of an app that names the studio catalog (F-1): the app's build
// compiled here, followed by its data and text, handed whole to the surface
// host on every change.

import { useMemo, type ReactElement } from 'react'
import { exportA2UICatalog } from '@copilotkit/react-core/v2/generative-ui'
import type { AppSurfaceState } from '../../../runtimeProtocol/modApps'
import { createStudioExpressCompiler, type StudioExpressCompiler } from '../../../../toolkit/builtin/a2ui/express/studioExpress'
import { A2UI_PROTOCOL_VERSION } from '../toA2uiMessages'
import { studioUI } from './studioCatalog'
import { StudioSurfaceHost, type StudioEvent } from './StudioSurfaceHost'

let shared: StudioExpressCompiler | null = null

function compiler(): StudioExpressCompiler {
  shared ??= createStudioExpressCompiler(exportA2UICatalog(studioUI as never) as Record<string, unknown>)
  return shared
}

function surfaceOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  for (const value of Object.values(message)) {
    const id = typeof value === 'object' && value !== null ? (value as { surfaceId?: unknown }).surfaceId : undefined
    if (typeof id === 'string') return id
  }
  return undefined
}

/**
 * The operations that draw `surfaceId` of the board: its part of the build,
 * then `/data` and `/text`. Empty when the build does not compile here.
 */
export function studioAppOperations(board: AppSurfaceState, surfaceId: string): unknown[] {
  if (!board.surface) return []
  const compiled = compiler().compile(board.surface.body)
  if (!compiled.ok) {
    console.warn('[a2ui] studio build rejected', compiled.message)
    return []
  }
  const operations: unknown[] = compiled.messages.filter(message => surfaceOf(message) === surfaceId)
  if (operations.length === 0) return []
  if (board.text) operations.push({ version: A2UI_PROTOCOL_VERSION, updateDataModel: { surfaceId, path: '/text', value: board.text } })
  if (board.data !== undefined) operations.push({ version: A2UI_PROTOCOL_VERSION, updateDataModel: { surfaceId, path: '/data', value: board.data } })
  return operations
}

export function StudioAppSurface({
  board,
  surfaceId,
  onEvent,
}: {
  board: AppSurfaceState
  surfaceId: string
  onEvent: (event: StudioEvent) => void
}): ReactElement | null {
  const { surface, data, text } = board
  const operations = useMemo(
    () => studioAppOperations({ ...board, surface, data, text }, surfaceId),
    // The board object changes on every publish; these four decide the picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [surface?.hash, data, text, surfaceId],
  )
  if (operations.length === 0) return null
  return <StudioSurfaceHost surfaceId={surfaceId} operations={operations} onEvent={onEvent} />
}

export default StudioAppSurface
