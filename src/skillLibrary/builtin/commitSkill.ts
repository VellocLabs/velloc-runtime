/**
 * Bundled `commit` skill (slash-only): one git commit from the current changes,
 * following the repository's commit style. `!\`git …\`` lines expand at
 * dispatch through the host Bash tool.
 */

import { addStockSkill } from '../builtinSkills'

const COMMIT_PROMPT = `Make exactly one git commit from the current changes in this repository.

## Context

Status: !\`git status\`

Diff, staged and unstaged: !\`git diff HEAD\`

Branch: !\`git branch --show-current\`

Recent commits: !\`git log --oneline -10\`

## Rules

- Leave git configuration alone. Do not read-modify-write any setting, globally or in this repository.
- Hooks and signing run as configured. Do not pass flags that skip them (\`--no-verify\`, \`--no-gpg-sign\` and the like) unless the user asked for exactly that.
- Always create a new commit. Never amend an existing one unless the user asked for an amend.
- The commit must not contain files that probably hold secrets — \`.env\` files, credential or service-account JSON, private keys, token files. This includes files that were already staged before you were invoked: inspect the staged set, and if a suspect file is in it, stop and tell the user. Do not commit, and do not silently unstage or otherwise change their staging. If the user insists on committing such a file, warn them first.
- If there is nothing to commit — no modified files and no untracked files — make no commit. Never create an empty commit.
- Never use an interactive flag (\`-i\`, \`--interactive\`, \`--patch\`). There is no terminal to answer the prompts.

## Steps

1. Write the message. Read the recent commits above and match this repository's style: prefix conventions, capitalisation, tense, length. Classify the change — feature, improvement, fix, refactor, tests, docs, chore — and pick a verb that fits the class (a fix "fixes", a refactor "restructures", a doc change "documents"). One or two sentences. Explain why the change is being made, not what the diff already shows.
2. Stage the relevant files and commit. Pass the message through a quoted heredoc so multi-line text survives the shell intact:
   \`\`\`
   git commit -m "$(cat <<'EOF'
   <message>
   EOF
   )"
   \`\`\`
3. Do the whole thing in one response, with no prose — only tool calls. Staging must finish before the commit runs: either chain the two in one shell call (\`git add <files> && git commit …\`) or issue the add and wait for its result before issuing the commit. Never run the add and the commit as parallel calls; a commit that races the add can capture a stale index and leave the staged files out.`

export function registerCommitSkill(): void {
  addStockSkill({
    name: 'commit',
    description: 'Creates one git commit from the current changes, with a message that matches the repository\'s commit style. Use it when the working tree is ready to be committed.',
    modelInvocation: [],
    content: COMMIT_PROMPT,
  })
}
