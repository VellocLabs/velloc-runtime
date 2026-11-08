// An app session's surfaces in the session's A2UI processor (F-40). A new
// build updates the app's surfaces in place, so a component's own state (the
// tab a Tabs shows) and what the person typed or picked are kept; a surface the
// build no longer has is deleted. The data file's value is set under `/data`
// on each surface; a board that carries the patches from the data the surfaces
// hold sets each patched path alone, so only the components bound to it re-render.

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
  /** The `dataSeq` of the board whose data the surfaces hold. */
  const seqRef = useRef<number | undefined>(undefined)
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
    // Whole: drawn from nothing, on the first draw and after chat touched the app.
    let whole = !drawn
    if (epoch !== epochRef.current) {
      epochRef.current = epoch
      if (drawnRef.current) drawnRef.current = { ...drawnRef.current, hash: '' }
      whole = true
    }
    if (surface.hash !== drawnRef.current?.hash) {
      const before = drawnRef.current?.ids ?? []
      // An id new to the app starts from nothing, so a chat surface under it is not continued.
      deleteSurfaces(processor, whole
        ? [...new Set([...before, ...surface.surfaceIds])]
        : [...before.filter(id => !surface.surfaceIds.includes(id)), ...surface.surfaceIds.filter(id => !before.includes(id))])
      let result = compiler.compile(surface.body, state)
      if (!result.ok && !whole) {
        deleteSurfaces(processor, surface.surfaceIds)
        whole = true
        result = compiler.compile(surface.body, state)
      }
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
      // Patches apply only onto the data the surfaces hold: a board the page
      // did not draw (batched away) leaves `from` behind, and the value is set whole.
      const patches = !redrawn && board.dataPatches && seqRef.current !== undefined && board.dataPatches.from === seqRef.current
        ? board.dataPatches.patches
        : undefined
      seqRef.current = board.dataSeq
      if (patches) {
        for (const surfaceId of surface.surfaceIds) {
          for (const patch of patches) {
            processor.processMessages({
              version: A2UI_PROTOCOL_VERSION,
              updateDataModel: { surfaceId, path: `/data${patch.path}`, ...('value' in patch ? { value: patch.value } : {}) },
            } as never)
          }
        }
      } else if (board.data !== undefined || !whole) {
        // No value removes `/data`: the data file is gone. A surface drawn whole has none.
        const value = board.data !== undefined ? { value: board.data } : {}
        for (const surfaceId of surface.surfaceIds) {
          processor.processMessages({
            version: A2UI_PROTOCOL_VERSION,
            updateDataModel: { surfaceId, path: '/data', ...value },
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
