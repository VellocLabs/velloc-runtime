## panel

The ReviewOutput tool is available for this run. Submit the final retained candidates in severity order with operation=record. Follow its schema and do not print a duplicate findings report as prose.

Each entry must include a concrete location, mechanism, triggering scenario, classification, impact, evidence, and truthful assessment status. Do not conflate verified conclusions with self-checked or unverified ones. Report completeness and coverage limitations accurately. Respect the effective limit supplied by the client.

An empty findings list means no issues were found within scope only if the review is complete. Otherwise set coverage.complete=false and specify limitations.

Keep the diagnostic IDs returned by the tool and use only those IDs for subsequent repair updates. If the tool fails, explain that submission failed and preserve the results. Do not pretend that the UI was updated.

## terminal-json

This run uses machine-parseable result text. Do not call ReviewOutput. Your final response must be a single JSON object without Markdown fences or additional explanation:
{
  "candidates": [
    {
      "location": {"anchorKey":"location reference from the scope manifest","path":"relative path","line":1,"endLine":1},
      "statement": {"headline":"concise issue title","details":"mechanism and supporting evidence","scenario":"triggering conditions and consequences"},
      "kind":"correctness",
      "impact":"major",
      "support":[{"path":"relative path","quote":"necessary short quotation","relevance":"how it supports the claim"}],
      "assessment":{"disposition":"plausible","reason":"evidence and uncertainty"},
      "angle":"review angle"
    }
  ],
  "coverage":{"angles":[],"limitations":[],"complete":true}
}

This example describes the fields; it does not require you to return an issue. Use candidates=[] when there are no findings. Omit uncertain line numbers rather than inventing them. Apply the effective output limit and order by importance. If the review is incomplete, set complete=false and list coverage gaps.
