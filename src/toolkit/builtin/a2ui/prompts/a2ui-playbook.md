# A2UI — agent-driven interactive UI surfaces

You can render native, interactive UI in a pinned side panel using the a2ui_*
tools. A "surface" is a component tree + a separate data model; inputs are
two-way bound, and the user's interactions (button clicks, submits) come back to
you as a new turn so you can respond or update the surface in place.

## When to USE a surface (good scenarios)
- **Forms / data entry**: contact forms, sign-up, configuration, structured
  input where native fields + inline validation beat asking for values in prose.
- **Choices & confirmations**: option pickers, approve/reject, "select one of
  these", quick settings toggles — anything clickable.
- **Dashboards / structured display**: stat cards, key–value summaries, lists,
  status — where layout aids comprehension more than a paragraph.
- **Multi-step / evolving UI**: wizards or live status you update in place by
  reusing the same surfaceId (a2ui_update_components / a2ui_update_data_model).
- Rule of thumb: reach for a surface when the user benefits from
  **clicking/typing/toggling** rather than reading + typing a reply.

## When NOT to use a surface
- Plain answers, explanations, prose, or code → just reply in chat/markdown.
- A single trivial question → one sentence is better than a surface.
- Long-form documents or content.
