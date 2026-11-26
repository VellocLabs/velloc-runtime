// Frees Actions artifact storage by deleting `candidate` artifacts (G-3).
// --quota-bytes <N> [--ratio] [--incoming <dir>]: oldest first until storage fits.
// --retain-newest <N> [--this-run <id>]: keep the newest N successful builds.
// Every mode keeps each --keep-run <id> and, with --protect-pending-promotes,
// the candidate each unfinished promote names. Also --name, --dry-run.
// Env: GH_TOKEN (needs `actions: write`), GITHUB_REPOSITORY, GITHUB_API_URL.
import fs from 'node:fs'
import path from 'node:path'

import { isMainModule } from './lib/isMainModule.mjs'
import { asList, parseArgs } from './pack_artifact.mjs'

export const DEFAULT_RATIO = 0.7
export const BUILD_WORKFLOW = 'build-beta.yml'
export const PROMOTE_WORKFLOW = 'promote-production.yml'
// promote-production.yml's `run-name`, which ends in the candidate run id.
const PROMOTE_TITLE = /^B · Promote candidate run (\d+)$/

// Thrown, not exited: exiting with a fetch still open aborts Node on Windows.
function fail(message) {
  throw new Error(message)
}

const runOf = artifact => String(artifact.workflow_run?.id ?? '')

/**
 * Every live artifact called `name` whose run id is not in `keepRunIds`,
 * oldest first. Throws when no run id is kept, so a missing id can never
 * delete every candidate.
 */
export function planKeepOnly({ artifacts, keepRunIds, name = 'candidate' }) {
  const keep = new Set(keepRunIds.map(String).filter(Boolean))
  if (keep.size === 0) throw new Error('keep-only needs at least one --keep-run')
  const deletions = artifacts
    .filter(a => !a.expired && a.name === name && !keep.has(String(a.workflow_run?.id ?? '')))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)
  return { deletions }
}

/**
 * Keeps the live candidates of the `newest` highest run ids among
 * `successfulRunIds` (run ids grow with creation time; a run whose candidate
 * is already gone does not take a place), plus every run in `keepRunIds`.
 * Deletes every other live candidate, oldest first.
 */
export function planRetain({ artifacts, successfulRunIds, newest, keepRunIds = [], name = 'candidate' }) {
  if (!(Number.isInteger(newest) && newest >= 1)) {
    throw new Error(`--retain-newest must be a whole number of at least 1, got ${newest}`)
  }
  const withCandidate = new Set(artifacts.filter(a => !a.expired && a.name === name).map(runOf))
  const recent = [...new Set(successfulRunIds.map(String))]
    .filter(id => /^\d+$/.test(id) && withCandidate.has(id))
    .sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : BigInt(a) > BigInt(b) ? -1 : 0))
    .slice(0, newest)
  const kept = [...new Set([...recent, ...keepRunIds.map(String).filter(Boolean)])]
  if (kept.length === 0) return { deletions: [], kept }
  return { ...planKeepOnly({ artifacts, keepRunIds: kept, name }), kept }
}

/**
 * Candidate run ids named by promote runs that have not completed. A promote
 * downloads its candidate in `resolve` and again in `deploy`; deleting it in
 * between fails the deploy half.
 */
export function pendingPromoteRunIds(promoteRuns) {
  return promoteRuns
    .filter(run => run.status !== 'completed')
    .map(run => PROMOTE_TITLE.exec(run.display_title ?? '')?.[1])
    .filter(Boolean)
}

/**
 * Picks the artifacts to delete, oldest first, so that live bytes plus
 * `incomingBytes` stay within `quotaBytes * ratio`. Expired artifacts hold
 * no storage and are ignored. Only artifacts called `name` are candidates
 * for deletion; the newest of those and any whose run id is in `keepRunIds`
 * are protected. `overBudget` is true when the protected set alone does not
 * fit — the caller warns, it does not fail.
 */
