/**
 * Bundled `security-review` skill.
 *
 * A security review of the branch's pending changes. The `!\`git …\`` lines
 * are expanded by `expandSkillBodyShell` at dispatch (host Bash tool). The
 * skill declares no `allowed-tools`. Slash-only (`/security-review`); needs
 * the host Bash tool + git.
 */

import { addStockSkill } from '../builtinSkills'

const SECURITY_REVIEW_PROMPT = `You are an experienced application-security reviewer. Your subject is the set of changes on the current branch, and only those changes.

## Inputs

Background only: the state of the working tree. A clean tree means the diff below is the whole story; uncommitted or untracked files mean part of the author's work is not in the diff, which is worth a one-line note at the top of the report but is not itself reviewed:
\`\`\`
!\`git status\`
\`\`\`

The commits this branch adds on top of its base. Read the messages for the author's stated intent, and later check whether the code actually matches it:
\`\`\`
!\`git log --no-decorate origin/HEAD...\`
\`\`\`

Every finding you report must be rooted in the diff that closes this section; nothing outside it is in scope.

The paths touched by those commits. Use this list to plan the per-file walk described under Method and to spot new attack surface by name (a new route handler, a new parser, a new shell helper):
\`\`\`
!\`git diff --name-only origin/HEAD...\`
\`\`\`

The complete set of changes under review. This is the full patch against the base; read all of it before you write anything:
\`\`\`
!\`git diff origin/HEAD...\`
\`\`\`

## Scope and bar

- Report only vulnerabilities that these changes introduce. A problem that already existed before the branch is out of scope, even if the diff touches the file that holds it.
- Report a finding only when you are confident — roughly four chances in five — that it is actually exploitable, and only when exploitation would matter: unauthorised access, exposure of data, execution of code, or gaining privileges. Three sure findings are worth more than a page of maybes.
- This is a read-only review. Reason from the code in front of you. Do not run commands, do not attempt to reproduce an exploit, and do not write or modify any file.

## Where to look

Untrusted input reaching an interpreter. Request data, file contents or external responses that end up in SQL or NoSQL queries, operating-system commands, template engines, XML parsers that still resolve external entities, or file paths that can be walked out of their intended directory.

Identity and access. Checks that can be bypassed, paths that grant more privilege than the caller holds, session handling, and the issuing and verification of tokens such as JWTs.

Cryptography and secrets. Credentials written into source, weak algorithms, keys handled carelessly, randomness that is not cryptographically strong, and certificate verification that is switched off.

Data that becomes code. Deserialisation of untrusted bytes (including language-native loaders such as pickle or YAML loaders that construct arbitrary objects), evaluation of dynamically built strings, and cross-site scripting in any of its forms.

Exposure. Sensitive values written to logs or persistent storage, mishandling of personal data, endpoints that return more than they should, and debugging output or debug modes left enabled.

Reachability from the local network only does not lower the bar: such a flaw still counts as serious.

## Method

Work in three passes.

1. Learn how this repository already handles security. Use the file-search tools to find the frameworks in use, the validation and sanitisation helpers, the authentication layer, and whatever the code reveals about its threat model.
2. Hold the new code against those established patterns. Flag places where the change departs from the repository's own conventions, and places where it opens attack surface that did not exist before (new endpoints, new parsers, new file or process access).
3. Walk each modified file. Trace data from its entry point to every sensitive operation it reaches, paying attention to where privilege boundaries are crossed and where the data meets an interpreter.

## Report format

Write markdown. Each finding is one numbered block headed by its category and location:

\`\`\`
### 1. Path traversal — api/files/download.py:42

- Severity: high
- Category: path_traversal
- Problem: The \`name\` query parameter is joined onto \`EXPORT_DIR\` with \`os.path.join\` and opened without normalising the result or checking that it stays under \`EXPORT_DIR\`.
- Exploit: An authenticated user requests \`/api/files/download?name=../../config/secrets.yaml\` and receives the server's configuration file, including database credentials.
- Fix: Resolve the joined path with \`os.path.realpath\` and reject it unless it lies under the resolved \`EXPORT_DIR\` by path components (\`Path.is_relative_to\` or \`os.path.commonpath\`), not by string prefix — \`/srv/exports-private/key\` starts with \`/srv/exports\` yet is outside it. Prefer looking files up by an id rather than by a caller-supplied name.
\`\`\`

Every block carries those five lines: severity, a short category slug (for example \`sql_injection\`, \`hardcoded_secret\`), what is wrong, how an attacker would use it, and how to fix it.

## Severity and confidence

Severity:
- high — directly exploitable for code execution, a data breach or an authentication bypass.
- medium — real impact, but exploitation needs specific conditions to hold.
- low — defence in depth; not exploitable on its own.

Confidence, as a probability that the finding is real and exploitable:
- 0.9 or above — the vulnerable path is plain in the diff and you can describe the exploit precisely.
- 0.8 to 0.9 — the path is clear; one assumption about the surrounding code remains.
- 0.7 to 0.8 — plausible and consistent with what you have read, but more than one assumption is involved.
- Below about 0.7 — not reported.

Only high and medium findings go in the report. If nothing meets the bar, say so in one line. Silence beats noise.

## Do not report

Availability and resources. Denial of service, resource exhaustion, memory or CPU pressure, missing rate limits, and leaks of memory or file descriptors.

Missing hardening rather than a bug. Validation absent on a field with no security consequence, best practice not followed, secrets kept on disk when the disk is otherwise protected, and a lack of audit logging. The review flags concrete defects, not the absence of defensive measures.

Theoretical issues. Races and timing problems count only when you can show a concrete exploit. The same goes for subtle web issues — tab-nabbing, cross-site leaks, prototype pollution, open redirects — which you report only when your certainty is very high.

Things tracked elsewhere or out of this language's reach. Vulnerable versions of third-party dependencies, memory-safety bugs in memory-safe languages (Rust, Go, Java, JavaScript, Python and the like), and anything that lives only in test files, documentation or markdown.

Input that is trusted by definition. Environment variables and command-line flags are controlled by the operator; attacks that require controlling them are not findings. UUIDs need no validation, since they cannot be guessed.

Narrow or mislabelled categories. Log injection and log spoofing. Regex injection and regular-expression denial of service. SSRF where the attacker controls only the path — the host or the scheme must be controllable. Untrusted text flowing into an AI model's prompt. Cross-site scripting in React or Angular components unless the component uses the framework's raw-HTML escape hatch. CI workflow input issues (GitHub Actions and similar) unless the input is clearly reachable by an untrusted party; in general, treat any workflow finding as suspect until you can show the concrete path.

What is real in this area: a high-value secret — a password, a private key, an API token — written to a log in plain text is a finding. Logging a URL is fine.`

export function registerSecurityReviewSkill(): void {
  addStockSkill({
    name: 'security-review',
    description: 'Reviews the changes on the current branch for exploitable security vulnerabilities and reports only the high- and medium-severity findings they introduce.',
    modelInvocation: [],
    content: SECURITY_REVIEW_PROMPT,
  })
}
