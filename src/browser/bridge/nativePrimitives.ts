/**
 * Contract: typed wrappers over the additive native primitives (P-3), shipped on
 * interface 1 without a bump, so a guest can meet a host that predates them.
 * - A primitive the host manifest does not list throws
 *   `NativePrimitiveUnsupportedError` WITHOUT calling; so does one an older host
 *   answers `NOT_IMPLEMENTED`.
 * - A variant an older host would silently IGNORE (`writeFile` `ifMatch`,
 *   `shell.spawn` `persist`, `{{secret:NAME}}`) is sent only when the manifest
 *   POSITIVELY lists it.
 * Callers branch on `isNativePrimitiveUnsupported(error)` and fall back.
 */
import type {
  BridgeAlarm,
  BridgeAlarmFire,
  BridgeEventEnvelope,
  BridgeFsIfMatch,
  BridgeFsOnChangePayload,
  BridgeNetworkOnWsClosePayload,
  BridgeNetworkOnWsMessagePayload,
  BridgeNetworkStreamHead,
  BridgeNetworkStreamOpenPayload,
  BridgeNetworkStreamReadResult,
  BridgeSecretName,
  BridgeSecretNamespace,
  BridgeShellOnStreamExitPayload,
  BridgeShellOnStreamOutputPayload,
  BridgeShellPersistentRecord,
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeTransport,
  BrowserHostManifest,
  BridgeWebWindowBounds,
  BridgeWebWindowInfo,
  BridgeWebWindowOnClosedPayload,
  BridgeWebWindowOnNavigatedPayload,
  BridgeWebWindowOnTitleChangedPayload,
  BridgeWebWindowState,
} from './browserBridgeProtocol'
import { createBridgeRoute } from './browserBridgeProtocol'

/** The primitive is not served by this host (manifest, or NOT_IMPLEMENTED). */
export class NativePrimitiveUnsupportedError extends Error {
  override readonly name = 'NotSupportedError'
  constructor(readonly primitive: string, detail?: string) {
    super(
      `${primitive} is not supported by this host${detail ? ` (${detail})` : ''}`,
    )
  }
}

/** The host refused the call. `code` is the bridge error code. */
export class NativePrimitiveError extends Error {
  override readonly name = 'NativePrimitiveError'
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
  }
}

export function isNativePrimitiveUnsupported(
  error: unknown,
): error is NativePrimitiveUnsupportedError {
  return error instanceof NativePrimitiveUnsupportedError
}

/** A compare-and-swap write lost: the file changed since it was read. */
export function isPreconditionFailed(error: unknown): boolean {
  return error instanceof NativePrimitiveError && error.code === 'PRECONDITION_FAILED'
}

export type CreateNativePrimitivesOptions = {
  transport: BrowserBridgeTransport
  createRequestId: () => string
  /**
   * The host manifest. Absent (not known yet, or a host without one):
   * calls go out and NOT_IMPLEMENTED reads as unsupported, but the
   * ignore-if-absent variants are refused.
   */
  manifest?: Pick<BrowserHostManifest, 'capabilities' | 'primitives'>
}

export type FsWatchHandle = {
  watchId: string
  mode: 'native' | 'poll'
  /** Stops the watch and the listener. Idempotent. */
  close(): Promise<void>
}

export type NativeWebSocket = {
  socketId: string
  protocol: string
  /** A string is a text message, bytes a binary one. False when not open. */
  send(message: string | Uint8Array): Promise<boolean>
  close(code?: number, reason?: string): Promise<void>
}

export type NativeWebSocketHandlers = {
  onMessage?: (message: { text?: string; data?: Uint8Array }) => void
  onClose?: (event: Omit<BridgeNetworkOnWsClosePayload, 'socketId'>) => void
}

/** The exit of a `shell.spawnArgvStream` child. */
export type NativeStreamExit = Omit<BridgeShellOnStreamExitPayload, 'streamId'>

export type NativeStreamHandlers = {
  /** Raw bytes as the host pushed them: decode with a streaming decoder. */
  onOutput?: (stream: 'stdout' | 'stderr', data: Uint8Array) => void
  /** Once. No output is delivered after it. */
  onExit?: (exit: NativeStreamExit) => void
}

