// The prose the bundled templates ship: shared and per-type holders, the
// `code` template's coding prompt skeleton, its lean and standard profiles,
// the shared delivering_work holder, and where chat and agent diverge.

import { describe, expect, it } from 'vitest'
import type { PromptProfile } from '../prompting/promptProfile'
import { getHolderProse, getTemplate } from '../prompting/templateRegistry'
import { BROWSER_SYSTEM_PROMPT_CATALOG } from '../toolkit/builtin/glic/browserSkillCatalog'
import { expandGroups } from '../toolkit/builtin/toolGroups'

describe('templateRegistry — holder prose', () => {
  it('returns trimmed holder prose (with inline placeholders intact)', () => {
    // The two inline placeholders: {{AGENT_NAME}} in agent_intro,
    // {{system-prompt-tools}} in the doing-tasks block.
    expect(getHolderProse('agent_intro', { type: 'agent' })).toContain('{{AGENT_NAME}}')
    expect(getHolderProse('agent_doing_tasks', { type: 'agent' })).toContain(
      '{{system-prompt-tools}}',
    )
    // The FINAL REMINDER line is the tail of agent's voice holder (it always
    // sat directly after it) — no holder of its own.
    expect(getHolderProse('agent_tone_and_style', { type: 'agent' })).toMatch(
      /\nFINAL REMINDER:[^\n]*$/,
    )
    expect(getHolderProse('agent_final_reminder', { type: 'agent' })).toBeUndefined()
    // Trimmed: no trailing newline that would double the `\n\n` join.
    expect(getHolderProse('agent_tone_and_style', { type: 'agent' })).not.toMatch(/\n$/)
    // delivering_work (code + safe_code + agent) stays SHARED; the retired
    // thinking_mode resolves to nothing anywhere.
    expect(getHolderProse('delivering_work')).toBeTruthy()
    expect(getHolderProse('thinking_mode')).toBeUndefined()
    expect(getHolderProse('thinking_mode', { type: 'agent' })).toBeUndefined()
  })

  it('every type owns its `# Tools` block as per-type prose', () => {
    // The block used to be host-rendered: the loader swapped `!using_your_tools`
    // for `{ h: 'using-your-tools', args }` and the C++ renderer composed it from
    // `tool-catalog-frame.json`, gating sub-sections on the visible tool set.
    // That shared block could not tell the truth for every type — it told
    // `code` and `safe_code` to "use Edit/Write for file changes" and to
    // "reserve Bash/PowerShell", none of which those types register. Each type
    // now carries its own prose instead, so this asserts the block exists per
    // type and names only tools that type actually has.
    for (const type of ['agent', 'chat', 'code', 'safe_code']) {
      const prose = getHolderProse(`${type}_using_your_tools`, { type })
      expect(prose, `${type} must define its own using-your-tools block`).toBeTruthy()
      expect(prose).toContain('# Tools')
    }
    // The bare name is nobody's holder any more — no shared file, and the
    // loader no longer intercepts it.
    expect(getHolderProse('using_your_tools')).toBeUndefined()

    const proseOf = (type: string): string =>
      getHolderProse(`${type}_using_your_tools`, { type })!
    const eagerOf = (type: string): Set<string> =>
      expandGroups(getTemplate(type)!.config.tools ?? [])

    // The bug the migration fixes: a type with no `edit` group must not be told
    // to use Write/Edit, and a type with no `shell` group must not be told to
    // reserve Bash/PowerShell.
    for (const type of ['code', 'safe_code']) {
      const prose = proseOf(type)
      expect(eagerOf(type), `${type} has no edit group`).not.toContain('Write')
      expect(prose, `${type} must not advertise Write`).not.toMatch(/\bWrite\b/)
      expect(prose, `${type} must not advertise Edit`).not.toMatch(/\bEdit\b/)
      expect(prose, `${type} mutates via SuperEdit`).toContain('SuperEdit')
    }
    // safe_code has no shell, no Skill and no TodoWrite — none may be named.
    const safeCode = proseOf('safe_code')
    for (const absent of ['Bash', 'PowerShell', 'TodoWrite', 'Skill']) {
      expect(safeCode, `safe_code must not name ${absent}`).not.toContain(absent)
    }
    // NO type inlines the browser catalog. It is activation-gated prose — `chat`
    // and `code` defer the browser skill, so the section must appear only after
    // Skill('browser') — which static template text cannot express. It lives on
    // the JS skill-catalog seam instead (toolkit/builtin/glic/browserSkillCatalog.ts,
    // emitted via `$skill_catalogs`), so a copy sitting in a template would be
    // a second, ungated source of the same 89 lines.
    for (const type of ['agent', 'chat', 'code', 'safe_code']) {
      expect(
        proseOf(type),
        `${type} must not inline the browser catalog`,
      ).not.toContain('## Browser tools')
    }
    // No type registers TodoWrite, so no type's prose names it; the step list is the built-in
    // `session_turn` server's, and a chat has none.
    for (const type of ['agent', 'chat', 'code', 'safe_code']) {
      expect(proseOf(type), `${type} has no TodoWrite`).not.toContain('TodoWrite')
    }
    expect(proseOf('chat'), 'chat has no step list').not.toContain('session_turn')
    // chat defers `shell`, so its prose must not lean on a shell that is absent
    // at cold start (it must not describe a tool the model cannot see).
    for (const absent of ['Bash', 'PowerShell']) {
      expect(proseOf('chat'), `chat defers shell — no ${absent}`).not.toContain(absent)
    }
  })
})

