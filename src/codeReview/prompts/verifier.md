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

A supported mechanism whose trigger you could neither confirm nor refute is plausible, not dismissed.

Do not run unauthorized builds, tests, or repository scripts. If verification cannot be completed, return unchecked with a reason rather than fabricating one of the three normal assessments.

Hand in by calling ReviewSubmit with {"disposition":"...","reason":"...","support":[{"source":"...","quote":"...","relevance":"..."}],"missingEvidence":[]}. The host checks it at once. When the result lists what it rejected, correct what each hint names and call ReviewSubmit once more; that second call is final. Then end with one short line. When ReviewRead answers review-step-budget, stop reading and hand in now; choose unchecked when what you read does not settle the candidate. Only when ReviewSubmit is not among your tools, return the same object as JSON only. Cite support by source: every patch in the review material and every ReviewRead context or search result carries a source id with its first line. Prefer {source, quote, relevance}, a short quotation that must occur in that source; it shows what you read, and the host fills in the path, revision and side. For a span too long to quote, {source, startLine, endLine, relevance} takes those file lines (at most 40) from the source; a quote may carry startLine and endLine too, and must then occur within those lines. A copied {path, quote, relevance} still works but must match what was read.
