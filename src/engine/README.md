# engine/ — the turn state-machine contract

These files are the frozen contract between the three owners (T: toolkit,
M: model call, C: turn loop):

- `turnEffects.ts` — `TurnState`, `TurnEvent`, `TurnEffect`, `TurnOutput`,
  `EffectIdentity`, `Transition`, `TurnPolicies`, the `AdvanceTurn` type, and
  the ordering semantics in its header.
- `turnOutcome.ts` — `TurnOutcome` (the ten terminal reasons), `TurnPhase`,
  `TurnConclusion`.
- `extensionSeam.ts` — `TurnExtensions` (the engine's own interface; the mod
  runtime declares `implements TurnExtensions`), `noTurnExtensions()`,
  `agentLoopExtensions(parent, agentId)`.
- `seamTable.ts` — `SEAM_EVENTS`, one row per extension event the engine and
  the toolkit raise (stage, mode, decision / observe, core), and the
  wrappable `ids.next` / `clock.now` seams.
- `../toolkit/toolExtensionSeam.ts` — `ToolCallExtensions`, `noToolExtensions()`.

The contract is **frozen**. A change to any of these types needs sign-off from
all three owners. The behaviour spec is F-26; where this code and the spec
disagree, the spec wins and the code is fixed.

Test fakes for the contract (a fake interpreter, a deterministic interleaving
scheduler, a scripted model, a fake tool runner, `freezeDeep`) live in
`src/__tests__/engine-replay/fakes/`.
