---
# Welcome page for the `code` type — shown on a new (empty) code session.
#
# `suggestions` are prompt-starter chips: `title` (+ an optional `description`
# subtitle); clicking loads `prompt` (defaults to `title`) into the composer.
# `greeting` / `subtitle` (optional) override the i18n welcome.greeting/subtitle.
#
# This is the DEFAULT (English) welcome. Add `welcome-<locale>.md` for other
# languages (the locale is the UI code — Chinese is `welcome-zh.md`). See
# README.md → "Welcome page".
greeting: What can I help you build?
suggestions:
  - title: Build a feature
    description: Implement a new feature in this project.
    prompt: Help me build a new feature in this project. First understand the relevant code and architecture, then propose an implementation plan, make the changes, and verify that they work.
  - title: Fix a bug
    description: Find the root cause and implement a reliable fix.
    prompt: Investigate this bug, identify the root cause, implement the smallest reliable fix, and verify it with appropriate tests or checks.
  - title: Understand this codebase
    description: Explore the architecture, modules, and important flows.
    prompt: Help me understand this codebase. Identify the main components, important entry points, data flow, and the parts I should read first.
  - title: Review code
    description: Find bugs, risks, and opportunities to improve.
    prompt: Review this code for correctness, bugs, regressions, security risks, performance issues, and maintainability. Prioritize the most important findings.
  - title: Refactor code
    description: Improve structure without changing behavior.
    prompt: Refactor this code to make it simpler, clearer, and easier to maintain while preserving existing behavior. Explain the main changes and verify that nothing breaks.
  - title: Add or improve tests
    description: Increase coverage and catch important edge cases.
    prompt: Review the current behavior and tests, identify important gaps and edge cases, then add or improve tests to cover them.
---

# Code welcome

Prompt-starter chips for a new `code` session. Edit the `suggestions` list in
the frontmatter above; add `welcome-<locale>.md` siblings for other languages.
