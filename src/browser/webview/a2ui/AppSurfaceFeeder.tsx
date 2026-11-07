// An app session's surfaces in the session's A2UI processor (F-40). A new
// build replaces every surface of the app whole; the data file's value is set
// under `/data` on each, so a data change keeps the rest of a surface's state
// (what the person typed or picked).

import { useEffect, useMemo, useRef } from 'react'
import type { ReactCatalogComponent } from '@a2ui/react'
import type { MessageProcessor } from '@a2ui/web_core/v1_0'
import type { AppSurfaceState } from '../../runtimeProtocol/modApps'
import type { A2uiExpressCompiler } from '../../../toolkit/builtin/a2ui/express/a2uiExpressCompiler'
import { A2UI_PROTOCOL_VERSION } from './toA2uiMessages'

type Processor = MessageProcessor<ReactCatalogComponent>

const deleteSurfaces = (processor: Processor, ids: readonly string[]): void => {
  for (const surfaceId of ids) {
    if (!processor.getSurface(surfaceId)) continue
    processor.processMessages({ version: A2UI_PROTOCOL_VERSION, deleteSurface: { surfaceId } } as never)
  }
}

/** The surface ids of an app's latest build, in its order; empty before one. */
export const appSurfaceIds = (board: AppSurfaceState | null | undefined): string[] => board?.surface?.surfaceIds ?? []

export function AppSurfaceFeeder({
  board,
  processor,
  compiler,
  epoch,
}: {
  board: AppSurfaceState | null
  processor: Processor
  compiler: A2uiExpressCompiler
  /** A change redraws the app from its build (chat touched one of its surfaces). */
  epoch: number
}) {
  const state = useMemo(() => compiler.stateFor(processor), [compiler, processor])
  const drawnRef = useRef<{ hash: string; ids: string[] } | null>(null)
  const dataRef = useRef<unknown>(undefined)
  const epochRef = useRef(epoch)

  useEffect(() => {
    const surface = board?.surface ?? null
    const drawn = drawnRef.current
    if (!surface) {
      if (drawn) deleteSurfaces(processor, drawn.ids)
      drawnRef.current = null
      return
    }
    let redrawn = false
    if (epoch !== epochRef.current) {
      epochRef.current = epoch
      if (drawnRef.current) drawnRef.current = { ...drawnRef.current, hash: '' }
    }
    if (surface.hash !== drawnRef.current?.hash) {
      deleteSurfaces(processor, [...new Set([...(drawnRef.current?.ids ?? []), ...surface.surfaceIds])])
      const result = compiler.compile(surface.body, state)
      if (!result.ok) {
        // The runtime built it against the same catalog; a page that still
        // cannot draw it shows nothing rather than part of it.
        console.warn('[a2ui] app build rejected', result.message)
        deleteSurfaces(processor, surface.surfaceIds)
        drawnRef.current = null
        return
      }
      drawnRef.current = { hash: surface.hash, ids: surface.surfaceIds }
      redrawn = true
    }
    if (board && (redrawn || board.data !== dataRef.current)) {
      dataRef.current = board.data
      if (board.data !== undefined) {
        for (const surfaceId of surface.surfaceIds) {
          processor.processMessages({
            version: A2UI_PROTOCOL_VERSION,
            updateDataModel: { surfaceId, path: '/data', value: board.data },
          } as never)
        }
      }
    }
  }, [board, processor, compiler, state, epoch])

  useEffect(
    () => () => {
      if (drawnRef.current) deleteSurfaces(processor, drawnRef.current.ids)
    },
    [processor],
  )

  return null
}
