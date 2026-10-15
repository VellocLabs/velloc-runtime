import { describe, expect, it } from 'vitest'
import { createLocalBrowserBridgeTransport } from '../browser/bridge/protocol/core'
import {
  BRIDGE_FETCH_MAX_RESPONSE_BYTES,
  BRIDGE_FETCH_TIMEOUT_MS,
  createBridgeBackedFetch,
} from '../pluginHost/bridgeBackedFetch'

/**
 * Plugin / marketplace installs fetch a whole repo tarball through `network.httpGet`; the guest asks the host for
 * a 50 MB response cap, not the 5 MiB `DownloadToString` ceiling.
 */
describe('createBridgeBackedFetch response cap', () => {
  it('asks the host for a cap well above the old 5 MiB DownloadToString ceiling', () => {
    expect(BRIDGE_FETCH_MAX_RESPONSE_BYTES).toBe(50 * 1024 * 1024)
    expect(BRIDGE_FETCH_MAX_RESPONSE_BYTES).toBeGreaterThan(5 * 1024 * 1024)
  })

  it('forwards the 50 MiB cap to network.httpGet and returns a body larger than 5 MiB', async () => {
    let capturedMaxResponseBytes: number | undefined
    let capturedTimeoutMs: number | undefined
    // A body just over the OLD 5 MiB cap — the size class that regressed.
    const bigBody = new Uint8Array(5 * 1024 * 1024 + 100)

    const transport = createLocalBrowserBridgeTransport({
      'network.httpGet': async (payload: {
        url: string
        maxResponseBytes?: number
        timeoutMs?: number
      }) => {
        capturedMaxResponseBytes = payload.maxResponseBytes
        capturedTimeoutMs = payload.timeoutMs
        return {
          status: 200,
          statusText: 'OK',
          finalUrl: payload.url,
          headers: { 'content-type': 'application/gzip' },
          body: bigBody,
        }
      },
    })

    const fetchImpl = createBridgeBackedFetch({
      transport,
      createRequestId: () => 'test-req-1',
    })

    const response = await fetchImpl(
      'https://codeload.github.com/anthropics/claude-plugins-official/tar.gz/refs/heads/main',
      { redirect: 'follow' },
    )

    expect(capturedMaxResponseBytes).toBe(BRIDGE_FETCH_MAX_RESPONSE_BYTES)
    // The host's timeout covers the whole body: long enough for the cap to
    // arrive at 1 Mbit/s (the old 60 s failed a 30 MB tarball on 3 Mbit/s).
    expect(capturedTimeoutMs).toBe(BRIDGE_FETCH_TIMEOUT_MS)
    expect(BRIDGE_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(((BRIDGE_FETCH_MAX_RESPONSE_BYTES * 8) / 1_000_000) * 1000)

    const body = new Uint8Array(await response.arrayBuffer())
    expect(body.byteLength).toBe(bigBody.byteLength)
  })
})
