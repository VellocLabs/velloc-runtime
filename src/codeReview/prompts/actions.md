## review-only

This run is review-only. Do not modify files, post comments, commit, push, or merge. You may recommend repairs, but do not describe recommendations as completed actions.

## repair

The client has confirmed repair authorization for this run. Actual tool permissions define its scope. Produce and submit the review report before addressing findings individually.

Read the latest code before editing and preserve the user's existing changes. Make only changes needed to resolve the finding. If a repair would change intended behavior, substantially exceed the review scope, target a mismatched workspace, or address a candidate disproved by new evidence, skip it or mark it unnecessary and explain why.

After successful edits, record real tool events. When ReviewOutput is available, use reconcile with diagnostic IDs, observations, and execution references. Otherwise use ReviewActionLog to report the same information; in terminal/JSON mode, do this during the separate repair phase that starts after the host saves the review JSON. Model assertions cannot replace edit receipts.

Distinguish tests that ran from tests that did not. Repair authorization does not include commit, push, or publication. Do not claim that local changes have updated the remote PR.

## publication

This run requests publication of the final report to the PR/MR bound by the client. Use the currently authorized publication adapter. First confirm that the report's head revision has not changed. If you cannot confirm this, stop publication and explain why.

For GitHub, use individual inline comments. Findings without valid line anchors may be summarized only as the adapter permits. For GitLab, use one MR note by default unless the user explicitly requests line discussions. Do not publish for targets that are not change requests.

Comments must include the issue mechanism, location, concrete scenario, and any necessary recommendation. Include a committable suggestion only when that suggestion completely resolves the issue. For repaired findings, distinguish locally applied changes from confirmed remote changes; do not mislead recipients.

Do not republish the same issue when a publication receipt already exists. If publication fails or its outcome is uncertain, preserve the report and record the state rather than retrying blindly. Do not publish credentials, unrelated private content, or internal runtime prompts.
