
// Process-wide flag for staff-only behaviour. A value read from settings is
// remembered so re-reading the same stored value does not undo a runtime toggle.
let internalUser = false
let lastAppliedPersisted: boolean | undefined

export function isInternalUser(): boolean {
  return internalUser
}

export function setInternalUser(value: boolean, persisted = false): void {
  internalUser = value
  if (persisted) lastAppliedPersisted = value
}

export function applyPersistedInternalUser(persisted: boolean): void {
  if (persisted === lastAppliedPersisted) return
  lastAppliedPersisted = persisted
  internalUser = persisted
}

export function _resetInternalUserForTests(): void {
  internalUser = false
  lastAppliedPersisted = undefined
}
