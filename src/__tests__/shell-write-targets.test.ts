import { describe, expect, it } from 'vitest'

import {
  MAX_ARGUMENT_CANDIDATES,
  MAX_WRITE_CANDIDATES,
  extractShellWriteCandidates,
  type ShellWriteCandidate,
} from '../sessions/fileSnapshots/shellWriteTargets'

const POSIX = { shell: 'bash' as const, cwd: '/home/u/proj', homeDir: '/home/u' }
const WIN = { shell: 'bash' as const, cwd: 'D:/proj', homeDir: 'C:/Users/u' }
const PS = { shell: 'powershell' as const, cwd: 'D:/proj', homeDir: 'C:/Users/u' }

// Paths come back in the host's native separator; the tests compare slashed.
const slashed = (path: string): string => path.replace(/\\/g, '/')
function paths(candidates: ShellWriteCandidate[]): string[] {
  return candidates.map(c => slashed(c.path)).sort()
}
function byPath(candidates: ShellWriteCandidate[], path: string): ShellWriteCandidate | undefined {
  return candidates.find(c => slashed(c.path) === path)
}
function shaped(candidates: ShellWriteCandidate[]): ShellWriteCandidate[] {
  return candidates.map(c => ({ ...c, path: slashed(c.path) }))
}

describe('extractShellWriteCandidates — bash redirects', () => {
  it('captures >, >>, &> and descriptor-prefixed redirect targets, resolved against cwd', () => {
    const out = extractShellWriteCandidates('echo hi > out.txt; ls >> log.txt; make &> build.log; cmd 2>err.txt', POSIX)
    expect(paths(out)).toEqual([
      '/home/u/proj/build.log',
      '/home/u/proj/err.txt',
      '/home/u/proj/log.txt',
      '/home/u/proj/out.txt',
    ])
    expect(out.every(c => c.source === 'redirect')).toBe(true)
  })

  it('ignores /dev/null, descriptor duplication and input redirects', () => {
    const out = extractShellWriteCandidates('cmd > /dev/null 2>&1; cmd 2>&- < in.txt; cmd <<< "x"', POSIX)
    expect(out).toEqual([])
  })

  it('does not read a heredoc body as commands, and still sees the redirect around it', () => {
    const command = 'cat > a.txt <<EOF\nrm -rf everything\necho > b.txt\nEOF\necho done > c.txt'
    const out = extractShellWriteCandidates(command, POSIX)
    expect(paths(out)).toEqual(['/home/u/proj/a.txt', '/home/u/proj/c.txt'])
  })

  it('keeps quoted paths whole and drops words carrying variables or globs', () => {
    const out = extractShellWriteCandidates(
      'echo x > "my file.txt"; echo y > \'o k.txt\'; echo z > $HOME/x.txt; echo w > out-*.txt; cat a.txt > "$OUT"',
      POSIX,
    )
    expect(paths(out)).toEqual(['/home/u/proj/my file.txt', '/home/u/proj/o k.txt'])
  })

  it('follows cd within a chain', () => {
    const out = extractShellWriteCandidates('cd sub && echo x > a.txt; cd /abs/dir && touch b.txt', POSIX)
    expect(paths(out)).toEqual(['/abs/dir/b.txt', '/home/u/proj/sub/a.txt'])
  })

  it('expands a leading ~ with the home directory', () => {
    const out = extractShellWriteCandidates('echo x > ~/notes.txt', POSIX)
    expect(paths(out)).toEqual(['/home/u/notes.txt'])
    expect(extractShellWriteCandidates('echo x > ~/notes.txt', { ...POSIX, homeDir: undefined })).toEqual([])
  })
})

