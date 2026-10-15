/**
 * Pure helper for the composer's project-folder chip. A locked code session's folder is
 * immutable, so once locked the chip shows the bound folder and ignores transient
 * snapshots reporting another root or "needs a folder". `showOpenCta` is true only for
 * a genuinely unbound session.
 */
export function resolveChipFolder(
  prevRemembered: string | undefined,
  controls: {
    locked: boolean
    needsProjectFolder: boolean
    projectRoot?: string
  },
): {
  remembered: string | undefined
  display: string | undefined
  showOpenCta: boolean
} {
  let remembered = prevRemembered
  // Track the bound folder: follow the live value while the session is still
  // mutable (unlocked); for a locked session capture it once (covers a session
  // resumed already-locked) but never overwrite it afterwards.
  if (!controls.needsProjectFolder && controls.projectRoot) {
    if (!controls.locked || remembered === undefined) {
      remembered = controls.projectRoot
    }
  }
  const display =
    controls.locked && remembered ? remembered : controls.projectRoot
  // A locked session is bound by definition, so never prompt it to open a
  // folder even if a transient snapshot says `needsProjectFolder`. Unlocked →
  // reflect the live flag. Also fall back to the CTA when there is genuinely no
  // folder to show.
  const showOpenCta =
    (!controls.locked && controls.needsProjectFolder) || !display
  return { remembered, display, showOpenCta }
}
