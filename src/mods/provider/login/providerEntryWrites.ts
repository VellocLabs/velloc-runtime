/**
 * Contract: the one queue every read-modify-write of a provider mod's
 * settings entry runs in, per provider id — the sign-in, its refresh,
 * sign-out and `$.provider.setSecrets` alike. Each `write` starts after the
 * one before it settled (a failed one does not stop the queue), so it reads
 * the entry the earlier write left.
 */

const queues = new Map<string, Promise<unknown>>()

export function queueProviderEntryWrite<T>(providerId: string, write: () => Promise<T>): Promise<T> {
  const previous = queues.get(providerId) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(write)
  const tail = run.catch(() => undefined)
  queues.set(providerId, tail)
  void tail.then(() => {
    if (queues.get(providerId) === tail) queues.delete(providerId)
  })
  return run
}