describe('extractShellWriteCandidates — bash writing commands', () => {
  it('sed -i names its file operands and skips the script, in both spellings', () => {
    expect(paths(extractShellWriteCandidates("sed -i 's/a/b/' x.ts y.ts", POSIX))).toEqual(['/home/u/proj/x.ts', '/home/u/proj/y.ts'])
    expect(paths(extractShellWriteCandidates("sed -i.bak -e 's/a/b/' x.ts", POSIX))).toEqual(['/home/u/proj/x.ts'])
    expect(paths(extractShellWriteCandidates("sed --in-place='' 's/a/b/' x.ts", POSIX))).toEqual(['/home/u/proj/x.ts'])
    expect(paths(extractShellWriteCandidates("sed -n 's/a/b/p' x.ts", POSIX))).toEqual([])
  })

  it('perl -pi names its files after the -e script', () => {
    expect(paths(extractShellWriteCandidates("perl -pi -e 's/a/b/' x.ts", POSIX))).toEqual(['/home/u/proj/x.ts'])
    expect(paths(extractShellWriteCandidates("perl -i.bak script.pl x.ts", POSIX))).toEqual(['/home/u/proj/x.ts'])
    expect(paths(extractShellWriteCandidates("perl -ne 'print' x.ts", POSIX))).toEqual([])
  })

  it('cp and mv capture the destination both as a file and as a file inside a directory; mv also removes its sources', () => {
    const cp = extractShellWriteCandidates('cp a.txt dest', POSIX)
    expect(paths(cp)).toEqual(['/home/u/proj/dest', '/home/u/proj/dest/a.txt'])
    const mv = extractShellWriteCandidates('mv src/a.txt b.txt', POSIX)
    expect(paths(mv)).toEqual(['/home/u/proj/b.txt', '/home/u/proj/b.txt/a.txt', '/home/u/proj/src/a.txt'])
    expect(byPath(mv, '/home/u/proj/src/a.txt')?.onDirectory).toBe('tree')
    const target = extractShellWriteCandidates('cp -t out a.txt b.txt', POSIX)
    expect(paths(target)).toEqual(['/home/u/proj/out', '/home/u/proj/out/a.txt', '/home/u/proj/out/b.txt'])
  })

  it('rm captures its operands; a recursive rm marks directories as trees', () => {
    const plain = extractShellWriteCandidates('rm a.txt b.txt', POSIX)
    expect(plain.every(c => c.onDirectory === 'skip')).toBe(true)
    const recursive = extractShellWriteCandidates('rm -rf build', POSIX)
    expect(shaped(recursive)).toEqual([{ path: '/home/u/proj/build', source: 'writer', onDirectory: 'tree' }])
  })

  it('tee, touch, sort -o, dd of=, curl -o and wget -O name their outputs', () => {
    expect(paths(extractShellWriteCandidates('make | tee -a build.log', POSIX))).toEqual(['/home/u/proj/build.log'])
    expect(paths(extractShellWriteCandidates('touch a.txt', POSIX))).toEqual(['/home/u/proj/a.txt'])
    expect(paths(extractShellWriteCandidates('sort -o sorted.txt in.txt', POSIX))).toEqual(['/home/u/proj/sorted.txt'])
    expect(paths(extractShellWriteCandidates('dd if=/dev/zero of=blob.bin bs=1k count=1', POSIX))).toEqual(['/home/u/proj/blob.bin'])
    expect(paths(extractShellWriteCandidates('curl -sL -o pkg.tgz https://x.test/p', POSIX))).toEqual(['/home/u/proj/pkg.tgz'])
    expect(paths(extractShellWriteCandidates('wget -O page.html https://x.test', POSIX))).toEqual(['/home/u/proj/page.html'])
    expect(extractShellWriteCandidates('curl -s https://x.test/p', POSIX)).toEqual([])
  })

  it('tar names its archive only when creating; gzip names the file and its compressed twin', () => {
    expect(paths(extractShellWriteCandidates('tar -czf out.tgz src', POSIX))).toEqual(['/home/u/proj/out.tgz'])
    expect(paths(extractShellWriteCandidates('tar czf out.tgz src', POSIX))).toEqual(['/home/u/proj/out.tgz'])
    expect(extractShellWriteCandidates('tar -xzf in.tgz', POSIX)).toEqual([])
    expect(paths(extractShellWriteCandidates('gzip big.log', POSIX))).toEqual(['/home/u/proj/big.log', '/home/u/proj/big.log.gz'])
  })

  it('git: mutating subcommands name their paths; read-only ones name nothing', () => {
    expect(paths(extractShellWriteCandidates('git checkout -- src/a.ts', POSIX))).toEqual(['/home/u/proj/src/a.ts'])
    expect(paths(extractShellWriteCandidates('git restore a.ts b.ts', POSIX))).toEqual(['/home/u/proj/a.ts', '/home/u/proj/b.ts'])
    expect(paths(extractShellWriteCandidates('git -C sub mv old.ts new.ts', POSIX))).toEqual([
      '/home/u/proj/sub/new.ts',
      '/home/u/proj/sub/new.ts/old.ts',
      '/home/u/proj/sub/old.ts',
    ])
    expect(extractShellWriteCandidates('git status && git log --oneline -5 && git diff a.ts', POSIX)).toEqual([])
    expect(extractShellWriteCandidates('git add a.ts && git commit -m "x"', POSIX)).toEqual([])
  })
})

