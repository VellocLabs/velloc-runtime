import type { AgentWorkerOutboundMessage } from '../../browser/worker/workerProtocol'

/**
 * Records all outbound worker events for assertion in characterization tests.
 */
export class AgentWorkerEventRecorder {
  readonly events: AgentWorkerOutboundMessage[] = []

  emit = (event: AgentWorkerOutboundMessage): void => {
    this.events.push(event)
  }

  types(): string[] {
    return this.events.map(event => event.type)
  }

  eventsOfType<T extends AgentWorkerOutboundMessage['type']>(
    type: T,
  ): Array<Extract<AgentWorkerOutboundMessage, { type: T }>> {
    return this.events.filter(
      (event): event is Extract<AgentWorkerOutboundMessage, { type: T }> =>
        event.type === type,
    )
  }

  last<T extends AgentWorkerOutboundMessage['type']>(
    type: T,
  ): Extract<AgentWorkerOutboundMessage, { type: T }> | undefined {
    return [...this.events]
      .reverse()
      .find(
        (event): event is Extract<AgentWorkerOutboundMessage, { type: T }> =>
          event.type === type,
      )
  }

  clear(): void {
    this.events.length = 0
  }
}
