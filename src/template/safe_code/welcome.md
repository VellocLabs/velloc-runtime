---
# Welcome page for the `safe_code` type (SafeCode) - shown on a new (empty)
# SafeCode session.
#
# NOT a clone of the `code` welcome: SafeCode cannot run anything, so no chip
# may ask the agent to build, test, or otherwise verify by execution. Every
# prompt here ends in inspection, and the two that produce code say plainly
# that running is the user's job, outside SafeCode. A chip that says "verify
# that they work" would walk the model straight into the one wall this session
# type has.
#
# `suggestions` are prompt-starter chips: `title` (+ an optional `description`
# subtitle); clicking loads `prompt` (defaults to `title`) into the composer.
# `greeting` / `subtitle` (optional) override the i18n welcome.greeting/subtitle.
#
# This is the DEFAULT (English) welcome. Add `welcome-<locale>.md` for other
# languages (the locale is the UI code - Chinese is `welcome-zh.md`). See
# README.md -> "Welcome page".
greeting: What should I read or change?
suggestions:
  - title: Understand this codebase
    description: Explore the architecture, modules, and important flows.
    prompt: Help me understand this codebase. Identify the main components, important entry points, data flow, and the parts I should read first.
  - title: Review code
    description: Find bugs, risks, and opportunities to improve.
    prompt: Review this code for correctness, bugs, regressions, security risks, performance issues, and maintainability. Prioritize the most important findings.
  - title: Fix a bug
    description: Find the root cause and make the smallest safe change.
    prompt: Investigate this bug by reading the code, identify the root cause, and make the smallest reliable fix. Verify the change by re-reading the affected files rather than running anything, and tell me what still has to be run outside SafeCode.
  - title: Build a feature
    description: Implement a change across the files it touches.
    prompt: Help me build a new feature in this project. First read the relevant code and architecture, then propose an implementation plan and make the changes. Verify by inspecting the resulting files, and list what still has to be built or tested outside SafeCode.
  - title: Refactor code
    description: Improve structure without changing behavior.
    prompt: Refactor this code to make it simpler, clearer, and easier to maintain while preserving existing behavior. Explain the main changes, and check by inspection that nothing else depends on what you moved.
  - title: Write tests
    description: Add the tests here, run them elsewhere.
    prompt: Read the current behavior and the existing tests, identify important gaps and edge cases, and write tests that cover them. Match the style of the surrounding tests. I will run them outside SafeCode.
---

# SafeCode welcome

Prompt-starter chips for a new `safe_code` session. Edit the `suggestions` list
in the frontmatter above; add `welcome-<locale>.md` siblings for other languages.
Keep every chip inside the session type's boundary - inspect and modify only,
never "verify that it works".
