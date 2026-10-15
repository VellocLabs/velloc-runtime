// The browser tool catalog's prose: the guest copy
// (`src/toolkit/builtin/glic/prompts/browser-catalog.md`) is what the
// `skill.browser.catalog` holder emits and what the runtime's
// `{{TOOL_CATALOG}}` renderer composes. It used to have a C++ twin
// (`browser_tool/browser-tools-catalog.md`) that this test pinned byte for
// byte; that declaration was removed with the C++ prompt-section renderer
// under interface 1, so the guest copy is the only one.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BROWSER_SYSTEM_PROMPT_CATALOG } from '../toolkit/builtin/glic/browserSkillCatalog'

const GUEST_COPY = path.resolve(process.cwd(), 'src/toolkit/builtin/glic/prompts/browser-catalog.md')

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trimEnd()

describe('browser tool catalog — the guest copy', () => {
  it('the guest copy is what the skill catalog holder emits', () => {
    expect(BROWSER_SYSTEM_PROMPT_CATALOG).toBe(read(GUEST_COPY))
  })

  it('carries the one-call-per-turn rule — the CAPABILITY carries it, not a type', () => {
    // It used to live in `agent`'s prompt body, so `code` / `chat` could
    // activate the browser skill and never see it. Now every type that can
    // drive the browser gets it exactly when it can.
    expect(BROWSER_SYSTEM_PROMPT_CATALOG).toContain('One browser tool call per turn')
    // The one clause that lived ONLY in the type-gated holder: without it,
    // "one browser tool call per turn" reads as "emit nothing else either",
    // which would suppress useful batching (a browser call + TodoWrite).
    expect(BROWSER_SYSTEM_PROMPT_CATALOG).toContain(
      'Combining one browser tool with a non-browser tool (TodoWrite, for example) in the same response is fine',
    )
  })
})
