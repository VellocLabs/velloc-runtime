// Refuses a beta deploy that would put an older commit on beta after a newer
// one (G-3). Run by Workflow A's `deploy` job before it touches beta.
// Flags: --commit <sha> --branch <name> --event <push|workflow_dispatch>
//   [--deploy-older <true|false>]
// Env: GH_TOKEN (`contents: read`), GITHUB_REPOSITORY, GITHUB_API_URL.
// Exit 0: deploy. Exit 1: do not deploy; the run fails.
import { isMainModule } from './lib/isMainModule.mjs'

/**
 * Contract: `status` is GitHub's compare status of `<commit>...<branch>`:
 * `identical` (the commit is the branch tip), `ahead` (the branch has moved
 * past the commit), `behind` (the commit is ahead of the branch) or
 * `diverged`. Returns { deploy, line }.
 *
 * A push run deploys only its branch's tip. A dispatch is refused only when
 * the branch has moved past its commit, unless `deployOlder` says that is
 * the point; a dispatch of a ref off the branch (a hotfix) is deliberate.
 */
export function deployOrderVerdict({ status, event, deployOlder = false, commit, branch }) {
  const short = String(commit).slice(0, 12)
  if (status === 'identical') {
    return { deploy: true, line: `${short} is ${branch}'s tip — deploying` }
  }
  if (event === 'push') {
    return {
      deploy: false,
      line: `::error::${branch} has moved on from ${short} (${status}); the run for ` +
        `${branch}'s tip deploys it instead. Not deploying, and failing this run so ` +
        'promote refuses it.',
    }
  }
  if (status === 'ahead') {
    if (deployOlder) {
      return { deploy: true, line: `::warning::${branch} has moved past ${short}; deploying it anyway (deploy_older)` }
    }
    return {
      deploy: false,
      line: `::error::${branch} has moved past ${short}; deploying it would put an older ` +
        `build on beta. Dispatch ${branch}'s tip, or set deploy_older to mean it.`,
    }
  }
  if (status === 'behind' || status === 'diverged') {
    return { deploy: true, line: `${short} is not on ${branch} (${status}) — deploying the dispatched ref` }
  }
  return { deploy: false, line: `::error::unexpected compare status '${status}' for ${short}...${branch}` }
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function compareStatus(repo, commit, branch) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com'
  const route = `/repos/${repo}/compare/${commit}...${encodeURIComponent(branch)}`
  const res = await fetch(`${api}${route}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) throw new Error(`GET ${route}: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()).status
}

async function main(args) {
  const commit = flag(args, 'commit')
  const branch = flag(args, 'branch')
  const event = flag(args, 'event')
  const repo = process.env.GITHUB_REPOSITORY
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error(`--commit must be a full sha, got '${commit}'`)
  if (!branch || !event) throw new Error('--branch and --event are required')
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set')
  const status = await compareStatus(repo, commit, branch)
  const verdict = deployOrderVerdict({
    status, event, commit, branch, deployOlder: flag(args, 'deploy-older') === 'true',
  })
  console.log(verdict.line)
  return verdict.deploy ? 0 : 1
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::beta_deploy_order: ${error.message}`)
    process.exitCode = 1
  }
}
