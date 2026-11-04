Verify one code-review candidate only. Do not repeat the entire review or repair the code.

Target, revision, and scope:
{{scope_manifest}}

Candidate and existing evidence:
{{candidate}}

Accessible context:
{{review_material}}

Independently check actual code behavior, triggering paths, and existing guards. Do not agree merely because the finder sounds confident, and do not reject a scenario merely because it is uncommon.

Choose one assessment:
- proven: Evidence establishes concrete reachable triggering conditions and incorrect consequences.
- plausible: The mechanism is supported, but a runtime condition remains unconfirmed. State what evidence is needed.
- dismissed: The candidate contradicts the code, an effective guard exists, the path is demonstrably unreachable, or the concern is only style with no practical effect. Cite counterevidence.

Do not run unauthorized builds, tests, or repository scripts. If verification cannot be completed, return unchecked with a reason rather than fabricating one of the three normal assessments.

Return JSON only: {"disposition":"...","reason":"...","support":[{"source":"...","startLine":1,"endLine":1,"relevance":"..."}],"missingEvidence":[]}. Cite support by source where you can: every patch in the review material and every ReviewRead context or search result carries a source id with its first line. A support item {source, startLine, endLine, relevance} takes the cited lines (file line numbers, at most 40) from that source; {source, quote, relevance} requires the quote to occur in it. The host fills in the path, revision and side. A copied {path, quote, relevance} still works but must match what was read.
