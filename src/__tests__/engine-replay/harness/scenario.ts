import type { Trace } from './trace'

/** One recorded scenario: drives the engine through its public surface and
 *  returns the trace. `check` pins the point of the scenario (which terminal
 *  it reaches, say) so a recording that drifted off its path fails loudly. */
export type Scenario = {
  name: string
  run: () => Promise<Trace>
  check?: (trace: Trace) => void
}
