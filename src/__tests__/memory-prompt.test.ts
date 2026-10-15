/**
 * `buildMemorySystemPrompt` (`src/memory/memoryPrompt.ts`) returns the behavioral rule lines only: it never reads
 * MEMORY.md or inlines a `## MEMORY.md` section; that content arrives via `loadAutoMemTier`
 * (`memory/instructionFiles.ts`).
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { buildMemorySystemPrompt } from '../memory/memoryPrompt'
import {
  formatMemoryFilesForPrompt,
  instructionPersistenceFallbackPrompt,
  type InstructionDoc,
} from '../memory/instructionFiles'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'

function makeRuntimeConfig(env: Record<string, string> = {}): RuntimeConfig {
  return {
    getEnv: (name: string) => env[name],
    flagOn: (name: string) => {
      const v = env[name]
      return v === '1' || v === 'true' || v === 'yes'
    },
    now: () => 1_700_000_000_000,
    createUUID: () => 'uuid',
    createTimestamp: () => '2026-05-13T00:00:00.000Z',
    getMaxStructuredOutputRetries: () => 5,
  }
}

/**
 * Minimal fs that records every `readFile` call so the test can assert
 * `buildMemorySystemPrompt` doesn't open MEMORY.md.
 */
function makeRecordingFs(
  files: Record<string, string> = {},
): RuntimeFs & { readFileCalls: string[] } {
  const readFileCalls: string[] = []
  const fs: RuntimeFs = {
    ...unconfiguredFs,
    async readFile(path: string): Promise<string> {
      readFileCalls.push(path)
      if (path in files) return files[path]!
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    async mkdir(_path: string): Promise<void> {
      // ensureMemoryDirExists swallows errors; succeed silently.
    },
  }
  return Object.assign(fs, { readFileCalls })
}

afterEach(() => {
  resetProcessFs()
})

describe('buildMemorySystemPrompt — content-vs-instructions split', () => {
  it('returns the behavioral instructions, not MEMORY.md content', async () => {
    const fs = makeRecordingFs({})
    installProcessFs(fs)

    const result = await buildMemorySystemPrompt({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(),
    })

    expect(result).not.toBeNull()
    const prompt = result!

    // The instructions block must be present — this is memoryPrompt's job.
    expect(prompt).toContain('Your memory is a folder of notes at')
    expect(prompt).toContain('## Saving a note')
    expect(prompt).toContain('Two steps, every time:')
    expect(prompt).toContain('1. Write the note to its own file')
    expect(prompt).toContain('2. Add one line for it to `MEMORY.md`')

    // The CONTENT block must NOT be inlined here. Pre-fix, `buildMemorySystemPrompt`
    // appended `## MEMORY.md` followed by either the file body or
    // "No entries have been recorded in MEMORY.md yet."
    expect(prompt).not.toMatch(/^## MEMORY\.md$/m)
    expect(prompt).not.toContain('No entries have been recorded')
  })

  it('does NOT read MEMORY.md from disk', async () => {
    // Plant a MEMORY.md on disk with a sentinel string. If buildMemorySystemPrompt
    // were to inline content (the pre-fix behavior), the sentinel would
    // show up in the returned prompt. It must not.
    const SENTINEL = 'SENTINEL_LINE_MUST_NOT_APPEAR_IN_PROMPT'
    const fs = makeRecordingFs({
      '/home/user/project/.velloc/memory/MEMORY.md': `# MEMORY.md\n\n- [Sentinel](x.md) — ${SENTINEL}`,
    })
    installProcessFs(fs)

    const result = await buildMemorySystemPrompt({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(),
    })

    expect(result).not.toBeNull()
    expect(result!).not.toContain(SENTINEL)

    // And we never opened it. The instruction-file loader is the one allowed to read it.
    const memoryMdReads = fs.readFileCalls.filter(p =>
      p.endsWith('MEMORY.md'),
    )
    expect(memoryMdReads).toEqual([])
  })

  it('returns null when memory is disabled by env var', async () => {
    const fs = makeRecordingFs({})
    installProcessFs(fs)

    const result = await buildMemorySystemPrompt({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        VELLOC_MEMORY: 'off',
      }),
    })

    expect(result).toBeNull()
  })
})

