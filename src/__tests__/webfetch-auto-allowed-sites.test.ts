import { describe, it, expect } from 'vitest'
import {
  AUTO_ALLOWED_SITE_GROUPS,
  isAutoAllowedFetch,
} from '../toolkit/builtin/webFetch/autoAllowedSites'

// Behaviour pinned for WebFetch's built-in auto-allow list: which (hostname,
// pathname) pairs are fetched without a permission prompt.

/** Every whole-site entry, alphabetical. */
const WHOLE_SITES = [
  'agentskills.io', 'angular.io', 'asp.net', 'blazor.net', 'bun.sh',
  'cloud.google.com', 'code.claude.com', 'cypress.io', 'd3js.org',
  'dev.mysql.com', 'devcenter.heroku.com', 'developer.android.com',
  'developer.apple.com', 'developer.mozilla.org', 'doc.rust-lang.org',
  'docs.aws.amazon.com', 'docs.djangoproject.com', 'docs.flutter.dev',
  'docs.netlify.com', 'docs.oracle.com', 'docs.python.org', 'docs.spring.io',
  'docs.swift.org', 'docs.unity.com', 'docs.unrealengine.com',
  'dotnet.microsoft.com', 'en.cppreference.com', 'expressjs.com',
  'fastapi.tiangolo.com', 'flask.palletsprojects.com', 'getbootstrap.com',
  'git-scm.com', 'go.dev', 'gradle.org', 'graphql.org', 'hibernate.org',
  'httpd.apache.org', 'huggingface.co', 'jestjs.io', 'jquery.com',
  'jupyter.org', 'keras.io', 'kotlinlang.org', 'kubernetes.io', 'laravel.com',
  'learn.microsoft.com', 'matplotlib.org', 'maven.apache.org',
  'modelcontextprotocol.io', 'nextjs.org', 'nginx.org', 'nodejs.org',
  'numpy.org', 'nuget.org', 'pandas.pydata.org', 'pkg.go.dev',
  'platform.claude.com', 'prisma.io', 'pytorch.org', 'react.dev',
  'reactnative.dev', 'reactrouter.com', 'redis.io', 'redux.js.org',
  'requests.readthedocs.io', 'ruby-doc.org', 'scikit-learn.org',
  'selenium.dev', 'spark.apache.org', 'symfony.com', 'tailwindcss.com',
  'threejs.org', 'tomcat.apache.org', 'vuejs.org', 'webpack.js.org',
  'wordpress.org', 'www.ansible.com', 'www.docker.com', 'www.kaggle.com',
  'www.mongodb.com', 'www.php.net', 'www.postgresql.org', 'www.sqlite.org',
  'www.tensorflow.org', 'www.terraform.io', 'www.typescriptlang.org',
]

describe('WebFetch auto-allowed sites', () => {
  it('lists exactly the expected sites and path scopes', () => {
    const listed = Object.values(AUTO_ALLOWED_SITE_GROUPS).flat()
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual(
      [...WHOLE_SITES, 'github.com/anthropics', 'vercel.com/docs'].sort(),
    )
  })

  it('allows every whole-site entry at any path', () => {
    for (const host of WHOLE_SITES) {
      expect(isAutoAllowedFetch(host, '/'), host).toBe(true)
      expect(isAutoAllowedFetch(host, '/deep/page.html'), host).toBe(true)
      expect(isAutoAllowedFetch(host, ''), host).toBe(true)
    }
  })

  it('matches the hostname exactly: no subdomains, parents or case folding', () => {
    expect(isAutoAllowedFetch('evil.react.dev', '/')).toBe(false)
    expect(isAutoAllowedFetch('python.org', '/')).toBe(false)
    expect(isAutoAllowedFetch('react.dev.evil.com', '/')).toBe(false)
    expect(isAutoAllowedFetch('React.dev', '/')).toBe(false)
    expect(isAutoAllowedFetch('docker.com', '/')).toBe(false)
    expect(isAutoAllowedFetch('', '/')).toBe(false)
  })

  it('rejects hosts that are not listed', () => {
    expect(isAutoAllowedFetch('example.com', '/')).toBe(false)
    expect(isAutoAllowedFetch('stackoverflow.com', '/questions')).toBe(false)
  })

  it('allows a path-scoped site only at that path segment or below', () => {
    expect(isAutoAllowedFetch('github.com', '/anthropics')).toBe(true)
    expect(isAutoAllowedFetch('github.com', '/anthropics/')).toBe(true)
    expect(isAutoAllowedFetch('github.com', '/anthropics/repo/blob/x')).toBe(true)
    expect(isAutoAllowedFetch('vercel.com', '/docs')).toBe(true)
    expect(isAutoAllowedFetch('vercel.com', '/docs/functions')).toBe(true)
  })

  it('does not extend a path scope to its siblings or the rest of the host', () => {
    expect(isAutoAllowedFetch('github.com', '/')).toBe(false)
    expect(isAutoAllowedFetch('github.com', '')).toBe(false)
    expect(isAutoAllowedFetch('github.com', '/anthropics-evil/x')).toBe(false)
    expect(isAutoAllowedFetch('github.com', '/Anthropics')).toBe(false)
    expect(isAutoAllowedFetch('github.com', '/other/anthropics')).toBe(false)
    expect(isAutoAllowedFetch('vercel.com', '/docsx')).toBe(false)
    expect(isAutoAllowedFetch('vercel.com', '/')).toBe(false)
    expect(isAutoAllowedFetch('www.github.com', '/anthropics')).toBe(false)
  })

  it('does not treat a path-scoped entry as a hostname', () => {
    expect(isAutoAllowedFetch('github.com/anthropics', '/')).toBe(false)
    expect(isAutoAllowedFetch('vercel.com/docs', '')).toBe(false)
  })
})
