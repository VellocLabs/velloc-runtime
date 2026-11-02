The review report has been produced. The client has determined that runtime verification may proceed. This is not another static code review.

Target workspace and changes:
{{scope_manifest}}

Repairs applied during this run and existing verification:
{{repair_and_validation_summary}}

Use the project's existing test and startup instructions to cover affected main paths and important boundaries. For UI changes, when tools and permissions allow, start the appropriate development service and exercise the feature in a browser. Do not automatically install dependencies, change system configuration, call production write endpoints, or push code.

Record the commands and interactions actually performed, their results, failure reasons, and uncovered areas. If execution is unavailable, explicitly report that verification was not performed; do not present static inspection as a successful runtime check. Associate results with the actual reviewed code version so that pre-edit success is not used as evidence for post-edit code.