describe('extractShellWriteCandidates — bash generic operands', () => {
  it('names the plain operands of an unknown command as weak candidates and skips flags', () => {
    const out = extractShellWriteCandidates('prettier --write --config .prettierrc src/a.ts', POSIX)
    expect(paths(out)).toEqual(['/home/u/proj/.prettierrc', '/home/u/proj/src/a.ts'])
    expect(out.every(c => c.source === 'argument')).toBe(true)
    expect(paths(extractShellWriteCandidates('python gen.py docs', POSIX))).toEqual(['/home/u/proj/docs', '/home/u/proj/gen.py'])
  })

  it('names nothing for read-only commands', () => {
    expect(extractShellWriteCandidates('cat a.ts | grep foo | head -5; ls -la src; wc -l a.ts; diff a b', POSIX)).toEqual([])
  })

  it('looks through wrappers, env assignments and shell control words', () => {
    expect(paths(extractShellWriteCandidates('FOO=1 sudo -u root tee x.txt', POSIX))).toEqual(['/home/u/proj/x.txt'])
    expect(paths(extractShellWriteCandidates('if [ -f a ]; then cp a b; fi', POSIX))).toEqual(['/home/u/proj/b', '/home/u/proj/b/a'])
    expect(paths(extractShellWriteCandidates('timeout 30 env X=1 nohup touch t.txt', POSIX))).toEqual(['/home/u/proj/t.txt'])
  })

  it('reads a nested `bash -c` script and command substitutions', () => {
    expect(paths(extractShellWriteCandidates('bash -c "echo hi > inner.txt"', POSIX))).toEqual(['/home/u/proj/inner.txt'])
    expect(paths(extractShellWriteCandidates('echo $(sed -i s/a/b/ x.ts) > y.txt', POSIX))).toEqual(['/home/u/proj/x.ts', '/home/u/proj/y.txt'])
  })

  it('ranks stronger sources first and caps the list', () => {
    const many = Array.from({ length: MAX_WRITE_CANDIDATES + 10 }, (_, i) => `f${i}.txt`).join(' ')
    const out = extractShellWriteCandidates(`touch ${many}`, POSIX)
    expect(out).toHaveLength(MAX_WRITE_CANDIDATES)
    const weak = Array.from({ length: MAX_ARGUMENT_CANDIDATES + 5 }, (_, i) => `g${i}.txt`).join(' ')
    expect(extractShellWriteCandidates(`mytool ${weak}`, POSIX)).toHaveLength(MAX_ARGUMENT_CANDIDATES)
    const mixed = extractShellWriteCandidates('mytool a.txt > a.txt', POSIX)
    expect(shaped(mixed)).toEqual([{ path: '/home/u/proj/a.txt', source: 'redirect', onDirectory: 'skip' }])
  })

  it('never throws on malformed input', () => {
    expect(() => extractShellWriteCandidates('echo "unterminated > x.txt', POSIX)).not.toThrow()
    expect(() => extractShellWriteCandidates("echo 'a > b.txt", POSIX)).not.toThrow()
    expect(() => extractShellWriteCandidates('$(((', POSIX)).not.toThrow()
    expect(extractShellWriteCandidates('', POSIX)).toEqual([])
  })
})

describe('extractShellWriteCandidates — Windows hosts', () => {
  it('maps Git Bash drive paths to native ones and drops POSIX-only roots', () => {
    const out = extractShellWriteCandidates('echo x > /d/proj/a.txt; echo y > /tmp/t.txt; touch "D:\\proj\\b.txt"; touch rel.txt', WIN)
    expect(paths(out)).toEqual(['D:/proj/a.txt', 'D:/proj/b.txt', 'D:/proj/rel.txt'])
  })

  it('cmd /c lines are read for their copy, del and redirect targets', () => {
    const out = extractShellWriteCandidates('cmd /c "copy a.txt b.txt && del c.txt && echo x > d.txt"', WIN)
    expect(paths(out)).toEqual(['D:/proj/b.txt', 'D:/proj/b.txt/a.txt', 'D:/proj/c.txt', 'D:/proj/d.txt'])
  })
})

