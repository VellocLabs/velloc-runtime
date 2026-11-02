Angle: Line-by-line review and enclosing functions
Read each diff segment and, when the recipe permits, its enclosing function. Check condition direction, boundaries, null values, asynchronous waits, error propagation, incorrect variables, and state updates. Connect every finding to specific inputs or execution paths rather than listing code smells.

Angle: Removed behavior
For each removed or replaced block, identify the invariant or error path it protected. Locate the replacement protection in the new implementation. Report a problem only when the constraint still matters and no effective replacement exists.

Angle: Call chains
Identify callers of changed interfaces and the components those interfaces call. Look for incompatibilities in argument contracts, return values, exceptions, execution ordering, or resource lifetimes. Name the specific broken chain.

Angle: Reuse
Search nearby code and shared modules for equivalent capabilities. Report duplication only when you find a concrete existing implementation with suitable behavior. Identify the implementation to reuse and the semantics that must be preserved.

Angle: Simplification
Look for newly introduced derivable state, duplicate branches, near-identical logic, dead code, or unnecessary nesting. Describe a simpler alternative that preserves behavior, not merely your preferred coding style.

Angle: Efficiency
Check repeated computation or I/O, unnecessary sequential waits, startup or hot-path blocking, and long-lived objects that unintentionally retain large closure environments. Explain the extra work or retained resources and propose a more economical alternative.

Angle: Root-cause placement
Determine whether the change fixes the problem at the appropriate abstraction level or adds caller-specific exceptions that merely hide symptoms. Identify a verifiable remaining trigger and a better repair location. Do not demand unrelated architectural rewrites for elegance alone.

Angle: Project guidance
Use only actual rules whose scope includes the target file. Cite the rule, its source location, and the violating code location for every violation. If no applicable rule exists, return no findings for this angle. Do not invent project conventions.

Angle: Language and framework pitfalls
Check semantics relevant to the actual language: default-value evaluation timing, closure capture, truthiness conversion, numeric boundaries, time zones, null containers, locking and resource cleanup, and regular-expression anchors. Report only concrete behavior introduced or re-exposed by this diff.

Angle: Wrappers and proxies
When the change adds or modifies a cache, decorator, adapter, or proxy, check that calls reach the wrapped instance rather than re-entering the wrapper through a global registry. Verify that methods required by callers are forwarded correctly. Explain the path leading to recursion, lost semantics, or incorrect caching.