describe('buildMemorySystemPrompt — daily-log mode', () => {
  it('returns the append-only daily-log prompt when memoryMaintenance is "dailyLog"', async () => {
    installProcessFs(makeRecordingFs({}))

    const result = await buildMemorySystemPrompt({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(),
      memorySettings: { memoryMaintenance: 'dailyLog' },
    })

    expect(result).not.toBeNull()
    const prompt = result!
    // Daily-log markers present.
    expect(prompt).toContain("to today's daily log file")
    expect(prompt).toContain('YYYY-MM-DD.md')
    expect(prompt).toContain('it is append-only')
    expect(prompt).toContain('## What to log')
    // The live-index two-step save block belongs to the non-daily-log path only.
    expect(prompt).not.toContain('## Saving a note')
  })

  it('returns the standard two-step prompt for "periodic" / "off"', async () => {
    for (const mode of ['periodic', 'off'] as const) {
      installProcessFs(makeRecordingFs({}))
      const result = await buildMemorySystemPrompt({
        cwd: '/home/user/project',
        runtimeConfig: makeRuntimeConfig(),
        memorySettings: { memoryMaintenance: mode },
      })
      expect(result, `mode=${mode}`).not.toBeNull()
      expect(result!, `mode=${mode}`).toContain('## Saving a note')
      expect(result!, `mode=${mode}`).not.toContain("to today's daily log file")
    }
  })
})

// MEM-E2E-037..040 (unit proxy): the "what NOT to save" guardrails are MODEL
// JUDGMENT, so they can't be asserted deterministically against the scripted
// fake server in e2e. The deterministic proxy is that the PROMPT actually
// instructs the exclusions — this pins the guardrail text that the standard
// memory prompt ships, and documents the one the prompt does NOT cover (secrets).
describe('buildMemorySystemPrompt — "what NOT to save" guardrails reach the prompt', () => {
  it('instructs the model to skip ephemeral + repo-derivable facts (and redirect explicit saves)', async () => {
    installProcessFs(makeRecordingFs({}))
    const result = await buildMemorySystemPrompt({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(),
    })
    expect(result).not.toBeNull()
    const prompt = result!

    expect(prompt).toContain('## Leave out of memory')
    // 039 — repo-derivable structure/paths must not be saved.
    expect(prompt).toContain(
      'Anything you can recover by reading the repository now',
    )
    // 038 — ephemeral/in-progress task state must not be saved.
    expect(prompt).toContain('The state of the task in hand')
    // 037/039 — when the user explicitly asks to save a derivable thing, the
    // model is told to redirect to what's surprising/non-obvious rather than
    // store the derivable fact verbatim.
    expect(prompt).toContain('ask what about it was unexpected or not obvious')
    expect(prompt).toContain('These hold even when the user asks you to save such things')
  })

  // 037 ("don't save my API key"): the exclusions carry an explicit secrets
  // bullet (F-11).
  it('excludes secrets explicitly', async () => {
    installProcessFs(makeRecordingFs({}))
    const result = await buildMemorySystemPrompt({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(),
    })
    const prompt = result!
    expect(prompt).toContain('- Secrets: passwords, tokens, keys, and URLs that grant access.')
  })

  // F-11: "forget" removes the information, not a whole note that
  // holds other facts; recalled facts are checked before use with no opt-out;
  // user notes stay work-relevant and free of negative judgements; examples
  // keep the scope the user gave.
  it('keeps forget granular, verification mandatory and user notes guarded', async () => {
    installProcessFs(makeRecordingFs({}))
    const prompt = (await buildMemorySystemPrompt({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(),
    }))!
    expect(prompt).toContain('remove that information from the note that holds it')
    expect(prompt).toContain('if nothing else is left in the note, delete the file')
    expect(prompt).not.toContain('delete the note and its line in the index')
    expect(prompt).toContain('Before you rely on it:')
    expect(prompt).not.toContain('without checking in this turn')
    expect(prompt).toContain('trust what you see and fix or delete the note')
    expect(prompt).toContain('never record a negative judgement of the user')
    expect(prompt).toContain('bears on the work you do together')
    expect(prompt).toContain('**How to apply:** whenever you are about to add a dependency.')
    expect(prompt).toContain('**How to apply:** whenever you present benchmark results.')
    // Scope limits generalisation; it is not a bar on saving feedback.
    expect(prompt).toContain('is worth saving even when the user did not call it a rule')
    expect(prompt).not.toContain('Only the second becomes a feedback note')
    // Examples record what was said, not an inferred title or motive.
    expect(prompt).toContain('the user handles releases here')
    expect(prompt).not.toContain('release manager')
    expect(prompt).toContain('"not stated" when they gave none; never guess one')
    expect(prompt).toContain('**Why:** partners are certifying against the current API.')
  })
})

/**
 * The prompt's rules for memory versus the instruction files (`AGENTS.md` / `CLAUDE.md`): a checked-in convention
 * belongs in the instruction file; the checked-in file wins; guidance given in a project is project-scoped by
 * default. With auto-memory on they are in `buildMemoryLines`; off, `QueryEngine.fetchPromptContext` appends
 * `instructionPersistenceFallbackPrompt()`. They are not emitted from `formatMemoryFilesForPrompt`.
 */
