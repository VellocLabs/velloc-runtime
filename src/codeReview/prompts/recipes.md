## quick-hunks

This is a quick diff inspection. Obtain the complete target diff and cover the established scope within the permitted single read. Skip tests and fixtures as specified by the scope configuration. Do not launch subagents or read entire source files.

Report only runtime errors, visible duplication, or residual dead code that can be explained from a hunk and its included context. Leave call-chain, performance, or missing-test concerns that cannot be established from the excerpt to a deeper review. Do not report speculation as a finding in this run.

Produce results after reading, without independent verification or a gap sweep. An empty result is valid. State actual coverage and mark the review incomplete if truncation prevented full inspection.

## quick-expand

This remains a quick diff inspection: do not launch subagents or read entire source files. Follow the scope configuration when deciding whether to skip tests and fixtures.

Focus on incorrect behavior, visible duplication, or dead code that can be explained directly from the diff. If the number of findings is substantially below the smaller of the changed-file count and 4, you may inspect larger changed regions and removed code again. This is a prompt to broaden inspection, not a minimum reporting quota.

If there are fewer genuine issues, report fewer or return an empty result. Never invent findings to meet a target. Respect the effective output limit; if this run has no fixed limit, still order findings by evidence and importance.

## local-eight

Work through the 8 selected angles sequentially within the current review agent. Do not launch subagents for these angles. Retain at most 6 candidates with a concrete mechanism per angle.

After collecting the angle results, deduplicate by root cause and sort by severity only. Do not launch additional verifiers or discard evidence-supported, reachable scenarios through another subjective confidence pass. Candidates without independent verification must retain an unchecked or evidence-supported plausible assessment; do not present them as independently proven.

Report within the output limit after inspection. Fewer findings than the limit is normal. Do not retain unsupported content to fill a quota.

## local-ten

Cover the 10 selected angles sequentially within the current review agent, with at most 8 candidates per angle. Do not create finder or verifier subagents.

Merge duplicate root causes and sort the results. Then reread the diff and relevant functions solely for mechanisms missing from the current list. Focus on guards lost during extraction, asymmetric test cleanup, changed configuration defaults, and secondary language pitfalls. Add at most 8 evidence-supported candidates without re-deriving existing entries.

Record that the gap sweep ran in the same context; do not call it independent verification. Apply the final limit and report uncovered scope.

## team-eight-precise

Cover the 8 independent review angles. Use the available Agent tool to launch finders, grouping or parallelizing them according to the run budget. Give each task the complete target description, relevant diff, applicable rules, and assigned angles. Allow at most 6 candidates per angle.

Aggregate and merge candidates with the same root cause, then assign one independent verifier to each remaining candidate. Provide the candidate, target revision, evidence, and accessible context. Do not use the candidate's finder as its independent verifier.

Retain proven and plausible findings. Remove dismissed findings supported by clear counterevidence. Report actionable issues, not style opinions. If a verifier does not finish, preserve the candidate's unverified status and mark the coverage gap rather than counting verification as passed.

## team-eight-recall

Organize finders around the 8 selected angles, with at most 6 candidates per angle, then assign one independent verifier to each deduplicated candidate. Respect actual agent budgets and permissions.

This run prioritizes avoiding missed defects. Concurrency, cold caches, error paths, default configurations, and uncommon but reachable boundaries must not be rejected merely because they are unlikely. Require actual counterevidence for a dismissed verdict. If the mechanism is supported but a triggering condition needs runtime confirmation, retain plausible and identify the missing evidence.

Do not keep speculation without a concrete mechanism. Sort the final results by impact and disclose unfinished verification and coverage limits.

## team-ten

Run independent finder checks across the 10 selected angles, with at most 8 candidates per angle. Group angles into tasks as the budget requires, but cover every angle. One angle's conclusion must not prevent another angle from reporting a different mechanism.

After merging duplicates, assign one independent verifier to each candidate. Retain proven and plausible findings; do not discard a candidate solely because its trigger is uncommon.

Then launch one gap-sweep task with the diff, relevant context, and existing findings. It must look only for unlisted defects and return at most 8 candidates. The sweep task must self-check the evidence for new candidates. Without a second verifier, these additions must not be labeled independently verified. Merge, deduplicate, sort, and apply the output limit.

## careful-pass

Inspect the target diff as a senior reviewer responsible for the change would. Read each segment and consult surrounding files, call relationships, and relevant history as needed. Focus on mechanisms that produce incorrect behavior.

This run does not prescribe a fixed finder count or verification vote. Do not create tasks merely to demonstrate multi-agent activity. Prioritize incorrect conditions, boundaries, null values, asynchronous defects, error propagation, lost guards, interface incompatibilities, and races.

Explain a concrete failure scenario for every finding. Submit through the active output contract without calling tools that were not provided. Keep conclusions and coverage consistent with what was actually verified.

## sequential-fallback

The required subagents cannot be created in this context. Work through all selected angles sequentially here while preserving the same review scope. Self-check each candidate against the code and merge duplicates. Perform the gap sweep yourself when applicable.

Do not call an unavailable or denied Agent capability. Do not describe self-checking in the same context as independent verification. Explicitly disclose the single-agent fallback and its reason in the result summary, and preserve coverage gaps.
