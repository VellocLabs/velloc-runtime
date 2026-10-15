// One-command interface bump (npm run version:bump): bumps
// NEXUS_INTERFACE_VERSION in its single source, the sibling
// src/custom_browser/VERSION, and regenerates interfaceVersion.gen.ts via
// check_interface_version.py --sync. The VERSION edit is left uncommitted in
// the browser repo; the ninja gate stays red until that commit lands.
// Run it before the contract change, which ships at /v<N+1>/. (G-3)
// A clean working tree is enforced because this script creates commits.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const genTsPath = path.join(
  repoRoot, 'src', 'browser', 'bridge', 'protocol', 'interfaceVersion.gen.ts')
const cppVersionPath = path.join(
  repoRoot, '..', 'src', 'custom_browser', 'VERSION')
const syncScriptPath = path.join(
  repoRoot, '..', 'src', 'custom_browser', 'browser', 'nexus', 'scripts',
  'check_interface_version.py')

function fail(message) {
  console.error(`bump_interface_version: ${message}`)
  process.exit(1)
}

function git(args, opts = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
  })
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} failed` +
         (result.stderr ? `: ${result.stderr.trim()}` : ''))
  }
  return result.stdout ?? ''
}

function readTsVersion() {
  const match = /^export const NEXUS_INTERFACE_VERSION = (\d+)$/m.exec(
    fs.readFileSync(genTsPath, 'utf8'))
  if (!match) {
    fail(`could not parse NEXUS_INTERFACE_VERSION from ${genTsPath}`)
  }
  return Number.parseInt(match[1], 10)
}

function readSourceVersion() {
  const match = /^NEXUS_INTERFACE_VERSION=(\d+)\s*$/m.exec(
    fs.readFileSync(cppVersionPath, 'utf8'))
  if (!match) {
    fail(`could not parse NEXUS_INTERFACE_VERSION from ${cppVersionPath}`)
  }
  return Number.parseInt(match[1], 10)
}

// Regenerates interfaceVersion.gen.ts from the sibling VERSION file (the
// same generator the ninja gate checks against).
function runSync() {
  const result = spawnSync('python', [syncScriptPath, '--sync'],
                           { cwd: repoRoot, stdio: 'inherit' })
  if (result.status !== 0) {
    fail(`check_interface_version.py --sync failed (exit ${result.status}) ` +
         '— is python on PATH?')
  }
}

function main() {
  // A dirty tree would tangle unrelated files into the bump commit.
  if (git(['status', '--porcelain']).trim() !== '') {
    fail('working tree not clean — commit or stash everything first ' +
         '(this script creates a commit)')
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (branch !== 'main') {
    fail(`on branch '${branch}' — interface bumps deploy from main; ` +
         'switch to main first')
  }

  // The single source of truth lives in the sibling browser checkout;
  // without it the bump cannot be made at all.
  if (!fs.existsSync(cppVersionPath)) {
    fail(`no sibling checkout at ${cppVersionPath} — the interface version ` +
         'is defined there (single source of truth); restore the checkout')
  }
  const from = readSourceVersion()
  if (readTsVersion() !== from) {
    fail(`committed ${path.basename(genTsPath)} (v${readTsVersion()}) does ` +
         `not match ${cppVersionPath} (v${from}) — the tree is already ` +
         'drifted. Run check_interface_version.py --sync, commit, and retry.')
  }
  const to = from + 1
  console.log(`bump_interface_version: v${from} -> v${to}`)
  console.log('REMINDER: run this BEFORE the contract change — the contract ' +
              `work itself lands AFTER this bump and ships at /v${to}/.`)

  // Bump the single source (sibling src/custom_browser/VERSION) and
  // regenerate the committed TS artifact from it. There is no freeze step:
  // the last v${from}-compatible bundle is the published runtime-v${from}-*
  // release, archived when it was promoted.
  console.log(`\n==> bump ${cppVersionPath} to ${to} + --sync`)
  const versionSource = fs.readFileSync(cppVersionPath, 'utf8')
  fs.writeFileSync(cppVersionPath, versionSource.replace(
    `NEXUS_INTERFACE_VERSION=${from}`,
    `NEXUS_INTERFACE_VERSION=${to}`))
  if (readSourceVersion() !== to) {
    fail(`VERSION rewrite failed — ${cppVersionPath} left modified, inspect it`)
  }
  runSync()
  if (readTsVersion() !== to) {
    fail('sync did not produce the bumped constant — inspect ' +
         `${genTsPath} and ${cppVersionPath}`)
  }

  git(['add', '--', path.relative(repoRoot, genTsPath)])
  git(['commit', '-m',
       `feat: bump bridge interface version to ${to}`], { inherit: true })

  console.log(`
Done. The VERSION bump in ${cppVersionPath} is UNCOMMITTED. Next steps:
  1. Make the contract change.
  2. Land it on main (author -> review -> merge). Pushing main deploys
     nothing.
  3. Run "A · Build & Deploy Beta" from main and soak
     https://beta.velloc.app/v${to}/. It is the first /v${to}/ deploy, so it
     correctly starts with no retention baseline.
  4. Run "B · Promote Production" with that run id and release tag
     runtime-v${to}-<date>.1, then verify https://app.velloc.app/v${to}/
     loads standalone BEFORE shipping the binary.
  5. Commit the VERSION bump (+ contract change) in the browser repo —
     the paired commit; the ninja gate stays red until it lands. The C++
     header needs no edit (nexus_interface_version.inc is generated at
     build time), and the app version's third field follows automatically.`)
}

main()
