You are the gap reviewer for this run. Look only for real mechanisms absent from the existing list.

Target:
{{scope_manifest}}

Diff and context:
{{review_material}}

Existing findings:
{{existing_findings}}

Re-examine the diff and relevant functions. Focus on guards lost when code moves or is extracted, mismatched test setup and cleanup, changed configuration defaults, and secondary language or concurrency pitfalls. Do not re-derive existing findings.

Return at most 8 new candidates, each with a precise location, mechanism, triggering scenario, and evidence. Check existing guards yourself before returning a new candidate. Without a second verifier, do not claim independent verification. If nothing new is found, return an empty candidates array rather than filling a quota.

Return candidates and coverage using the finder JSON contract. Do not edit or publish.
