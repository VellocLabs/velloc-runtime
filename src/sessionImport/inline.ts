/**
 * In-thread execution of an `ImportWorkerRequest` — the single dispatch
 * function both the dedicated Worker entry and the inline fallback call.
 * Every failure becomes an `{ok:false}` response; nothing throws past here.
 */

import {
  ImportConvertError,
  isImportSource,
  type ImportWorkerRequest,
  type ImportWorkerResponse,
} from './protocol'
import { getImportSource } from './sources'

export function runImportRequest(
  request: ImportWorkerRequest,
): ImportWorkerResponse {
  try {
    if (!isImportSource(request.source)) {
      return {
        id: request.id,
        ok: false,
        error: {
          code: 'unknown_source',
          message: `Unknown import source: ${String(request.source)}`,
        },
      }
    }
    const adapter = getImportSource(request.source)
    switch (request.kind) {
      case 'parseLite':
        return { id: request.id, ok: true, result: adapter.parseLite(request.items) }
      case 'convert':
        return {
          id: request.id,
          ok: true,
          result: adapter.convert({
            path: request.path,
            bytes: request.bytes,
            now: request.now,
            subagents: request.subagents ?? [],
          }),
        }
      default: {
        const exhaustive: never = request
        return {
          id: (exhaustive as { id: string }).id,
          ok: false,
          error: { code: 'unknown_kind', message: 'Unknown import request kind' },
        }
      }
    }
  } catch (error) {
    const code = error instanceof ImportConvertError ? error.code : 'convert_failed'
    return {
      id: request.id,
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