/** A live `shell.spawnArgvStream` child. Each call answers false once the
 *  host no longer knows the stream (it exited, or its connection went). */
export type NativeStreamChild = {
  streamId: string
  write(data: Uint8Array): Promise<boolean>
  closeStdin(): Promise<boolean>
  kill(): Promise<boolean>
  /** Stop delivering events to the handlers (the child keeps running). */
  detach(): void
}

export type NativePrimitives = ReturnType<typeof createNativePrimitives>

// ---- base64 (the binary WebSocket frames travel as base64) ---------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const SECRET_PLACEHOLDER = '{{secret:'
const OAUTH_PLACEHOLDER = '{{oauth:'

function hasPlaceholder(
  values: Record<string, string> | undefined,
  placeholder: string,
): boolean {
  return !!values && Object.values(values).some(v => v.includes(placeholder))
}

function hasSecretPlaceholder(values: Record<string, string> | undefined): boolean {
  return hasPlaceholder(values, SECRET_PLACEHOLDER)
}

/** True when header / query values carry `{{oauth:NAME}}`. */
export function hasOAuthPlaceholder(values: Record<string, string> | undefined): boolean {
  return hasPlaceholder(values, OAUTH_PLACEHOLDER)
}

function randomClientId(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replace(/-/g, '') ??
    `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`.slice(0, 64)
}