describe('extractShellWriteCandidates — PowerShell', () => {
  it('captures redirects and the content cmdlets (positional and named, with prefixes)', () => {
    expect(paths(extractShellWriteCandidates('"hi" > out.txt; Get-Content a.txt >> log.txt', PS))).toEqual(['D:/proj/log.txt', 'D:/proj/out.txt'])
    expect(paths(extractShellWriteCandidates("Set-Content -Path a.txt -Value 'x'; 'y' | Out-File -FilePath b.txt -Append; Add-Content c.txt 'z'", PS))).toEqual([
      'D:/proj/a.txt',
      'D:/proj/b.txt',
      'D:/proj/c.txt',
    ])
    expect(paths(extractShellWriteCandidates("sc -LiteralPath 'D:\\proj\\lit.txt' -Value 1; Out-File -File prefix.txt", PS))).toEqual(['D:/proj/lit.txt', 'D:/proj/prefix.txt'])
  })

  it('Copy-Item, Move-Item, Rename-Item and Remove-Item follow their parameters', () => {
    expect(paths(extractShellWriteCandidates('Copy-Item a.txt -Destination out', PS))).toEqual(['D:/proj/out', 'D:/proj/out/a.txt'])
    const mv = extractShellWriteCandidates('Move-Item -Path old.txt -Dest new.txt', PS)
    expect(paths(mv)).toEqual(['D:/proj/new.txt', 'D:/proj/new.txt/old.txt', 'D:/proj/old.txt'])
    expect(paths(extractShellWriteCandidates('Rename-Item src\\a.txt b.txt', PS))).toEqual(['D:/proj/src/a.txt', 'D:/proj/src/b.txt'])
    const rm = extractShellWriteCandidates('Remove-Item -Recurse -Force build, dist', PS)
    expect(rm.map(c => [slashed(c.path), c.onDirectory])).toEqual([
      ['D:/proj/build', 'tree'],
      ['D:/proj/dist', 'tree'],
    ])
    expect(shaped(extractShellWriteCandidates('rm a.txt', PS))).toEqual([{ path: 'D:/proj/a.txt', source: 'writer', onDirectory: 'skip' }])
  })

  it('New-Item names the file (and -Path + -Name joined) but not a directory', () => {
    expect(paths(extractShellWriteCandidates('New-Item -Path src -Name new.ts -ItemType File', PS))).toEqual(['D:/proj/src/new.ts'])
    expect(paths(extractShellWriteCandidates('ni note.md', PS))).toEqual(['D:/proj/note.md'])
    expect(extractShellWriteCandidates('New-Item -ItemType Directory -Path out', PS)).toEqual([])
  })

  it('reads script blocks and subexpressions, ignores $null, follows Set-Location', () => {
    expect(paths(extractShellWriteCandidates('Get-ChildItem *.log | ForEach-Object { Remove-Item $_ }; "x" > $null', PS))).toEqual([])
    expect(paths(extractShellWriteCandidates('(Get-Content a.txt) -replace "x","y" | Set-Content a.txt', PS))).toEqual(['D:/proj/a.txt'])
    expect(paths(extractShellWriteCandidates('Set-Location sub; "x" > a.txt', PS))).toEqual(['D:/proj/sub/a.txt'])
    expect(paths(extractShellWriteCandidates('[IO.File]::WriteAllText("D:\\proj\\w.txt", "x")', PS))).toEqual(['D:/proj/w.txt'])
  })

  it('reads external commands with the bash rules and names nothing for read-only cmdlets', () => {
    expect(paths(extractShellWriteCandidates('git checkout -- a.ts; npx prettier --write b.ts', PS))).toEqual(['D:/proj/a.ts', 'D:/proj/b.ts'])
    expect(extractShellWriteCandidates('Get-Content a.txt | Select-String foo; Test-Path b.txt; Get-ChildItem -Recurse src', PS)).toEqual([])
  })
})
