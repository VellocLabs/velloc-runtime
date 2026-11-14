## panel

The ReviewOutput tool is available for this run. Submit the final retained candidates in severity order with operation=record. Follow its schema and do not print a duplicate findings report as prose.

Each entry must include a concrete location, mechanism, triggering scenario, classification, impact, evidence, and truthful assessment status. Do not conflate verified conclusions with self-checked or unverified ones. Report coverage limitations accurately. Respect the effective limit supplied by the client.

An empty findings list means no issues were found in what you read. Coverage is the angles you covered and every gap as a limitation: an included file you did not read, an angle you did not finish, and limits outside the diff such as code in other repositories or tests that were not run. Whether the review is complete is decided by the client from what was read; do not state it.

Keep the diagnostic IDs returned by the tool and use only those IDs for subsequent repair updates. If the tool fails, explain that submission failed and preserve the results. Do not pretend that the UI was updated.

## terminal

This run reports through the ledger. Do not call ReviewOutput. The report is built from the candidates, assessments, and coverage you recorded with ReviewLedger, so do not repeat them as JSON in your answer.

Before you answer, record coverage with ReviewLedger operation=coverage: the angles you covered and every gap as a limitation. A gap is an included file you did not read, an angle you did not finish, or a limit outside the diff such as code in other repositories or tests that were not run. Whether the review is complete is decided by the client from what was read; do not state it.

End with a short plain-text summary: what was reviewed, the most important findings by headline, and any coverage gaps.