export function createNativePrimitives(options: CreateNativePrimitivesOptions) {
  const { transport, createRequestId, manifest } = options

  /** False only when a manifest is known and does not list it. */
  function mayCall(primitive: string): boolean {
    if (!manifest) return true
    return manifest.primitives?.includes(primitive) ?? false
  }

  /** The ignore-if-absent variants: only with a positive listing. */
  function listed(primitive: string): boolean {
    return manifest?.primitives?.includes(primitive) ?? false
  }

  function capabilityServed(capability: BrowserBridgeCapability): boolean {
    if (!manifest) return true
    return manifest.capabilities.includes(capability)
  }

  async function send<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    primitive: string,
    capability: C,
    action: A,
    payload: BrowserBridgeRequestPayload<C, A>,
  ): Promise<BrowserBridgeResult<C, A>> {
    const response = (await transport.request({
      id: createRequestId(),
      route: createBridgeRoute(capability, action),
      payload,
    })) as
      | { ok: true; result: BrowserBridgeResult<C, A> }
      | { ok: false; error: { code: string; message: string } }
    if (!response.ok) {
      if (response.error.code === 'NOT_IMPLEMENTED') {
        throw new NativePrimitiveUnsupportedError(primitive, response.error.message)
      }
      throw new NativePrimitiveError(response.error.code, response.error.message)
    }
    return response.result
  }

  function requirePrimitive(primitive: string): void {
    if (!mayCall(primitive)) {
      throw new NativePrimitiveUnsupportedError(primitive, 'not in the host manifest')
    }
  }

  function requireListed(primitive: string): void {
    if (!listed(primitive)) {
      throw new NativePrimitiveUnsupportedError(
        primitive,
        'an older host would ignore it; not in the host manifest',
      )
    }
  }

  function requireCapability(capability: BrowserBridgeCapability): void {
    if (!capabilityServed(capability)) {
      throw new NativePrimitiveUnsupportedError(capability, 'capability not advertised')
    }
  }

  function subscribe(
    match: (event: BridgeEventEnvelope) => boolean,
    handler: (event: BridgeEventEnvelope) => void,
    primitive: string,
  ): () => void {
    if (!transport.subscribeEvents) {
      throw new NativePrimitiveUnsupportedError(primitive, 'transport has no events')
    }
    return transport.subscribeEvents(event => {
      if (match(event)) handler(event)
    })
  }

  const isRoute = (event: BridgeEventEnvelope, capability: string, action: string) =>
    event.route.capability === capability && event.route.action === action

  /** A spawn whose env carries `{{secret:NAME}}`: an older host would pass
   *  the placeholder text as the value, so the expansion must be listed. */
  function envSecretsGate(env: Record<string, string> | undefined): void {
    if (hasSecretPlaceholder(env)) requireListed('shell.spawn.secretEnv')
  }

  function secretsGate(
    values: Array<Record<string, string> | undefined>,
    providerId?: string,
  ): void {
    if (values.some(hasSecretPlaceholder)) {
      requireListed('network.secretTemplates')
    }
    if (values.some(hasOAuthPlaceholder)) {
      requireListed('network.oauthTemplates')
      if (!providerId) {
        throw new NativePrimitiveError('INVALID_ARGS', '{{oauth:NAME}} needs a providerId')
      }
    }
  }

  const fs = {
    /**
     * Watch `path`; `listener` gets every coalesced burst. Resolves once the
     * host started the watch. The watch dies with the bridge connection.
     */
    async watch(
      path: string,
      watchOptions: { recursive?: boolean },
      listener: (change: BridgeFsOnChangePayload) => void,
    ): Promise<FsWatchHandle> {
      requirePrimitive('fs.watch')
      // Subscribe BEFORE the call (the id is the host's): buffer until the id
      // is known, then replay only this watch's bursts.
      let watchId: string | null = null
      const early: BridgeFsOnChangePayload[] = []
      const unsubscribe = subscribe(
        event => isRoute(event, 'fs', 'onChange'),
        event => {
          const change = event.payload as BridgeFsOnChangePayload
          if (watchId === null) {
            early.push(change)
          } else if (change.watchId === watchId) {
            listener(change)
          }
        },
        'fs.watch',
      )
      let started: { watchId: string; mode: 'native' | 'poll' }
      try {
        started = await send('fs.watch', 'fs', 'watch', {
          path,
          recursive: watchOptions.recursive,
        })
      } catch (error) {
        unsubscribe()
        throw error
      }
      watchId = started.watchId
      for (const change of early) {
        if (change.watchId === watchId) listener(change)
      }
      let closed = false
      return {
        watchId: started.watchId,
        mode: started.mode,
        async close() {
          if (closed) return
          closed = true
          unsubscribe()
          await send('fs.watch', 'fs', 'unwatch', { watchId: started.watchId })
        },
      }
    },

    async copyFile(src: string, dst: string, copyOptions?: { overwrite?: boolean }) {
      requirePrimitive('fs.copyFile')
      await send('fs.copyFile', 'fs', 'copyFile', {
        src,
        dst,
        overwrite: copyOptions?.overwrite,
      })
    },

    async symlink(target: string, path: string) {
      requirePrimitive('fs.symlink')
      await send('fs.symlink', 'fs', 'symlink', { target, path })
    },

    async readlink(path: string): Promise<string> {
      requirePrimitive('fs.readlink')
      return (await send('fs.readlink', 'fs', 'readlink', { path })).target
    },

    /** False on Windows (a successful no-op). */
    async chmod(path: string, mode: number): Promise<boolean> {
      requirePrimitive('fs.chmod')
      return (await send('fs.chmod', 'fs', 'chmod', { path, mode })).applied
    },

    /**
     * Compare-and-swap write: succeeds only while the file still has
     * `ifMatch`'s size and mtime. A lost race throws a `NativePrimitiveError`
     * with code PRECONDITION_FAILED (`isPreconditionFailed`). Resolves with the
     * new stat — the next call's `ifMatch`.
     */
    async writeFileIfMatch(
      path: string,
      content: Uint8Array,
      ifMatch: BridgeFsIfMatch,
      writeOptions?: { atomic?: boolean },
    ): Promise<BridgeFsIfMatch> {
      requireListed('fs.writeFile.ifMatch')
      const result = await send('fs.writeFile.ifMatch', 'fs', 'writeFile', {
        path,
        content,
        atomic: writeOptions?.atomic,
        ifMatch,
      })
      if (typeof result.mtimeMs !== 'number' || typeof result.size !== 'number') {
        // A host that ignored ifMatch answers a bare {ok:true}; the manifest
        // gate should make this unreachable.
        throw new NativePrimitiveUnsupportedError('fs.writeFile.ifMatch', 'no stat in reply')
      }
      return { mtimeMs: result.mtimeMs, size: result.size }
    },

    async paths() {
      requirePrimitive('fs.paths')
      return send('fs.paths', 'fs', 'paths', {})
    },
  }

  /**
   * Start a streaming child (`shell.spawn` without `persist`) and drive it
   * live: the handlers get this child's raw stdout / stderr bytes and its one
   * exit, and the returned handle writes stdin, closes it, or kills the
   * child. Subscribes BEFORE the spawn (the id is the host's) and replays
   * what arrived for this child before the id was known, so a fast child's
   * first line is never lost. The child dies with the bridge connection.
   */
  async function openStream(
    primitive: string,
    spec: BrowserBridgeRequestPayload<'shell', 'spawn'>,
    handlers: NativeStreamHandlers,
  ): Promise<NativeStreamChild> {
    let streamId: string | null = null
    let exited = false
    const early: BridgeEventEnvelope[] = []
    const deliver = (event: BridgeEventEnvelope): void => {
      if (event.route.action === 'onStreamOutput') {
        const output = event.payload as BridgeShellOnStreamOutputPayload
        handlers.onOutput?.(output.stream, base64ToBytes(output.dataBase64))
        return
      }
      exited = true
      unsubscribe()
      const exit = event.payload as BridgeShellOnStreamExitPayload
      handlers.onExit?.({
        exitCode: exit.exitCode,
        signal: exit.signal,
        timedOut: exit.timedOut,
        killed: exit.killed,
        durationMs: exit.durationMs,
      })
    }
    const unsubscribe = subscribe(
      event =>
        isRoute(event, 'shell', 'onStreamOutput') || isRoute(event, 'shell', 'onStreamExit'),
      event => {
        const id = (event.payload as { streamId?: string } | undefined)?.streamId
        if (streamId === null) {
          early.push(event)
        } else if (id === streamId && !exited) {
          deliver(event)
        }
      },
      primitive,
    )
    let started: BrowserBridgeResult<'shell', 'spawn'>
    try {
      started = await send(primitive, 'shell', 'spawn', spec)
    } catch (error) {
      unsubscribe()
      throw error
    }
    if (!started.streamId) {
      unsubscribe()
      throw new NativePrimitiveError('PROTOCOL', 'spawn answered without a streamId')
    }
    const id = started.streamId
    streamId = id
    for (const event of early) {
      if (exited) break
      if ((event.payload as { streamId?: string } | undefined)?.streamId === id) {
        deliver(event)
      }
    }
    early.length = 0
    return {
      streamId: id,
      async write(data: Uint8Array): Promise<boolean> {
        return (await send(primitive, 'shell', 'writeStdin', { streamId: id, data })).found
      },
      async closeStdin(): Promise<boolean> {
        return (await send(primitive, 'shell', 'closeStdin', { streamId: id })).found
      },
      async kill(): Promise<boolean> {
        return (await send(primitive, 'shell', 'streamKill', { streamId: id })).found
      },
      detach(): void {
        exited = true
        unsubscribe()
      },
    }
  }

  const shell = {
    /** Run `file` with `args` verbatim (no shell) as a live child: see
     *  `openStream`. */
    async spawnArgvStream(
      spec: {
        file: string
        args?: string[]
        cwd?: string
        env?: Record<string, string>
      },
      handlers: NativeStreamHandlers,
    ): Promise<NativeStreamChild> {
      requireListed('shell.spawn.argv')
      envSecretsGate(spec.env)
      return openStream('shell.spawn.argv', spec, handlers)
    },

    /** Run `command` with the named shell as a live child (`shell.spawn`'s
     *  shell form): see `openStream`. The plugin `$.process.spawn` noun. */
    async spawnShellStream(
      spec: {
        shell: 'bash' | 'sh' | 'pwsh' | 'powershell'
        command: string
        cwd?: string
        env?: Record<string, string>
        stdinText?: string
        closeStdin?: boolean
      },
      handlers: NativeStreamHandlers,
    ): Promise<NativeStreamChild> {
      requireCapability('shell')
      envSecretsGate(spec.env)
      return openStream('shell', spec, handlers)
    },

    /** Run `file` with `args` verbatim — no shell. Output streams as the
     *  existing shell.onStreamOutput / onStreamExit events. */
    async spawnArgv(spec: {
      file: string
      args?: string[]
      cwd?: string
      env?: Record<string, string>
      stdinText?: string
      closeStdin?: boolean
    }): Promise<{ streamId: string }> {
      requireListed('shell.spawn.argv')
      envSecretsGate(spec.env)
      const result = await send('shell.spawn.argv', 'shell', 'spawn', spec)
      if (!result.streamId) {
        throw new NativePrimitiveError('PROTOCOL', 'spawn answered without a streamId')
      }
      return { streamId: result.streamId }
    },

    /**
     * Start a child that outlives this connection, appending its output to
     * `logPath`. Either form: `{file, args}` or `{shell, command}`.
     */
    async spawnPersistent(
      spec: (
        | { file: string; args?: string[] }
        | { shell: 'bash' | 'sh' | 'pwsh' | 'powershell'; command: string }
      ) & {
        logPath: string
        cwd?: string
        env?: Record<string, string>
        stdinText?: string
        closeStdin?: boolean
      },
    ): Promise<{ persistentId: string }> {
      requireListed('shell.spawn.persist')
      if ('file' in spec) requireListed('shell.spawn.argv')
      envSecretsGate(spec.env)
      const { logPath, ...rest } = spec
      const result = await send('shell.spawn.persist', 'shell', 'spawn', {
        ...rest,
        persist: { logPath },
      } as BrowserBridgeRequestPayload<'shell', 'spawn'>)
      if (!result.persistentId) {
        throw new NativePrimitiveUnsupportedError(
          'shell.spawn.persist',
          'the host started a connection-bound child',
        )
      }
      return { persistentId: result.persistentId }
    },

    async persistentList(): Promise<BridgeShellPersistentRecord[]> {
      requirePrimitive('shell.persistentList')
      return (await send('shell.persistentList', 'shell', 'persistentList', {})).shells
    },

    async persistentKill(id: string) {
      requirePrimitive('shell.persistentKill')
      return send('shell.persistentKill', 'shell', 'persistentKill', { id })
    },

    /** Browser-process environment variables (null = unset). */
    async env(names: string[]): Promise<Record<string, string | null>> {
      requirePrimitive('shell.env')
      return (await send('shell.env', 'shell', 'env', { names })).values
    },
  }

  const network = {
    async streamOpen(payload: BridgeNetworkStreamOpenPayload): Promise<BridgeNetworkStreamHead> {
      requirePrimitive('network.streamOpen')
      secretsGate([payload.headers, payload.queryParams], payload.providerId)
      return send('network.streamOpen', 'network', 'streamOpen', payload)
    },

    async streamRead(
      streamId: string,
      readOptions?: { waitMs?: number; maxBytes?: number },
    ): Promise<BridgeNetworkStreamReadResult> {
      return send('network.streamOpen', 'network', 'streamRead', {
        streamId,
        waitMs: readOptions?.waitMs,
        maxBytes: readOptions?.maxBytes,
      })
    },

    async streamCancel(streamId: string): Promise<void> {
      await send('network.streamOpen', 'network', 'streamCancel', { streamId })
    },

    /** The secrets gate for `network.httpRequest`: callers that put a
     *  `{{secret:NAME}}` in headers or queryParams check here first. */
    assertSecretTemplatesSupported(): void {
      requireListed('network.secretTemplates')
    },

    /** The `{{oauth:NAME}}` gate for `network.httpRequest` (with a
     *  providerId). */
    assertOAuthTemplatesSupported(): void {
      requireListed('network.oauthTemplates')
    },

    /**
     * Open a WebSocket. Handlers are attached before the open goes out (the
     * id is chosen here), so no message is missed; resolves once open.
     */
    async wsOpen(
      spec: {
        url: string
        protocols?: string[]
        headers?: Record<string, string>
        allowPrivateNetwork?: boolean
      },
      handlers: NativeWebSocketHandlers,
    ): Promise<NativeWebSocket> {
      requirePrimitive('network.wsOpen')
      secretsGate([spec.headers])
      const socketId = randomClientId('ws')
      const unsubscribe = subscribe(
        event =>
          (isRoute(event, 'network', 'onWsMessage') ||
            isRoute(event, 'network', 'onWsClose')) &&
          (event.payload as { socketId?: string })?.socketId === socketId,
        event => {
          if (event.route.action === 'onWsMessage') {
            const message = event.payload as BridgeNetworkOnWsMessagePayload
            handlers.onMessage?.(
              message.dataBase64 !== undefined
                ? { data: base64ToBytes(message.dataBase64) }
                : { text: message.text ?? '' },
            )
            return
          }
          const closed = event.payload as BridgeNetworkOnWsClosePayload
          unsubscribe()
          handlers.onClose?.({
            code: closed.code,
            reason: closed.reason,
            wasClean: closed.wasClean,
          })
        },
        'network.wsOpen',
      )
      let opened: { socketId: string; protocol: string }
      try {
        opened = await send('network.wsOpen', 'network', 'wsOpen', { ...spec, socketId })
      } catch (error) {
        unsubscribe()
        throw error
      }
      return {
        socketId: opened.socketId,
        protocol: opened.protocol,
        async send(message) {
          const payload =
            typeof message === 'string'
              ? { socketId, text: message }
              : { socketId, dataBase64: bytesToBase64(message) }
          return (await send('network.wsOpen', 'network', 'wsSend', payload)).sent
        },
        async close(code, reason) {
          await send('network.wsOpen', 'network', 'wsClose', { socketId, code, reason })
        },
      }
    },
  }

  const secrets = {
    /** `origin` may be omitted only with `processEnv` (a process-only
     *  secret, `shell.spawn` env values alone). */
    async set(
      name: BridgeSecretName,
      value: string,
      origin: string | undefined,
      options: { processEnv?: boolean } = {},
    ): Promise<void> {
      requireCapability('secrets')
      await send('secrets', 'secrets', 'set', {
        name,
        value,
        ...(origin !== undefined ? { origin } : {}),
        ...(options.processEnv ? { processEnv: true } : {}),
      })
    },
    async has(name: BridgeSecretName): Promise<{ exists: boolean; origin?: string }> {
      requireCapability('secrets')
      return send('secrets', 'secrets', 'has', { name })
    },
    async delete(name: BridgeSecretName): Promise<boolean> {
      requireCapability('secrets')
      return (await send('secrets', 'secrets', 'delete', { name })).deleted
    },
    async listNames(namespace?: BridgeSecretNamespace) {
      requireCapability('secrets')
      return (await send('secrets', 'secrets', 'listNames', { namespace })).secrets
    },
  }

  const alarms = {
    async create(
      name: string,
      schedule: { whenMs?: number; periodMs?: number },
    ): Promise<void> {
      requireCapability('alarms')
      await send('alarms', 'alarms', 'create', { name, ...schedule })
    },
    async clear(name: string): Promise<boolean> {
      requireCapability('alarms')
      return (await send('alarms', 'alarms', 'clear', { name })).cleared
    },
    /** The alarms, and the fires queued while no runtime was connected
     *  (drained by the call) — call once at boot. */
    async list(): Promise<{ alarms: BridgeAlarm[]; fired: BridgeAlarmFire[] }> {
      requireCapability('alarms')
      return send('alarms', 'alarms', 'list', {})
    },
    /** Every `alarms.onAlarm` fire. Returns the unsubscribe. */
    onAlarm(listener: (fire: BridgeAlarmFire) => void): () => void {
      requireCapability('alarms')
      return subscribe(
        event => isRoute(event, 'alarms', 'onAlarm'),
        event => listener(event.payload as BridgeAlarmFire),
        'alarms',
      )
    },
  }

  const model = {
    /** The `{{oauth:NAME}}` gate for `model.rawStreamOpen` — the OAuth
     *  providers' raw stream (rawProviderStream.ts) checks it before sending
     *  a placeholder an older host would forward verbatim. */
    assertRawStreamOAuthSupported(): void {
      requireListed('model.rawStreamOpen.oauth')
    },
  }

  const appInfo = {
    /** Memory-pressure purge of renderer / GPU caches (P-3). */
    async purgeRenderCaches(
      payload: BrowserBridgeRequestPayload<'appInfo', 'purgeRenderCaches'> = {},
    ): Promise<BrowserBridgeResult<'appInfo', 'purgeRenderCaches'>> {
      requirePrimitive('appInfo.purgeRenderCaches')
      return send('appInfo.purgeRenderCaches', 'appInfo', 'purgeRenderCaches', payload)
    },
  }

  /** Single-web windows (F-29), owned by this connection. */
  const webWindow = {
    async open(
      url: string,
      options: { state?: BridgeWebWindowState; focus?: boolean } & BridgeWebWindowBounds = {},
    ): Promise<number> {
      requireCapability('webWindow')
      return (await send('webWindow', 'webWindow', 'open', { url, ...options })).windowId
    },
    async close(windowId: number): Promise<void> {
      requireCapability('webWindow')
      await send('webWindow', 'webWindow', 'close', { windowId })
    },
    async list(): Promise<BridgeWebWindowInfo[]> {
      requireCapability('webWindow')
      return (await send('webWindow', 'webWindow', 'list', {})).windows
    },
    async focus(windowId: number): Promise<void> {
      requireCapability('webWindow')
      await send('webWindow', 'webWindow', 'focus', { windowId })
    },
    async setBounds(windowId: number, bounds: BridgeWebWindowBounds): Promise<void> {
      requireCapability('webWindow')
      await send('webWindow', 'webWindow', 'setBounds', { windowId, ...bounds })
    },
    async setState(windowId: number, state: BridgeWebWindowState): Promise<void> {
      requireCapability('webWindow')
      await send('webWindow', 'webWindow', 'setState', { windowId, state })
    },
    async navigate(windowId: number, url: string): Promise<void> {
      requireCapability('webWindow')
      await send('webWindow', 'webWindow', 'navigate', { windowId, url })
    },
    /** False when there is no history entry to go back to. */
    async back(windowId: number): Promise<boolean> {
      requireCapability('webWindow')
      return (await send('webWindow', 'webWindow', 'back', { windowId })).ok
    },
    /** False when there is no history entry to go forward to. */
    async forward(windowId: number): Promise<boolean> {
      requireCapability('webWindow')
      return (await send('webWindow', 'webWindow', 'forward', { windowId })).ok
    },
    async reload(windowId: number): Promise<void> {
      requireCapability('webWindow')
      await send('webWindow', 'webWindow', 'reload', { windowId })
    },
    /** Every main-frame commit in any owned window. Returns the unsubscribe. */
    onNavigated(listener: (event: BridgeWebWindowOnNavigatedPayload) => void): () => void {
      requireCapability('webWindow')
      return subscribe(
        event => isRoute(event, 'webWindow', 'onNavigated'),
        event => listener(event.payload as BridgeWebWindowOnNavigatedPayload),
        'webWindow',
      )
    },
    onTitleChanged(listener: (event: BridgeWebWindowOnTitleChangedPayload) => void): () => void {
      requireCapability('webWindow')
      return subscribe(
        event => isRoute(event, 'webWindow', 'onTitleChanged'),
        event => listener(event.payload as BridgeWebWindowOnTitleChangedPayload),
        'webWindow',
      )
    },
    onClosed(listener: (event: BridgeWebWindowOnClosedPayload) => void): () => void {
      requireCapability('webWindow')
      return subscribe(
        event => isRoute(event, 'webWindow', 'onClosed'),
        event => listener(event.payload as BridgeWebWindowOnClosedPayload),
        'webWindow',
      )
    },
  }

  return { fs, shell, network, secrets, alarms, model, webWindow, appInfo }
}
