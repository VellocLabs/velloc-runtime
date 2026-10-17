/**
 * The runtime's provider state as the `requires` gate reads it
 * (`pluginRequirements.ts`): synchronous, no I/O.
 */

import {
  isProviderSetUp,
  modProviderOwner,
  runtimeProviderConfigsLoaded,
} from '../models/drivers/runtimeProviders'
import type { ProviderGateState } from './pluginRequirements'

export function runtimeProviderGate(): ProviderGateState {
  return {
    loaded: runtimeProviderConfigsLoaded(),
    isSetUp: isProviderSetUp,
    owner: modProviderOwner,
  }
}
