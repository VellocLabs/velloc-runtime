/**
 * SharedWorkerPortHub — connected ports, per-port session and tool-detail subscriptions, the
 * connect/disconnect lifecycle and broadcast to subscribers.
 */

export type PortSubscription = {
  all: boolean
  sessionIds: Set<string>
  toolCallIds: Set<string>
}

export class SharedWorkerPortHub {
  private readonly allPorts = new Set<MessagePort>()
  private readonly subscriptions = new Map<MessagePort, PortSubscription>()
  private readonly toolDetailSubscribers = new Map<string, Set<MessagePort>>()

  connect(port: MessagePort): void {
    this.allPorts.add(port)
  }

  disconnect(port: MessagePort): void {
    this.allPorts.delete(port)
    const sub = this.subscriptions.get(port)
    if (sub) {
      for (const toolCallId of sub.toolCallIds) {
        const subscribers = this.toolDetailSubscribers.get(toolCallId)
        if (subscribers) {
          subscribers.delete(port)
          if (subscribers.size === 0) {
            this.toolDetailSubscribers.delete(toolCallId)
          }
        }
      }
      this.subscriptions.delete(port)
    }
  }

  getOrCreateSubscription(port: MessagePort): PortSubscription {
    let sub = this.subscriptions.get(port)
    if (!sub) {
      sub = { all: false, sessionIds: new Set(), toolCallIds: new Set() }
      this.subscriptions.set(port, sub)
    }
    return sub
  }

  bindPortToSession(port: MessagePort, sessionId: string): void {
    const sub = this.getOrCreateSubscription(port)
    sub.sessionIds.add(sessionId)
  }

  detachSession(port: MessagePort, sessionId: string): void {
    const sub = this.subscriptions.get(port)
    if (sub) {
      sub.sessionIds.delete(sessionId)
      this.deleteSubscriptionIfEmpty(port, sub)
    }
  }

  subscribe(port: MessagePort, all: boolean, sessionIds: string[]): void {
    const sub = this.getOrCreateSubscription(port)
    if (all) sub.all = true
    for (const id of sessionIds) {
      sub.sessionIds.add(id)
    }
  }

  unsubscribe(port: MessagePort, all: boolean, sessionIds: string[]): void {
    const sub = this.subscriptions.get(port)
    if (!sub) return
    if (all) sub.all = false
    for (const id of sessionIds) {
      sub.sessionIds.delete(id)
    }
    this.deleteSubscriptionIfEmpty(port, sub)
  }

  /** Shared empty-record cleanup: every removal
   *  path — session detach, list unsubscribe, tool-detail unsubscribe —
   *  drops a subscription that no longer watches anything, so a
   *  long-lived port can't accrete empty records until disconnect. */
  private deleteSubscriptionIfEmpty(
    port: MessagePort,
    sub: PortSubscription,
  ): void {
    if (!sub.all && sub.sessionIds.size === 0 && sub.toolCallIds.size === 0) {
      this.subscriptions.delete(port)
    }
  }

  subscribeToolDetail(port: MessagePort, toolCallIds: string[]): void {
    const sub = this.getOrCreateSubscription(port)
    for (const id of toolCallIds) {
      sub.toolCallIds.add(id)
      let subscribers = this.toolDetailSubscribers.get(id)
      if (!subscribers) {
        subscribers = new Set()
        this.toolDetailSubscribers.set(id, subscribers)
      }
      subscribers.add(port)
    }
  }

  unsubscribeToolDetail(port: MessagePort, toolCallIds: string[]): void {
    const sub = this.subscriptions.get(port)
    if (!sub) return
    for (const id of toolCallIds) {
      sub.toolCallIds.delete(id)
      const subscribers = this.toolDetailSubscribers.get(id)
      if (subscribers) {
        subscribers.delete(port)
        if (subscribers.size === 0) {
          this.toolDetailSubscribers.delete(id)
        }
      }
    }
    this.deleteSubscriptionIfEmpty(port, sub)
  }

  /** Ports subscribed to a specific session (or all). */
  getSubscribersFor(sessionId: string): MessagePort[] {
    const result: MessagePort[] = []
    for (const [port, sub] of this.subscriptions) {
      if (sub.all || sub.sessionIds.has(sessionId)) {
        result.push(port)
      }
    }
    return result
  }

  /** Ports subscribed to the session list (all). */
  getListSubscribers(): MessagePort[] {
    const result: MessagePort[] = []
    for (const [port, sub] of this.subscriptions) {
      if (sub.all) {
        result.push(port)
      }
    }
    return result
  }

  /** Ports subscribed to a specific tool call detail. Snapshot copy
   *  the live internal Set must not be mutable from
   *  outside the hub. */
  getToolDetailSubscribers(toolCallId: string): Set<MessagePort> {
    return new Set(this.toolDetailSubscribers.get(toolCallId))
  }

  /**
   * Post to one port; a port whose `postMessage` THROWS is dropped from the
   * hub on the spot. A SharedWorker gets no close event for a client port,
   * so a page that went away without `port.disconnect` would otherwise sit
   * in every subscriber set for the realm's life — and a throwing
   * `postMessage` is the one signal such a port ever gives.
   */
  private postOrDrop(port: MessagePort, message: unknown): void {
    try {
      port.postMessage(message)
    } catch {
      this.disconnect(port)
    }
  }

  broadcastToSession(sessionId: string, message: unknown): void {
    for (const port of this.getSubscribersFor(sessionId)) {
      this.postOrDrop(port, message)
    }
  }

  broadcastToListSubscribers(message: unknown): void {
    for (const port of this.getListSubscribers()) {
      this.postOrDrop(port, message)
    }
  }

  broadcastToToolDetailSubscribers(toolCallId: string, message: unknown): void {
    for (const port of this.getToolDetailSubscribers(toolCallId)) {
      this.postOrDrop(port, message)
    }
  }

  get portCount(): number {
    return this.allPorts.size
  }

  dispose(): void {
    this.allPorts.clear()
    this.subscriptions.clear()
    this.toolDetailSubscribers.clear()
  }
}