describe('the instruction-file persistence rules', () => {
  async function promptText(): Promise<string> {
    installProcessFs(makeRecordingFs({}))
    const result = await buildMemorySystemPrompt({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(),
    })
    expect(result).not.toBeNull()
    return result!
  }

  it('rides the memory prompt when auto-memory is on', async () => {
    const prompt = await promptText()
    expect(prompt).toContain('## Memory versus other places to keep things')
    expect(prompt).toContain(
      'Never persist project guidance to a user-global store on your own initiative',
    )
  })

  it('ships on its own when auto-memory is off', async () => {
    // The memory prompt is gone entirely...
    installProcessFs(makeRecordingFs({}))
    const memoryPrompt = await buildMemorySystemPrompt({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(),
      memorySettings: { autoMemoryEnabled: false } as never,
    })
    expect(memoryPrompt).toBeNull()
    // ...but the fallback part carries the instruction-file rules.
    const fallback = instructionPersistenceFallbackPrompt()
    expect(fallback).toContain(
      'Never persist project guidance to a user-global store on your own initiative',
    )
    expect(fallback).toContain('the maintained, checked-in source for how work is done here')
    // With no memory store, nothing may tell the model to save (or weigh) a
    // memory — the memory-on "do both" bullet would be an impossible order.
    expect(fallback).not.toContain('does not discharge the save')
    expect(fallback).not.toMatch(/\bmemory\b/i)
  })

  it('is NOT carried by the instruction-file block, which a file-less session skips', () => {
    // The regression the template goldens caught: with the rules pushed into
    // this block, a session with no instruction files got neither the block
    // nor the rules.
    expect(formatMemoryFilesForPrompt([])).toBe('')
    expect(
      formatMemoryFilesForPrompt([
        {
          path: '/home/user/project/AGENTS.md',
          content: 'Existing project instructions.',
          type: 'Project',
        } as InstructionDoc,
      ]),
    ).not.toContain('does not discharge the save')
  })

  it('tells the model which store a durable convention belongs in', async () => {
    const prompt = await promptText()
    expect(prompt).toContain('a PR or commit template, a test command, a directory rule')
    expect(prompt).toContain("the project's AGENTS.md")
    // A project with only a CLAUDE.md: the model edits that, never shadowing
    // it with a new AGENTS.md.
    expect(prompt).toContain('edit the file that exists')
  })

  it('gives the instruction file precedence when the two disagree', async () => {
    const prompt = await promptText()
    expect(prompt).toContain('the maintained, checked-in source for how work is done here')
    expect(prompt).toContain('update or remove the memory rather than acting on it')
  })

  it('says that writing the guidance into a doc does not discharge the save', async () => {
    const prompt = await promptText()
    expect(prompt).toContain('does not discharge the save')
    expect(prompt).toContain('the memory is what keeps the preference for the next session')
  })

  it('defaults a convention to PROJECT scope, never user-global on its own', async () => {
    const prompt = await promptText()
    expect(prompt).toContain('project-scoped by DEFAULT')
    expect(prompt).toContain(
      'Never persist project guidance to a user-global store on your own initiative',
    )
  })
})

// The memory block's opening line tells the model HOW to write a memory file,
// and it names a tool. That name was hardcoded to `Write`, which only the
// `edit`-group types (agent, chat) register — `code` / `review` / `safe_code`
// mutate through `SuperEdit`, and safe_code has no shell either, so it was told
// to save memories with the one tool it cannot call. The caller now passes the
// name its session actually has; `templateWriteToolName` derives it.
describe('buildMemorySystemPrompt — names the session\'s real write tool', () => {
  async function guidanceLine(writeToolName?: string): Promise<string> {
    installProcessFs(makeRecordingFs({}))
    const prompt = await buildMemorySystemPrompt({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(),
      writeToolName,
    })
    expect(prompt).not.toBeNull()
    const line = prompt!
      .split('\n')
      .find(l => l.includes('The folder already exists'))
    expect(line, 'the dir-exists guidance line').toBeDefined()
    return line!
  }

  it('names Write for the edit-group types', async () => {
    expect(await guidanceLine('Write')).toContain(
      'write notes into it directly with the Write tool',
    )
  })

  it('names SuperEdit for the types that mutate through it', async () => {
    const line = await guidanceLine('SuperEdit')
    expect(line).toContain('write notes into it directly with the SuperEdit tool')
    expect(line).not.toContain('Write tool')
  })

  it('names no tool at all when the session has none', async () => {
    const line = await guidanceLine(undefined)
    expect(line).toContain('write notes into it directly, without creating it')
    expect(line).not.toContain(' tool')
  })

  it('keeps the mkdir guidance whichever tool is named', async () => {
    for (const tool of ['Write', 'SuperEdit', undefined]) {
      expect(await guidanceLine(tool)).toContain(
        'without creating it or checking for it first',
      )
    }
  })
})
