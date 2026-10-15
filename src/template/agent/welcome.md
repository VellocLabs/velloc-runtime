---
# Welcome page for the `agent` type — shown on a new (empty) agent session.
#
# `suggestions` are prompt-starter chips: `title` (+ an optional `description`
# subtitle); clicking loads `prompt` (defaults to `title`) into the composer.
# `greeting` / `subtitle` (optional) override the i18n welcome.greeting/subtitle.
#
# This is the DEFAULT (English) welcome. Add `welcome-<locale>.md` for other
# languages (the locale is the UI code — Chinese is `welcome-zh.md`). See
# README.md → "Welcome page".
greeting: What can I help you with?
suggestions:
  - title: Organize my files
    description: Sort, rename, and organize files on my computer.
    prompt: Help me organize my files. Review what's here, suggest a sensible structure, and show me the changes before applying them.
  - title: Deep research
    description: Search multiple sources and turn them into clear findings.
    prompt: Research this topic in depth. Compare reliable sources and give me the key findings, conclusions, and sources.
  - title: Complete a web task
    description: Browse websites and complete a multi-step task.
    prompt: Help me complete this task on the web. Find the right sites, work through the steps, and ask me before anything important or irreversible.
  - title: Work with documents & data
    description: Read files, extract information, and turn it into useful results.
    prompt: Help me work with these files. Read and analyze them, extract what matters, and turn the results into something useful.
  - title: Create something
    description: Make a document, spreadsheet, presentation, or report.
    prompt: Create something polished and ready to use from my instructions and materials.
  - title: Automate a recurring task
    description: Turn repetitive work into an ongoing workflow.
    prompt: Help me turn this recurring task into an automated workflow. Figure out what needs to happen, when it should run, and when you need my input.
---

# Agent welcome

Prompt-starter chips for a new `agent` session. Edit the `suggestions` list in
the frontmatter above; add `welcome-<locale>.md` siblings for other languages.
