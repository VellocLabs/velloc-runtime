import { describe, expect, it } from 'vitest'
import {
  commandMovesGitHead,
  streamEventMovesGitHead,
} from '../utils/branchSwitchDetect'

/** A live-stream assistant event (Vercel part shape: `tool-call` + `args`). */
function vercelToolCall(toolName: string, command: string) {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'switching branches' },
        { type: 'tool-call', toolName, args: { command } },
      ],
    },
  }
}

describe('commandMovesGitHead', () => {
  it('matches the branch-switching subcommands', () => {
    expect(commandMovesGitHead('git checkout main')).toBe(true)
    expect(commandMovesGitHead('git switch feature/x')).toBe(true)
    expect(commandMovesGitHead('git checkout --detach')).toBe(true)
    // `git branch -m` renames the CURRENT branch: the chip text changes with
    // no switch at all.
    expect(commandMovesGitHead('git branch -m old new')).toBe(true)
    // A rebase leaves HEAD detached while it runs.
    expect(commandMovesGitHead('git rebase main')).toBe(true)
  })

  it('matches through flags, -C, and a compound command line', () => {
    // These are the forms the agent actually writes — a prefix match on
    // "git checkout" would miss every one of them.
    expect(commandMovesGitHead('git -C /repo switch main')).toBe(true)
    expect(commandMovesGitHead('git --no-pager checkout main')).toBe(true)
    expect(commandMovesGitHead('cd /repo && git checkout main')).toBe(true)
    expect(commandMovesGitHead('git fetch origin; git checkout main')).toBe(true)
  })

  it('matches the other commands that change what HEAD names', () => {
    // bisect checks out commit after commit; init/clone give an unversioned
    // folder its first branch; gh pr checkout switches with no `git` word.
    expect(commandMovesGitHead('git bisect start HEAD v1.0')).toBe(true)
    expect(commandMovesGitHead('git init')).toBe(true)
    expect(commandMovesGitHead('git clone https://example.com/r.git .')).toBe(true)
    expect(commandMovesGitHead('gh pr checkout 123')).toBe(true)
    expect(commandMovesGitHead('gh pr view 123')).toBe(false)
  })

  it('ignores git commands that cannot move HEAD', () => {
    expect(commandMovesGitHead('git status')).toBe(false)
    expect(commandMovesGitHead('git rev-parse --abbrev-ref HEAD')).toBe(false)
    expect(commandMovesGitHead('git commit -m "wip"')).toBe(false)
    expect(commandMovesGitHead('git log --oneline -5')).toBe(false)
    // `git worktree add` creates a checkout ELSEWHERE — this folder's HEAD is
    // untouched, and re-binding to the new worktree re-resolves via runInit.
    expect(commandMovesGitHead('git worktree add ../wt -b feat')).toBe(false)
  })

  it('does not match a non-git command that merely contains a subcommand word', () => {
    expect(commandMovesGitHead('npm run checkout-fixtures')).toBe(false)
    // The `[^\n;&|]` fence keeps `git` bound to its own segment.
    expect(commandMovesGitHead('git log | grep checkout')).toBe(false)
  })
})

describe('streamEventMovesGitHead', () => {
  it('detects a Bash tool-call carrying a checkout (live Vercel shape)', () => {
    expect(streamEventMovesGitHead(vercelToolCall('Bash', 'git checkout main'))).toBe(
      true,
    )
  })

  it('detects the PowerShell tool — the no-git-bash Windows host', () => {
    expect(
      streamEventMovesGitHead(vercelToolCall('PowerShell', 'git switch main')),
    ).toBe(true)
  })

  it('detects the legacy Anthropic part shape (tool_use + name + input)', () => {
    // Replayed / bridge-shaped data does not use the Vercel spelling; reading
    // only `toolName`/`args` would silently miss it.
    expect(
      streamEventMovesGitHead({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'git checkout dev' } },
          ],
        },
      }),
    ).toBe(true)
  })

  it('detects a checkout inside a SuperShell script (`code`, not `command`)', () => {
    expect(
      streamEventMovesGitHead({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool-call',
              toolName: 'SuperShell',
              args: { code: "await bash('git fetch'); await bash('git checkout dev')", inputs: {} },
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('reads content off the top level as well as the nested message', () => {
    expect(
      streamEventMovesGitHead({
        type: 'assistant',
        content: [{ type: 'tool-call', toolName: 'Bash', args: { command: 'git switch x' } }],
      }),
    ).toBe(true)
  })

  it('ignores non-shell tools, harmless commands, and non-assistant events', () => {
    // A file-editing tool whose payload happens to mention a checkout.
    expect(
      streamEventMovesGitHead({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool-call', toolName: 'Write', args: { command: 'git checkout main' } },
          ],
        },
      }),
    ).toBe(false)
    expect(streamEventMovesGitHead(vercelToolCall('Bash', 'git status'))).toBe(false)
    expect(streamEventMovesGitHead({ type: 'user', message: { content: [] } })).toBe(
      false,
    )
    expect(streamEventMovesGitHead({ type: 'assistant', message: { content: [] } })).toBe(
      false,
    )
  })

  it('tolerates junk without throwing', () => {
    expect(streamEventMovesGitHead(null)).toBe(false)
    expect(streamEventMovesGitHead(undefined)).toBe(false)
    expect(streamEventMovesGitHead('assistant')).toBe(false)
    expect(streamEventMovesGitHead({ type: 'assistant' })).toBe(false)
    expect(
      streamEventMovesGitHead({ type: 'assistant', message: { content: [null, 7] } }),
    ).toBe(false)
  })
})
