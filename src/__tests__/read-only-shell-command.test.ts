import { describe, expect, it } from 'vitest'
import { isReadOnlyShellCommand } from '../permissions/readOnlyShellCommand'

// The conservative, deny-by-default classifier that lets read-only shell
// commands run in plan mode. It must NEVER allow a mutation through; false
// rejections of legitimate read commands are acceptable.
describe('isReadOnlyShellCommand', () => {
  describe('allows read-only commands', () => {
    const ok = [
      'ls',
      'ls -la src',
      'cat package.json',
      'head -50 file.ts',
      'tail -n 100 log.txt',
      'wc -l src/index.ts',
      'pwd',
      'which node',
      'echo hello',
      'grep -rn pattern src',
      'rg "foo bar" src',
      'sort file | uniq',
      'cat a.txt | grep needle | head -5',
      'FOO=bar ls', // leading env-var assignment
      "grep '<div>' index.html", // operator chars inside single quotes
      'grep "a;b" file', // operator chars inside double quotes
      "echo 'a$(b)c'", // substitution is literal inside single quotes
    ]
    for (const cmd of ok) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(true))
    }
  })

  describe('allows read-only git / gh subcommands', () => {
    const ok = [
      'git status',
      'git log --oneline -20',
      'git diff HEAD~1',
      'git show abc123',
      'git blame src/x.ts',
      'git rev-parse HEAD',
      'git ls-files',
      'git --no-pager log',
      'gh pr view 12',
      'gh pr list',
      'gh run list',
      'gh issue view 3',
    ]
    for (const cmd of ok) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(true))
    }
  })

  describe('allows read-only PowerShell cmdlets/aliases', () => {
    const ok = [
      'Get-ChildItem',
      'Get-ChildItem -Recurse src',
      'gci',
      'Get-Content file.txt',
      'gc README.md',
      'Select-String -Path *.ts -Pattern foo',
      'Test-Path src',
      'Get-Location',
      'Get-Command npm',
    ]
    for (const cmd of ok) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(true))
    }
  })

  describe('denies mutating / executing commands', () => {
    const no = [
      'rm -rf build',
      'mv a b',
      'cp a b',
      'touch new.txt',
      'mkdir dir',
      'chmod +x x',
      'dd if=a of=b',
      'tee out.txt',
      'xargs rm',
      'sed -i s/a/b/ f',
      'awk "{print}" f',
      'npm install',
      'node script.js',
      'python x.py',
      'curl http://x -o f',
      'wget http://x',
      'find . -delete',
      'find . -name x -exec rm {} ;',
    ]
    for (const cmd of no) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(false))
    }
  })

  describe('denies mutating git / gh subcommands', () => {
    const no = [
      'git push',
      'git commit -m wip',
      'git add .',
      'git checkout main',
      'git reset --hard',
      'git stash',
      'git branch -d x',
      'git config user.name x',
      'git pull',
      'git fetch',
      'gh pr create',
      'gh pr merge 1',
      'gh api -X POST /repos/x',
    ]
    for (const cmd of no) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(false))
    }
  })

  describe('denies redirection / chaining / substitution / sudo', () => {
    const no = [
      'echo hi > out.txt',
      'echo hi >> out.txt',
      'cat < in.txt',
      'ls ; rm x',
      'ls && rm x',
      'ls || rm x',
      'ls & rm x',
      'cat "$(rm x)"', // substitution active inside double quotes
      'echo `rm x`',
      'sudo ls',
      'git log | tee out.txt', // pipe into a NON-read-only command
      'ls |', // trailing pipe → empty segment
    ]
    for (const cmd of no) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(false))
    }
  })

  describe('denies unknown / malformed input', () => {
    it('unknown command', () =>
      expect(isReadOnlyShellCommand('frobnicate x')).toBe(false))
    it('empty string', () => expect(isReadOnlyShellCommand('')).toBe(false))
    it('whitespace only', () => expect(isReadOnlyShellCommand('   ')).toBe(false))
    it('multi-line', () =>
      expect(isReadOnlyShellCommand('ls\nrm x')).toBe(false))
    it('non-string', () => {
      expect(isReadOnlyShellCommand(undefined)).toBe(false)
      expect(isReadOnlyShellCommand(null)).toBe(false)
      expect(isReadOnlyShellCommand(42)).toBe(false)
    })
  })

  // git -C, list-only git branch/remote/config,
  // && / ; chains of reads, and harmless `2>$null` stderr-discard.
  describe('allows git -C / list-forms / read chains / null-redirect', () => {
    const ok = [
      'git branch',
      'git branch --show-current',
      'git branch -a -v',
      'git -C /repo status',
      "git -C 'C:\\\\shift' branch --show-current",
      'git remote -v',
      'git config --get user.name',
      'git config --list',
      'git status && git log --oneline',
      'git diff ; git status',
      'git rev-parse HEAD 2>$null',
      'ls -la 2>/dev/null',
      'git status 2>&1 | grep clean',
      // the EXACT command the real session wrongly blocked:
      "git -C 'C:\\\\shift' branch --show-current; git -C 'C:\\\\shift' rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null",
    ]
    for (const cmd of ok) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(true))
    }
  })

  describe('still denies mutating git forms + mutating chains', () => {
    const no = [
      'git branch -d feature',
      'git branch newbranch', // bare positional = create
      'git remote add origin url',
      'git config user.name x', // write (no get/list flag)
      'git tag v1.0', // create
      'git -C /repo checkout main',
      'git status && rm -rf build', // mutation in a chain segment
      'git log ; git push',
      'git status & rm x', // background
      'echo hi > out.txt', // a real file redirect is NOT the null device
    ]
    for (const cmd of no) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(false))
    }
  })

  // Fail-opens: `>&file` is a real file write (not an fd dup), and a
  // `git -c <key>=<cmd>` config injection executes a command through an
  // otherwise read-only subcommand. Both must be DENIED; true fd-duplications
  // (`2>&1`, `2>&-`) stay allowed.
  describe('does not treat `>&file` writes or `git -c` injection as read-only', () => {
    // Each of these is ALLOWED by the pre-fix code (the `>&` strip ate the file
    // target; `-c <key>=<val>` was skipped so the read-only subcommand showed
    // through) and must now be DENIED.
    const no = [
      'git log >&out.txt', // `>&file` redirects output to a FILE (write)
      'git status 2>&out.log', // fd-prefixed `>&file` is still a file write
      'git -c core.pager=evil log', // -c injects a pager cmd through `log`
      'git -c diff.external=mycmd diff', // -c injects an external diff driver
      "git -c core.pager='less x' log", // quoted injection value, same hole
    ]
    for (const cmd of no) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(false))
    }

    // True fd-duplications (a digit / `-` fd target) stay read-only.
    const ok = [
      'git status 2>&1', // merge stderr→stdout (fd dup)
      'git status 2>&1 | grep clean',
      'git rev-parse HEAD 2>&-', // close stderr (fd target `-`)
    ]
    for (const cmd of ok) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(true))
    }
  })

  // `--output=<file>` is a git diff option: log / diff / show / whatchanged
  // write their result to a file, a mutation the plan-mode and acceptEdits
  // gates trust this classifier never to wave through.
  describe('rejects git --output (writes a file)', () => {
    const no = [
      'git log --output=/tmp/x',
      'git diff --output=out.txt',
      'git show HEAD --output out.txt',
      'git whatchanged --output=x',
      'git log --outp=x', // an unambiguous prefix is accepted by git
      'git --no-pager diff --OUTPUT=x',
    ]
    for (const cmd of no) {
      it(cmd, () => expect(isReadOnlyShellCommand(cmd)).toBe(false))
    }
    it('plain log / diff stay read-only', () => {
      expect(isReadOnlyShellCommand('git log --oneline')).toBe(true)
      expect(isReadOnlyShellCommand('git diff --stat HEAD~1')).toBe(true)
    })
  })
})
