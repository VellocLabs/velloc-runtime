---
# Welcome page for the `chat` type — shown on a new (empty) chat session.
#
# `suggestions` are prompt-starter chips: `title` (+ an optional `description`
# subtitle); clicking loads `prompt` (defaults to `title`) into the composer.
# `greeting` / `subtitle` (optional) override the i18n welcome.greeting/subtitle.
#
# Chat starters are CONVERSATIONAL ("think with me"), deliberately distinct from
# the agent type's execution starters and the code type's repo work — see
# README.md → "Welcome page".
greeting: What's on your mind?
suggestions:
  - title: Ask anything
    description: Get answers, explanations, and ideas.
    prompt: Help me understand or solve something. I'll tell you what I'm trying to figure out.
  - title: Summarize something
    description: Turn long content into the key points.
    prompt: Summarize this clearly. Focus on the key points, important details, and anything I should pay attention to.
  - title: Explain a topic
    description: Break down something complex in a simple way.
    prompt: Explain this topic clearly and step by step. Start simple, then go deeper where it matters.
  - title: Compare options
    description: Weigh choices and help me decide.
    prompt: Compare these options for me. Focus on the important differences, trade-offs, and which one fits my needs best.
  - title: Write or rewrite
    description: Draft, improve, translate, or polish text.
    prompt: Help me write or improve this. Keep the meaning, but make it clearer, more natural, and appropriate for the situation.
  - title: Brainstorm ideas
    description: Explore possibilities and develop better ideas.
    prompt: Brainstorm ideas with me. Give me several strong directions, explain the trade-offs, and help me refine the best ones.
---

# Chat welcome

Prompt-starter chips for a new `chat` session. Edit the `suggestions` list in
the frontmatter above; add `welcome-<locale>.md` siblings for other languages.
