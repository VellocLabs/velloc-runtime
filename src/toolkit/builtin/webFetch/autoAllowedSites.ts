/**
 * Security: sites WebFetch may read without asking. Consulted for WebFetch's
 * read-only GET only; never reuse it as a network allow-list (several accept
 * uploads). A bare hostname allows the whole site; `host/path` that path and below.
 * Hostnames match exactly: no subdomains, no parent domains.
 */

/** Grouped by what the documentation covers; alphabetical within a group. */
export const AUTO_ALLOWED_SITE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  agentTooling: [
    'agentskills.io',
    'code.claude.com',
    'github.com/anthropics',
    'modelcontextprotocol.io',
    'platform.claude.com',
  ],
  languageReferences: [
    'developer.mozilla.org',
    'doc.rust-lang.org',
    'docs.oracle.com',
    'docs.python.org',
    'docs.swift.org',
    'en.cppreference.com',
    'go.dev',
    'kotlinlang.org',
    'pkg.go.dev',
    'ruby-doc.org',
    'www.php.net',
    'www.typescriptlang.org',
  ],
  vendorPlatforms: [
    'asp.net',
    'blazor.net',
    'cloud.google.com',
    'devcenter.heroku.com',
    'developer.android.com',
    'developer.apple.com',
    'docs.aws.amazon.com',
    'docs.netlify.com',
    'dotnet.microsoft.com',
    'learn.microsoft.com',
    'nuget.org',
    'vercel.com/docs',
  ],
  javascriptEcosystem: [
    'angular.io',
    'bun.sh',
    'cypress.io',
    'd3js.org',
    'expressjs.com',
    'getbootstrap.com',
    'jestjs.io',
    'jquery.com',
    'nextjs.org',
    'nodejs.org',
    'react.dev',
    'reactnative.dev',
    'reactrouter.com',
    'redux.js.org',
    'selenium.dev',
    'tailwindcss.com',
    'threejs.org',
    'vuejs.org',
    'webpack.js.org',
  ],
  pythonAndMachineLearning: [
    'docs.djangoproject.com',
    'fastapi.tiangolo.com',
    'flask.palletsprojects.com',
    'huggingface.co',
    'jupyter.org',
    'keras.io',
    'matplotlib.org',
    'numpy.org',
    'pandas.pydata.org',
    'pytorch.org',
    'requests.readthedocs.io',
    'scikit-learn.org',
    'www.kaggle.com',
    'www.tensorflow.org',
  ],
  serverSideFrameworks: [
    'docs.spring.io',
    'gradle.org',
    'hibernate.org',
    'laravel.com',
    'maven.apache.org',
    'symfony.com',
    'tomcat.apache.org',
    'wordpress.org',
  ],
  dataStores: [
    'dev.mysql.com',
    'graphql.org',
    'prisma.io',
    'redis.io',
    'spark.apache.org',
    'www.mongodb.com',
    'www.postgresql.org',
    'www.sqlite.org',
  ],
  infrastructure: [
    'git-scm.com',
    'httpd.apache.org',
    'kubernetes.io',
    'nginx.org',
    'www.ansible.com',
    'www.docker.com',
    'www.terraform.io',
  ],
  appAndGameEngines: [
    'docs.flutter.dev',
    'docs.unity.com',
    'docs.unrealengine.com',
  ],
}

/** `true` = the whole site; an array = only these path scopes on that host. */
type SiteScope = true | string[]

function buildScopeIndex(): Map<string, SiteScope> {
  const index = new Map<string, SiteScope>()
  for (const entries of Object.values(AUTO_ALLOWED_SITE_GROUPS)) {
    for (const entry of entries) {
      const cut = entry.indexOf('/')
      const host = cut < 0 ? entry : entry.slice(0, cut)
      const known = index.get(host)
      if (cut < 0) {
        index.set(host, true)
      } else if (known === undefined) {
        index.set(host, [entry.slice(cut)])
      } else if (known !== true) {
        known.push(entry.slice(cut))
      }
    }
  }
  return index
}

const scopeByHost = buildScopeIndex()

function pathWithinScope(pathname: string, scope: string): boolean {
  if (!pathname.startsWith(scope)) return false
  return pathname.length === scope.length || pathname[scope.length] === '/'
}

/**
 * Whether a fetch of `hostname` + `pathname` (as `URL` parses them) is
 * auto-allowed without a permission prompt.
 */
export function isAutoAllowedFetch(hostname: string, pathname: string): boolean {
  const scope = scopeByHost.get(hostname)
  if (scope === undefined) return false
  if (scope === true) return true
  return scope.some(prefix => pathWithinScope(pathname, prefix))
}