describe('code template — coding prompt skeleton and holders', () => {
  // The `code` type's coding prompt comes from per-type holder overrides in
  // src/template/code/includes/*.md. These assertions fail if the overrides
  // are missing (getHolderProse would fall back to the shared
  // browser-flavored holders) or if the skeleton's section order drifts.

  it('skeleton: static sections first, no final_reminder', () => {
    expect(getTemplate('code')!.prompt).toEqual([
      // Type-specific holders carry a `code_` prefix (globally-unique registry
      // name → no collision/shadowing with the shared holders).
      { kind: 'holder', name: 'code_intro' },
      // The shared harness block: `# How this session works` / `# Harness`.
      { kind: 'holder', name: 'system' },
      // The lean profile has no `# Approach to tasks` — gated to standard.
      { kind: 'holder', name: 'code_doing_tasks', profile: 'standard' },
      // Shared caution. Standard: `# Acting carefully` right
      // after `# Approach to tasks`. Lean: the one-paragraph version, further down
      // (after `!pronouns`) — the same holder, listed once per profile.
      { kind: 'holder', name: 'executing_with_care', profile: 'standard' },
      { kind: 'holder', name: 'code_using_your_tools' },
      { kind: 'holder', name: 'turn_board' },
      { kind: 'holder', name: 'child_sessions' },
      // Shared, and `@standard` only: the lean `# Harness` block already
      // says independent tool calls can run in parallel.
      { kind: 'holder', name: 'tool_call_parallelism', profile: 'standard' },
      { kind: 'holder', name: 'code_tone_and_style' },
      // Shared they/them paragraph (was the tail of code_tone_and_style).
      { kind: 'holder', name: 'pronouns' },
      { kind: 'holder', name: 'executing_with_care', profile: 'lean' },
      { kind: 'holder', name: 'delivering_work' },
      // The autonomy block, carried for EVERY provider — shared with
      // safe_code — plus code's own run-a-command paragraph.
      { kind: 'holder', name: 'autonomy' },
      { kind: 'holder', name: 'code_autonomy' },
      { kind: 'dynamic', name: 'skill_catalogs' },
      { kind: 'dynamic', name: 'mcp_servers' },
      { kind: 'dynamic', name: 'session_guidance' },
      { kind: 'dynamic', name: 'environment' },
      { kind: 'dynamic', name: 'memory' },
    ])
    // The code prompt has no final_reminder section.
    const names = getTemplate('code')!.prompt.map(e =>
      'name' in e ? e.name : e.text,
    )
    expect(names).not.toContain('final_reminder')
  })

  it('type-specific holders carry the coding prose, not the shared browser prose', () => {
    const code = (name: string): string => getHolderProse(name, { type: 'code' })!

    // The coding sections now span three holders: `code_intro` (identity
    // + cyber-risk + the URL rule), the SHARED `system`, and
    // `code_doing_tasks` (`# Approach to tasks` + `# Acting carefully`).
    // Together they carry every coding section and none of the browser prose.
    const intro = code('code_intro')
    // intro section: software-engineering framing; nexus branding retained.
    expect(intro).toContain('software engineering work')
    expect(intro).toContain('{{AGENT_NAME}}')
    expect(intro).not.toContain('browser agent running inside')
    // The sections moved OUT of the intro holder.
    expect(intro).not.toContain('# How this session works')
    expect(intro).not.toContain('# Approach to tasks')
    // system section (SHARED): the CommonMark and hooks bullets. The browser
    // credential bullet is NOT shared semantics — it stays with `agent`.
    const system = code('system')
    expect(system).toMatch(/^# How this session works\n/)
    expect(system).toContain('it is rendered as CommonMark')
    expect(system).toContain('Users can set up hooks')
    expect(system).not.toContain('Never carry sensitive data')
    expect(getHolderProse('agent_intro', { type: 'agent' })).toContain(
      'Never carry sensitive data',
    )
    // Velloc's guest renders output in a sans font (styles/globals.css), not
    // monospace, and this block now fronts `chat` too.
    expect(system).not.toContain('monospace')
    // doing_tasks section: coding guidance; no browser placeholder / obstacles.
    const doing = code('code_doing_tasks')
    expect(doing).toMatch(/^# Approach to tasks\n/)
    expect(doing).toContain('OWASP top 10')
    expect(doing).not.toContain('cookie banners')
    expect(doing).not.toContain('{{system-prompt-tools}}')
    // doing_tasks also carries exploratory-question brevity, the
    // UI-verification rule, and the reworked git-safety prose.
    expect(doing).toContain('For exploratory questions')
    expect(doing).toContain('For UI or front-end changes, start the dev server')
    // The git-safety prose lives with the caution section, now shared.
    expect(code('executing_with_care')).toContain(
      'run `git status` before any command that could discard uncommitted work',
    )

    // `code_tone_and_style` = tone_and_style + output_efficiency: coding
    // phrasing, not tab-centric.
    const style = code('code_tone_and_style')
    expect(style).toContain('Your responses should be short and to the point')
    expect(style).not.toContain('background-tab')
    // `# Text output` replaced `# Brevity`.
    expect(style).toContain('# Writing for the user (not tool calls)')
    expect(style).not.toContain('# Brevity')
    expect(style).not.toContain('multiple tabs')
  })

  it('code and agent own DISTINCT, prefixed intros — no bare shared `intro`, no cross-leak', () => {
    // The browser-flavored prose now lives in agent_intro (moved out of
    // shared_includes/); the coding prose in code_intro. Distinct globally-
    // unique names → the type-blind C++ registry can't confuse them.
    expect(getHolderProse('agent_doing_tasks', { type: 'agent' })).toContain(
      '{{system-prompt-tools}}',
    )
    expect(getHolderProse('agent_intro', { type: 'agent' })).toContain('browser agent running inside')
    expect(getHolderProse('agent_doing_tasks', { type: 'agent' })).toContain('cookie banners')
    expect(getHolderProse('code_intro', { type: 'code' })).toContain('software engineering work')
    // No bare shared `intro` remains, under any type.
    expect(getHolderProse('intro')).toBeUndefined()
    expect(getHolderProse('intro', { type: 'chat' })).toBeUndefined()
    expect(getHolderProse('intro', { type: 'code' })).toBeUndefined()
    // A type can't borrow another type's prefixed holder.
    expect(getHolderProse('agent_intro', { type: 'code' })).toBeUndefined()
    expect(getHolderProse('code_intro', { type: 'agent' })).toBeUndefined()
  })
})

describe('code template — prompt profiles (lean vs standard)', () => {
  // The code prompt has two PROFILES: the LEAN `# Harness` prompt, rendered
  // only for catalog rows that declare `promptProfile: 'lean'`, and the
  // STANDARD sections for everything else. `code_*-lean.md` = lean, the base
  // files = standard. The loader passes the per-turn `promptProfile`, so
  // `getHolderProse` with `profile: 'lean'` must pick the variant and
  // `'standard'` (or no profile) must fall back to the base file.
  const base = (name: string, profile?: PromptProfile): string | undefined =>
    getHolderProse(name, profile ? { type: 'code', profile } : { type: 'code' })

  it('standard (or no profile): the static sections', () => {
    for (const profile of [undefined, 'standard'] as const) {
      // The static sections span three holders since the `# How this session works` block
      // became shared: intro (identity) → `system` → `code_doing_tasks`.
      expect(base('code_intro', profile), `profile=${profile}`).not.toContain('# ')
      expect(base('system', profile)).toContain('# How this session works')
      expect(base('system', profile)).not.toContain('# Harness')
      const doing = base('code_doing_tasks', profile)!
      expect(doing).toContain('# Approach to tasks')
      // The caution is its own SHARED holder, carrying the union of the
      // examples `code` and `agent` used to list separately.
      expect(doing).not.toContain('# Acting carefully')
      const care = base('executing_with_care', profile)!
      expect(care).toMatch(/^# Acting carefully\n/)
      expect(care).toContain('measure twice, cut once')
      expect(care).toContain('Submitting a form that makes a payment')
      const tools = base('code_using_your_tools', profile)!
      expect(tools).toContain('over Bash or PowerShell when one fits')
      expect(tools).toContain('SuperEdit')
      expect(tools).not.toContain('TodoWrite')
      // The parallel-tool-call paragraph is SHARED — one file, four types.
      expect(tools).not.toContain('You can make several tool calls in one response')
      expect(base('tool_call_parallelism', profile)).toContain(
        'You can make several tool calls in one response',
      )
      // The `/<skill-name>` bullet moved to the `# Subagents and skills` section.
      expect(tools).not.toContain('/<skill-name>')
      const style = base('code_tone_and_style', profile)!
      expect(style).toContain('# Style')
      expect(style).toContain('# Writing for the user (not tool calls)')
      expect(style).not.toContain('use they/them') // → shared `pronouns`
      expect(style).not.toMatch(/^# Writing for the user$/m)
      expect(base('pronouns', profile)).toContain('use they/them')
      // The autonomy block is profile-INDEPENDENT: Velloc carries it for
      // every model.
      expect(base('autonomy', profile)).toContain('Before you end a turn, reread your final paragraph')
      expect(base('code_autonomy', profile)).toContain('Before a command that changes system state')
    }
  })

  it('the beta tool block names SuperShell, never the sealed Bash/PowerShell', () => {
    // `code_supershell_tools` is the tool block for a code manifest that seals
    // the raw shell and lists `supershell` in place of `code_using_your_tools`
    // (no bundled manifest names it today — the beta trial was retired, the
    // prose kept). It must send the model to SuperShell and never promise a
    // direct Bash/PowerShell tool the sealed group hides.
    for (const profile of [undefined, 'standard', 'lean'] as const) {
      const prose = getHolderProse('code_supershell_tools', { type: 'code', profile })!
      expect(prose).toBeTruthy()
      expect(prose).toContain('# Tools')
      expect(prose).toContain('SuperShell')
      expect(prose).toContain('there is no separate Bash or PowerShell tool')
      expect(prose).toContain('SuperEdit')
    }
    // Standard carries the full guidance; lean drops the lead-in line.
    const std = getHolderProse('code_supershell_tools', { type: 'code', profile: 'standard' })!
    expect(std).toContain('over SuperShell when one fits')
    expect(std).not.toContain('TodoWrite')
    const lean = getHolderProse('code_supershell_tools', { type: 'code', profile: 'lean' })!
    expect(lean).not.toContain('Prefer dedicated tools over SuperShell')
    expect(lean).not.toContain('TodoWrite')
  })

  it('a holder with no -lean file renders its base prose under the lean profile too', () => {
    // Only three code holders carry a `-lean.md`; every other holder must
    // fall back to its base file rather than vanish from the lean prompt.
    expect(base('code_autonomy', 'lean')).toBe(base('code_autonomy', 'standard'))
    expect(getHolderProse('delivering_work', { type: 'code', profile: 'lean' })).toBe(
      getHolderProse('delivering_work', { type: 'code' }),
    )
  })

  it('safe_code shares the autonomy block and skips the run-a-command paragraph; agent merges its two new rules', () => {
    // One SHARED `autonomy` holder (shared_includes/) for code + safe_code;
    // the run-a-command paragraph is code's own `code_autonomy` tail.
    const safe = getHolderProse('autonomy', { type: 'safe_code' })!
    expect(safe).toContain('You are working unattended')
    expect(safe).toContain('Before you end a turn, reread your final paragraph')
    expect(safe).toContain('A long context or session is no reason to stop')
    // SafeCode never runs a command — that paragraph would contradict its boundary.
    expect(safe).not.toContain('Before a command that changes system state')
    expect(getHolderProse('safe_code_autonomy', { type: 'safe_code' })).toBeUndefined()
    expect(getHolderProse('code_autonomy', { type: 'safe_code' })).toBeUndefined()
    const code = getHolderProse('code_autonomy', { type: 'code' })!
    expect(code).toContain('Before a command that changes system state')
    expect(code).not.toContain('You are working unattended')
    // Skeleton: right after delivering_work, same slot as `code`; safe_code
    // ends its holders there.
    const names = getTemplate('safe_code')!.prompt.map(e => ('name' in e ? e.name : e.text))
    expect(names.indexOf('autonomy')).toBe(names.indexOf('delivering_work') + 1)
    expect(names).not.toContain('code_autonomy')
    // agent keeps its own `# Autonomy` holder (browser-flavored) and gains only
    // its two new rules — not the "user is not watching" paragraph,
    // which is wrong for a browser session that must pause on login walls.
    const agent = getHolderProse('agent_autonomy', { type: 'agent' })!
    expect(agent).toContain('Before you end a turn, reread your final paragraph')
    expect(agent).toContain('your assessment is the deliverable')
    expect(agent).not.toContain('The user is not watching in real time')
    expect(getHolderProse('agent_autonomy', { type: 'code' })).toBeUndefined()
  })

  it('lean: Harness + Communicating with the user + action caution + autonomy', () => {
    const intro = base('code_intro', 'lean')!
    expect(intro).toContain('{{AGENT_NAME}}')
    expect(intro).toContain('Help with authorized security testing')
    // The lean intro carries no section of its own …
    expect(intro).not.toContain('# ')
    // … `# Harness` is the SHARED system holder's lean rendering, and every
    // type that references `!system` gets it.
    const harness = base('system', 'lean')!
    expect(harness).toMatch(/^# Harness\n/)
    expect(harness).toContain('Mid-conversation system turns')
    expect(harness).not.toContain('# How this session works')
    expect(base('system', 'standard')).toMatch(/^# How this session works\n/)
    // The lean profile has no `# Approach to tasks`: the holder is gated to standard.
    expect(
      getTemplate('code')!.prompt.find(
        e => e.kind === 'holder' && e.name === 'code_doing_tasks',
      ),
    ).toEqual({ kind: 'holder', name: 'code_doing_tasks', profile: 'standard' })
    // Lean has no tool block; only the Nexus SuperEdit bullet is kept.
    const tools = base('code_using_your_tools', 'lean')!
    expect(tools).toContain('SuperEdit')
    expect(tools).not.toContain('Prefer dedicated tools over Bash')
    expect(tools).not.toContain('TodoWrite')
    const style = base('code_tone_and_style', 'lean')!
    expect(style).toContain('# Writing for the user')
    expect(style).toContain('Open with the outcome')
    expect(style).not.toContain('use they/them') // → shared `pronouns`
    expect(style).not.toContain('Report results truthfully') // → lean-only caution
    expect(style).not.toContain('# Style')
    expect(style).not.toContain('# Writing for the user (not tool calls)')
    expect(base('pronouns', 'lean')).toContain('use they/them')
    const care = base('executing_with_care', 'lean')!
    expect(care).toContain('Before an action that is hard to undo or that others will see, get confirmation')
    expect(care).toContain('Report results as they are')
    // The lean rendering is the short paragraph, not the standard section.
    expect(care).not.toContain('# Acting carefully')
    const autonomy = base('autonomy', 'lean')!
    expect(autonomy).toContain('You are working unattended')
    expect(autonomy).toContain('Before you end a turn, reread your final paragraph')
    expect(autonomy).toContain('A long context or session is no reason to stop')
  })

  it('the shared system holder describes the chat surface and the local machine in both profiles', () => {
    for (const profile of ['standard', 'lean'] as const) {
      const system = base('system', profile)!
      expect(system).toContain('desktop app')
      expect(system).toContain('chat pane')
      expect(system).toContain('busy with something else')
      expect(system).toContain('permission request')
      expect(system).toContain('waits until they get to it')
      expect(system).toContain("the user's own computer")
      expect(system).toContain('no separate copy in between')
      // Whether the directory is a git repository is the `# Environment` block's to say.
      expect(system).not.toMatch(/\bgit\b/)
    }
    // Every type that references `!system` carries the bullets.
    for (const type of ['code', 'agent', 'chat', 'team']) {
      expect(
        getTemplate(type)!.prompt.some(e => e.kind === 'holder' && e.name === 'system'),
      ).toBe(true)
    }
  })

  it('the autonomy holders sit right after delivering_work in the skeleton', () => {
    const names = getTemplate('code')!.prompt.map(e => ('name' in e ? e.name : e.text))
    expect(names.indexOf('autonomy')).toBe(names.indexOf('delivering_work') + 1)
    expect(names.indexOf('code_autonomy')).toBe(names.indexOf('autonomy') + 1)
  })

  it('agent: the tool block is the short form + the Nexus lines', () => {
    const tools = getHolderProse('agent_using_your_tools', { type: 'agent' })!
    expect(tools).toContain('Prefer the dedicated tools (Read, Edit, Write, Glob, Grep) over Bash or PowerShell when one fits')
    expect(tools).toContain('Read a file with the Read tool before you edit or overwrite it')
    expect(tools).toContain('Edit and Write each change one file per call')
    // `agent` never registers the `superedit` group, so its tool block must not
    // send the model to a tool the session cannot call. This block used to say
    // "use SuperEdit instead"; keep that regression pinned here, where the
    // agent tool block is pinned.
    expect(tools).not.toContain('SuperEdit')
    expect(tools).not.toContain('TodoWrite')
    expect(tools).not.toContain('Do NOT use the Bash or PowerShell tool')
    // The browser one-call-per-turn rule is NOT in the prompt body any more:
    // it follows the browser CAPABILITY, in the skill catalog, so `code` and
    // `chat` get it when they activate the skill. No type inlines
    // it, and `agent` no longer carries a holder for it.
    expect(tools).not.toContain('browser tool per assistant turn')
    expect(getHolderProse('agent_browser_tool_calls', { type: 'agent' })).toBeUndefined()
    const names = getTemplate('agent')!.prompt.map(e => ('name' in e ? e.name : e.text))
    expect(names).not.toContain('agent_browser_tool_calls')
    expect(BROWSER_SYSTEM_PROMPT_CATALOG).toContain('One browser tool call per turn')
    expect(BROWSER_SYSTEM_PROMPT_CATALOG).toContain(
      'Combining one browser tool with a non-browser tool',
    )
    expect(tools).not.toContain('/<skill-name>')
  })
})

describe('shared delivering_work holder — persistence guidance', () => {
  // The static block closes with three sections: `# Long conversations`
  // ("you don't need to wrap up early"), `# Delivering work` ("finish the
  // whole task … report completion only when fully done") and `# Correcting yourself`.
  // Without them a session does one short step and hands back. The prose is a
  // SHARED holder (shared_includes/delivering_work.md) so the three
  // task-running types carry one identical persistence contract.

  it('resolves as SHARED prose under every type, carrying the three sections', () => {
    for (const type of [undefined, 'code', 'safe_code', 'agent', 'chat']) {
      const prose = getHolderProse('delivering_work', type ? { type } : {})!
      expect(prose, `type=${type}`).toBeTruthy()
      expect(prose).toContain('# Long conversations')
      expect(prose).toContain('There is no need to wrap up early or hand off halfway')
      expect(prose).toContain('Once you know enough to act, act.')
      expect(prose).toContain('# Delivering work')
      expect(prose).toContain('Finish all of it, not just the easy parts')
      expect(prose).toContain('call it done only when it is')
      expect(prose).toContain('# Correcting yourself')
      // Trimmed: no trailing newline that would double the join.
      expect(prose).not.toMatch(/\n$/)
    }
  })

  it('code, safe_code and agent carry it in the static block; chat does not', () => {
    const names = (type: string): string[] =>
      getTemplate(type)!.prompt.map(e => ('name' in e ? e.name : e.text))
    // code: after the tone block (+ pronouns + the LEAN caution slot — the
    // last of the two `executing_with_care` lines), ahead of $skill_catalogs.
    expect(names('code').indexOf('delivering_work')).toBe(
      names('code').lastIndexOf('executing_with_care') + 1,
    )
    expect(names('code').indexOf('delivering_work')).toBeLessThan(
      names('code').indexOf('skill_catalogs'),
    )
    // safe_code: after its tool block (+ the shared parallelism paragraph),
    // ahead of $environment.
    expect(names('safe_code').indexOf('delivering_work')).toBe(
      names('safe_code').indexOf('tool_call_parallelism') + 1,
    )
    // agent: right after agent_autonomy, which it reinforces.
    expect(names('agent').indexOf('delivering_work')).toBe(
      names('agent').indexOf('agent_autonomy') + 1,
    )
    // chat is the conversational type — no task-persistence contract.
    expect(names('chat')).not.toContain('delivering_work')
  })
})

describe('chat + agent templates — per-type prose divergence', () => {
  // chat adopts a warm CONVERSATIONAL voice (gpt5-style); agent keeps the
  // shared browser-agent voice and ADDS an autonomy emphasis (chatgpt-agent-
  // style). Both use globally-unique `<type>_*` holder names so the type-blind
  // C++ registry can't confuse them with the shared holders.

  it('chat: chat_intro is a conversational assistant, not the browser/coding agent', () => {
    const intro = getHolderProse('chat_intro', { type: 'chat' })!
    expect(intro).toContain('{{AGENT_NAME}}')
    expect(intro).toContain('conversational assistant')
    // Not the shared browser intro, nor the code intro.
    expect(intro).not.toContain('browser agent running inside')
    expect(intro).not.toContain('software engineering')
    // Light type: no agent tool-list placeholder folded in.
    expect(intro).not.toContain('{{system-prompt-tools}}')
  })

  it('chat: personality forbids hedging closers; tone is conversational, not terse', () => {
    // `# Personality` is the head of chat's voice holder.
    const style = getHolderProse('chat_tone_and_style', { type: 'chat' })!
    expect(style).toContain('# Personality')
    expect(style).toContain('Would you like me to') // names the closer it bans
    expect(getHolderProse('chat_personality', { type: 'chat' })).toBeUndefined()
    expect(style).toContain('# Style')
    expect(style).toContain('# Brevity')
    // NOT the agent's terse "1-2 lines" status-report framing.
    expect(style).not.toContain('1-2 lines')
  })

  it('chat skeleton uses the chat_* holders and drops final_reminder', () => {
    const names = getTemplate('chat')!.prompt.map(e => ('name' in e ? e.name : e.text))
    expect(names).toContain('chat_intro')
    expect(names).toContain('chat_tone_and_style')
    expect(names).not.toContain('chat_personality')
    expect(names).not.toContain('final_reminder')
    // chat uses chat_intro — no bare `intro` in its skeleton.
    expect(names).not.toContain('intro')
  })

  it('agent: browser intro (agent_intro) + agent_autonomy inserted right after it', () => {
    const names = getTemplate('agent')!.prompt.map(e => ('name' in e ? e.name : e.text))
    expect(names).toContain('agent_intro') // browser-agent intro (moved from shared)
    expect(names).toContain('agent_autonomy')
    // intro → shared system → doing_tasks → autonomy (whose "executing
    // actions with care" back-reference resolves to agent_doing_tasks).
    expect(names.indexOf('system')).toBe(names.indexOf('agent_intro') + 1)
    expect(names.indexOf('agent_doing_tasks')).toBe(names.indexOf('system') + 1)
    // The shared caution sits between them: agent's autonomy block
    // back-references "the executing actions with care rules above".
    expect(names.indexOf('executing_with_care')).toBe(names.indexOf('agent_doing_tasks') + 1)
    expect(names.indexOf('agent_autonomy')).toBe(names.indexOf('executing_with_care') + 1)
    // Autonomy prose carries the chatgpt-agent emphasis + the care back-ref
    // (which resolves to the section folded into agent_intro above it).
    const autonomy = getHolderProse('agent_autonomy', { type: 'agent' })!
    expect(autonomy).toContain('Autonomy')
    expect(autonomy).toMatch(/get as far as you can/i)
    expect(autonomy).toContain('"Acting carefully" above')
    // agent_intro carries the browser-agent prose.
    expect(getHolderProse('agent_intro', { type: 'agent' })).toContain('browser agent running inside')
  })

  it('per-type prose is scoped to its type (distinct names, no cross-leak)', () => {
    // chat_* holders register only under type 'chat'; resolving under another
    // type (or with no type) finds no shared fallback → undefined.
    expect(getHolderProse('chat_intro', { type: 'agent' })).toBeUndefined()
    expect(getHolderProse('agent_autonomy', { type: 'chat' })).toBeUndefined()
    expect(getHolderProse('chat_tone_and_style')).toBeUndefined()
  })
})
