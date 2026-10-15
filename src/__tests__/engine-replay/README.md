# Engine replay

A differential trace harness for the agent engine (`QueryEngine` in `engine/conversationEngine.ts` and the
request loop in `engine/turnLoop.ts`). Each **scenario** drives the real engine with
scripted outside events — model replies, tool behaviour, permission answers,
lifecycle-hook answers, extension (mods) answers, queued input — and records
everything the engine does in response into a **trace**. The normalized trace
is compared with a **fixture** recorded earlier. Any difference in what the
engine asks for, writes, emits or decides fails the test.

The harness exists so the engine can be restructured with proof that its
behaviour did not move. A fixture records the behaviour as it is today,
**including known quirks** (they are marked "Known quirk, kept" in the
scenario). Fixing a quirk is a behaviour change and goes through a fixture
re-record with a written justification (see below).

## Layout

```
engine-replay/
  replay.test.ts        runs every scenario; records or compares
  normalize.ts          the only differences a replay tolerates
  fixtureStore.ts       fixture paths, record mode, the debug dump
  harness/
    world.ts            engineWorld() / loopWorld(): the engine wired to fakes
    modelBridge.ts      scripted model transport (stream, errors, fallback)
    toolkit/toolRegistry.ts            fake tools built with the real buildTool
    host.ts             fake host: hook commands, settings pushes
    mods.ts             fake extension runtime with scripted answers
    store.ts            in-memory conversation store that records writes
    pipeline.ts         user input layer with the five built-in commands
    timers.ts           retry backoff decided but never waited; fixed jitter
    fs.ts               in-memory file store for tools that save files
    runtime.ts          fixed clock and sequential ids
    trace.ts            the trace shape and message summaries
  scenarios/*.scenario.ts
  fixtures/<scenario-name>.trace.json
```

The fakes stand in only for what is outside the engine: the model transport,
the host, the store, the user input layer and the tools. The engine, the
request loop, the tool batch runner, the permission pipeline, the retry
ladder, compaction, the between-round drain and the lifecycle-hook runner
are the production code.

## What a trace records

| Section         | What it holds                                                          |
| --------------- | ---------------------------------------------------------------------- |
| `modelRequests` | every model transport request, in order (unchanged prompt parts are written as `<same as previous request>`) |
| `modelResponses`| which scripted reply answered which request, and its query source      |
| `transport`     | every transport action (`streamStart`, `streamRead`, `call`, …)        |
| `retryDelays`   | each backoff the retry ladder decided, in milliseconds                 |
| `toolCalls`     | tool start/end with the calls in flight, and context changes applied   |
| `permissions`   | tool permission checks, extension checks, dialog answers               |
| `hooks`         | lifecycle-hook commands run, with their input                          |
| `mods`          | every extension event the engine raised, with its payload              |
| `sessionWrites` | rows added or rewritten in the store, flushes, terminal state, titles  |
| `emitted`       | every message the engine yielded, summarized                           |
| `hostPushes`    | settings pushed to the host                                            |
| `terminal`      | how the turn (or loop) ended                                           |
| `notes`         | input-layer calls, drains, file writes, state read after the run       |

## Running

From `nexus_web/`:

```bash
# compare against the fixtures (the default; part of the normal suite)
npx vitest run src/__tests__/engine-replay

# re-record every fixture
ENGINE_REPLAY_RECORD=1 npx vitest run src/__tests__/engine-replay

# re-record some: -t matches "<file> › <scenario name>"
ENGINE_REPLAY_RECORD=1 npx vitest run src/__tests__/engine-replay -t "permissions"

# write every live trace to a directory before its checks run (debugging)
ENGINE_REPLAY_DUMP=/some/dir npx vitest run src/__tests__/engine-replay -t "cancel"
```

A scenario without a fixture fails in compare mode. A scenario whose scripted
replies do not match the requests made fails in both modes: every request
must have a reply, every reply must be used, and a reply scoped to a query
source must answer a request from that source.

## Normalization

`normalize.ts` is fixed in advance. It is never loosened to make a replay
pass.

1. **Identifiers** become ordinal placeholders in the order they first appear
   in the trace. These are uuids, the runtime's minted ids (`id-<n>`), the
   fallback ids (`uuid-<hex>-<hex>`) and stream ids (`stream-<n>`). The first
   id seen becomes `<id:1>`, and every later occurrence of the same id gets
   the same placeholder. Ids inside a longer string are replaced in place.
2. **Timestamps** are zeroed. ISO-8601 instants become
   `1970-01-01T00:00:00.000Z`. Numeric fields named `timestamp`,
   `deadlineMs`, `startedAt`, `createdAt`, `updatedAt` and
   `askedAtMs` become `0`.
3. **Backoff** is recorded as the delay the retry ladder decided. Nothing
   waits it out, so there is nothing to normalize.

4. **Long texts are stored by digest.** After the steps above, every string
   longer than 120 characters anywhere in the trace (system prompt, context
   blocks, tool descriptions, message content, compaction summaries) is
   written as `{ "digest": "<sha256 hex>", "chars": <length> }`. A fixture
   never holds a long text verbatim, yet equality stays exact: any change to
   such a text changes its digest. Short strings stay readable. Scenario
   checks run on the trace before this step, so they still see the text.
   `ENGINE_REPLAY_DUMP` also writes the trace before this step.

Error messages, execution order and persisted content are **not**
normalized beyond that.

## Adding a scenario

1. Pick the `scenarios/*.scenario.ts` file for the area, or add a new one.
   Every file exports `scenarios: Scenario[]`, and names are unique across
   all files.
2. Build the world with `engineWorld({...})` to drive the whole engine with
   `submit()`, or with `loopWorld({...})` to drive the request loop alone.
   Script the model replies in order. A turn that ends successfully also
   requests a session title, so script a `rename_generate_name` reply after
   it.
3. Add a `check` that states the scenario's point: the terminal reason, a
   request that must or must not carry some text, the order of tool starts.
   The fixture records everything; the check says which part matters.
4. Record only the new scenario with `ENGINE_REPLAY_RECORD=1 … -t "<name>"`.
   Read the fixture, then run the compare mode twice.

Test-only: a scenario must not need a change to production code. If one
does, write the missing hook down in the change description instead of adding it.

## Re-recording fixtures

Recorded fixtures are the behaviour contract. Re-record an existing fixture
only on purpose, and only with a written justification in the change
description. The justification names each fixture that changed and
says why its new behaviour is the intended one. "The replay failed" is not a
justification. A diff in a fixture is a change in what the engine does, and
is read as one.
