## panel

The ReviewOutput tool is available for this run. Submit the final retained candidates in severity order with operation=record. Follow its schema and do not print a duplicate findings report as prose.

Each entry must include a concrete location, mechanism, triggering scenario, classification, impact, evidence, and truthful assessment status. Do not conflate verified conclusions with self-checked or unverified ones. Report completeness and coverage limitations accurately. Respect the effective limit supplied by the client.

An empty findings list means no issues were found within scope only if the review is complete. Otherwise set coverage.complete=false and specify limitations.

Keep the diagnostic IDs returned by the tool and use only those IDs for subsequent repair updates. If the tool fails, explain that submission failed and preserve the results. Do not pretend that the UI was updated.

## terminal

This run reports through the ledger. Do not call ReviewOutput. The report is built from the candidates, assessments, and coverage you recorded with ReviewLedger, so do not repeat them as JSON in your answer.

Before you answer, record coverage with ReviewLedger operation=coverage: the angles you covered, every gap as a limitation, and complete=true only when every included file was read and every selected angle was covered.

End with a short plain-text summary: what was reviewed, the most important findings by headline, and any coverage gaps.