export function planPrune({
  artifacts, quotaBytes, ratio = DEFAULT_RATIO, incomingBytes = 0,
  keepRunIds = [], name = 'candidate',
}) {
  if (!(quotaBytes > 0)) throw new Error(`quotaBytes must be positive, got ${quotaBytes}`)
  if (!(ratio > 0 && ratio <= 1)) throw new Error(`ratio must be in (0, 1], got ${ratio}`)
  const budgetBytes = Math.floor(quotaBytes * ratio)
  const live = artifacts.filter(a => !a.expired)
  const liveBytes = live.reduce((sum, a) => sum + a.size_in_bytes, 0)

  const keep = new Set(keepRunIds.map(String).filter(Boolean))
  const named = live
    .filter(a => a.name === name)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)
  const newest = named.at(-1)
  const deletable = named.filter(a => a !== newest && !keep.has(runOf(a)))

  const deletions = []
  let projected = liveBytes + incomingBytes
  for (const artifact of deletable) {
    if (projected <= budgetBytes) break
    deletions.push(artifact)
    projected -= artifact.size_in_bytes
  }
  return {
    deletions, liveBytes, budgetBytes, projectedBytes: projected,
    overBudget: projected > budgetBytes,
  }
}

/** Total size of the regular files under `dir`, in bytes. */
export function directoryBytes(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += directoryBytes(full)
    else if (entry.isFile()) total += fs.statSync(full).size
  }
  return total
}

function mb(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`
}

async function github(method, route) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com'
  const res = await fetch(`${api}${route}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) fail(`${method} ${route}: HTTP ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

async function listArtifacts(repo) {
  const all = []
  for (let page = 1; ; page += 1) {
    const body = await github('GET', `/repos/${repo}/actions/artifacts?per_page=100&page=${page}`)
    all.push(...body.artifacts)
    if (body.artifacts.length < 100) return all
  }
}

async function workflowRuns(repo, workflow, query = '') {
  const body = await github('GET',
    `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=100${query}`)
  return body.workflow_runs
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const retainNewest = args['retain-newest'] === undefined ? undefined : Number(args['retain-newest'])
  const quotaBytes = Number(args['quota-bytes'])
  const ratio = args.ratio === undefined ? DEFAULT_RATIO : Number(args.ratio)
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) fail('GITHUB_REPOSITORY is not set')
  if (!process.env.GH_TOKEN) fail('GH_TOKEN is not set')
  const incomingBytes = typeof args.incoming === 'string' ? directoryBytes(args.incoming) : 0
  const keepRunIds = asList(args['keep-run']).map(String)
  const name = typeof args.name === 'string' ? args.name : 'candidate'
  if (args['protect-pending-promotes']) {
    const pending = pendingPromoteRunIds(await workflowRuns(repo, PROMOTE_WORKFLOW))
    if (pending.length) console.log(`keeping the candidate of each unfinished promote: run(s) ${pending.join(', ')}`)
    keepRunIds.push(...pending)
  }

  const artifacts = await listArtifacts(repo)
  let plan
  if (retainNewest !== undefined) {
    const successful = (await workflowRuns(repo, BUILD_WORKFLOW, '&status=success')).map(run => run.id)
    if (typeof args['this-run'] === 'string' || typeof args['this-run'] === 'number') {
      successful.push(String(args['this-run']))
    }
    plan = planRetain({ artifacts, successfulRunIds: successful, newest: retainNewest, keepRunIds, name })
    console.log(`keeping the ${name} artifacts of run(s) ${plan.kept.join(', ') || 'none'}`)
  } else {
    plan = planPrune({ artifacts, quotaBytes, ratio, incomingBytes, keepRunIds, name })
    console.log(`artifact storage: ${mb(plan.liveBytes)} live + ${mb(incomingBytes)} incoming, ` +
      `budget ${mb(plan.budgetBytes)} (${Math.round(ratio * 100)}% of ${mb(quotaBytes)})`)
  }
  for (const artifact of plan.deletions) {
    const run = artifact.workflow_run?.id ?? 'no run'
    console.log(`${args['dry-run'] ? 'would delete' : 'deleting'} artifact ${artifact.id} ` +
      `(${artifact.name}, run ${run}, ${artifact.created_at}, ${mb(artifact.size_in_bytes)})`)
    if (!args['dry-run']) await github('DELETE', `/repos/${repo}/actions/artifacts/${artifact.id}`)
  }
  if (plan.overBudget) {
    console.log(`::warning::artifact storage stays at ${mb(plan.projectedBytes)} after pruning, ` +
      `over the ${mb(plan.budgetBytes)} budget — only protected artifacts are left.`)
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(`prune_artifacts: ${error.message}`)
    process.exitCode = 1
  }
}
