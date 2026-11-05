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

Merge duplicate root causes and sort the results. Merging is not a second judgement: do not drop a candidate because its trigger is uncertain. Then reread the diff and relevant functions solely for mechanisms missing from the current list. Focus on guards lost during extraction, asymmetric test cleanup, changed configuration defaults, and secondary language pitfalls. Add at most 8 evidence-supported candidates without re-deriving existing entries.

Record that the gap sweep ran in the same context; do not call it independent verification. Apply the final limit and report uncovered scope.

## team-eight-precise

Cover the 8 independent review angles with finders, at most 6 candidates per angle, and relaunch a finder that failed.

Retain proven and plausible findings. Remove dismissed findings supported by clear counterevidence. Report actionable issues, not style opinions. If a verifier does not finish, preserve the candidate's unverified status and mark the coverage gap rather than counting verification as passed.

## team-eight-recall

Organize finders around the 8 selected angles, with at most 6 candidates per angle. Respect actual agent budgets and permissions.

This run prioritizes avoiding missed defects, and its verifiers keep a supported mechanism plausible unless the code refutes it. Concurrency, cold caches, error paths, default configurations, and uncommon but reachable boundaries must not be dropped merely because they are unlikely, while merging or anywhere else. If the mechanism is supported but a triggering condition needs runtime confirmation, it stays plausible with the missing evidence named.

Do not keep speculation without a concrete mechanism. Sort the final results by impact and disclose unfinished verification and coverage limits.

## team-ten

Run independent finder checks across the 10 selected angles, with at most 8 candidates per angle. Group angles into tasks as the budget requires, but cover every angle, and relaunch a finder that failed. One angle's conclusion must not prevent another angle from reporting a different mechanism: two angles that flag the same line for different mechanisms both stay.

Each candidate gets one verdict, and that verdict decides: proven and plausible stay in the report, dismissed leaves it. Do not discard a candidate because its trigger is uncertain or uncommon.

After the verdicts, the verification call runs one gap-sweep task with the diff and the verified list, and returns it under `sweep`. It must look only for unlisted defects and return at most 8 candidates. The sweep task must self-check the evidence for new candidates. Without a second verifier, these additions must not be labeled independently verified. Merge, deduplicate, sort, and apply the output limit.

## team-steps

Launch every finder in one turn: issue all the finder Agent calls together, and the host queues those past its concurrency. Each finder receives the diff itself, so do not read patches before launching them, and do not review the diff yourself while they run.

When the finders have returned, and before any verifier runs, merge candidates that share a location and a mechanism with ReviewLedger operation=merge-duplicates, naming each by the candidateId its finder result carries, even when two angles filed them under different kinds; keep as representative the one whose kind matters most (correctness and security before cleanup), then the one whose failure scenario is most concrete. Read context only when it is needed to decide whether two candidates are the same defect. Then call Agent once with role=verifier and no candidateId; a duplicate merged before that call gets no verifier of its own. The host waits for any finder still running, gives each remaining candidate one independent verifier, never the candidate's own finder, and returns every verdict under `verification`; finders launched after that call are refused. The verdicts decide: do not re-check them yourself or read more of the diff to second-guess them. Calling Agent the same way again retries only the verifiers that failed or came back unchecked, and a sweep that failed; otherwise leave such a candidate unverified and say so. After the verdicts, record coverage and report. The host decides whether this run is complete from what the workers covered and verified: record what could not be checked as limitations, and do not mark the run incomplete for checks outside the diff, such as other repositories, translation quality or runtime behaviour.

## careful-pass

Inspect the target diff as a senior reviewer responsible for the change would. Read each segment and consult surrounding files, call relationships, and relevant history as needed. Focus on mechanisms that produce incorrect behavior.

This run does not prescribe a fixed finder count or verification vote. Do not create tasks merely to demonstrate multi-agent activity. Prioritize incorrect conditions, boundaries, null values, asynchronous defects, error propagation, lost guards, interface incompatibilities, and races.

Explain a concrete failure scenario for every finding. Submit through the active output contract without calling tools that were not provided. Keep conclusions and coverage consistent with what was actually verified.

## sequential-fallback

The required subagents cannot be created in this context. Work through all selected angles sequentially here while preserving the same review scope. Self-check each candidate against the code and merge duplicates. Perform the gap sweep yourself when applicable.

Do not call an unavailable or denied Agent capability. Do not describe self-checking in the same context as independent verification. Explicitly disclose the single-agent fallback and its reason in the result summary, and preserve coverage gaps.
