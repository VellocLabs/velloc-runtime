/**
 * Contract: Cloudflare Worker in front of the static-assets deploy. Its one
 * job: error responses carry `Cache-Control: no-store`. `_headers` matches by
 * path only, so the `/*` catch-all's year-long max-age would land on 404s, and
 * a cached 404 for `/v<N>/index.html` bricks a client on that origin (the
 * updater that could repair it runs only in a booted guest).
 *
 * Invoked only for requests no static asset matched (`run_worker_first`
 * unset); success responses pass through untouched. The 404 keeps
 * `Access-Control-Allow-Origin: *` so the About page's cross-origin channel
 * probe can read "not deployed". Shipped beside wrangler.toml in the release
 * artifact. Pinned by src/__tests__/deploy-headers-cache.test.ts.
 */
export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request)
    if (response.status < 400) {
      return response
    }
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
}
