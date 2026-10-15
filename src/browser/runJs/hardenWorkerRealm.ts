/**
 * Security: run_js realm hardening (F-21). Deletes from the worker global the
 * built-ins that bypass the `tools.*` permission gates: network egress (`fetch`,
 * `WebSocket`, `WebSocketStream`, XHR, `EventSource`, `WebTransport`,
 * `navigator.sendBeacon`), origin storage (`navigator.storage`/OPFS, IndexedDB,
 * CacheStorage), `BroadcastChannel`, `importScripts` and nested `Worker`.
 * `WorkerGlobalScope` members are deleted on the global itself; `WorkerNavigator`
 * members live on its prototype, so each removal walks the prototype chain and
 * neutralizes every owner, instance included.
 * Defense-in-depth, not the boundary: dynamic `import()` cannot be deleted and is
 * refused by the sandboxed frame's `default-src 'none'` CSP (opaque `data:`
 * origin); every real capability goes through the kernel data port to the native
 * broker's permission engine. Takes the global as a parameter for unit tests.
 */

/** Globals removed from the run_js realm. Exported so the tool prompt and the
 *  tests state the same list. */
export const RUN_JS_REMOVED_GLOBALS = [
  // network egress
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  // code / worker loading
  'importScripts',
  'Worker',
  // cross-context messaging into the guest app
  'BroadcastChannel',
  // origin storage
  'caches',
  'indexedDB',
] as const

/** Neutralize one OWN property of `target`: prefer `delete`; fall back to
 *  overwriting with `undefined` when the property refuses deletion. */
function neutralizeOwn(target: object, name: string): void {
  try {
    delete (target as Record<string, unknown>)[name]
  } catch {
    /* non-configurable — fall through to defineProperty */
  }
  if (Object.prototype.hasOwnProperty.call(target, name)) {
    try {
      Object.defineProperty(target, name, {
        value: undefined,
        configurable: false,
        writable: false,
      })
    } catch {
      /* nothing more we can do from JS — the broker/native gate still holds */
    }
  }
}

/** Neutralize `name` on `target` AND on every object up its prototype chain
 *  that owns it — a member inherited from a prototype (`WorkerNavigator`) is
 *  otherwise still reachable through that prototype after the instance is
 *  cleaned. If, after the walk, the name still resolves through the chain
 *  (an owner we could not touch), shadow it on the instance as a last resort. */
function neutralize(target: object, name: string): void {
  let obj: object | null = target
  while (obj) {
    if (Object.prototype.hasOwnProperty.call(obj, name)) {
      neutralizeOwn(obj, name)
    }
    obj = Object.getPrototypeOf(obj) as object | null
  }
  if ((target as Record<string, unknown>)[name] !== undefined) {
    try {
      Object.defineProperty(target, name, {
        value: undefined,
        configurable: false,
        writable: false,
      })
    } catch {
      /* nothing more we can do from JS — the broker/native gate still holds */
    }
  }
}

/** Properties removed from the worker's `navigator` (the object itself stays):
 *  `storage` (OPFS, unseen by the fs gate) and `sendBeacon` (egress that survives
 *  deleting fetch/XHR/WebSocket). Both live on `WorkerNavigator.prototype`. */
export const RUN_JS_REMOVED_NAVIGATOR_PROPS = ['storage', 'sendBeacon'] as const

/**
 * Strip the danger surface off `globalObj` (the worker's `self`). Idempotent.
 * Also neutralizes the `navigator` properties listed in
 * `RUN_JS_REMOVED_NAVIGATOR_PROPS` when a navigator is present — on the
 * instance and on every prototype in its chain that owns them.
 */
export function hardenWorkerRealm(globalObj: object): void {
  for (const name of RUN_JS_REMOVED_GLOBALS) {
    neutralize(globalObj, name)
  }
  const navigator = (globalObj as { navigator?: object }).navigator
  if (navigator) {
    for (const name of RUN_JS_REMOVED_NAVIGATOR_PROPS) {
      neutralize(navigator, name)
    }
  }
}
