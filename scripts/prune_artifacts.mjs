// Frees Actions artifact storage before a candidate upload (G-3): when this
// repository's live artifacts plus the incoming one exceed a share of the
// storage quota, deletes the oldest `candidate` artifacts until they fit.
// The newest candidate and every artifact of a --keep-run run are never
// deleted. Other artifact names count toward the total but are left alone.
// Flags: --quota-bytes <N> [--ratio <0..1>] [--incoming <dir>]
//   [--keep-run <id>]... [--name <artifact>] [--dry-run]
// Env: GH_TOKEN (needs `actions: write`), GITHUB_REPOSITORY, GITHUB_API_URL.
import fs from 'node:fs'
import path from 'node:path'

import { isMainModule } from './lib/isMainModule.mjs'
import { parseArgs } from './pack_artifact.mjs'

export const DEFAULT_RATIO = 0.7

function fail(message) {
  console.error(`prune_artifacts: ${message}`)
  process.exit(1)
}

function asList(value) {
  if (value === undefined || value === true) return []
  return Array.isArray(value) ? value : [value]
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
  const deletable = named.filter(a =>
    a !== newest && !keep.has(String(a.workflow_run?.id ?? '')))

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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const quotaBytes = Number(args['quota-bytes'])
  const ratio = args.ratio === undefined ? DEFAULT_RATIO : Number(args.ratio)
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) fail('GITHUB_REPOSITORY is not set')
  if (!process.env.GH_TOKEN) fail('GH_TOKEN is not set')
  const incomingBytes = typeof args.incoming === 'string' ? directoryBytes(args.incoming) : 0

  let plan
  try {
    plan = planPrune({
      artifacts: await listArtifacts(repo),
      quotaBytes, ratio, incomingBytes,
      keepRunIds: asList(args['keep-run']),
      name: typeof args.name === 'string' ? args.name : 'candidate',
    })
  } catch (error) {
    fail(error.message)
  }

  console.log(`artifact storage: ${mb(plan.liveBytes)} live + ${mb(incomingBytes)} incoming, ` +
    `budget ${mb(plan.budgetBytes)} (${Math.round(ratio * 100)}% of ${mb(quotaBytes)})`)
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
  await main()
}
