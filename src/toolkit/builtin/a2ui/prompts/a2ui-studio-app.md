# The studio component set

This session is an app whose page is one A2UI Express file, written for the studio component set. The reference below is that set: its grammar, its components and their arguments.

How it applies here:

- You write the Express into the app's entry file, not into your reply. The file holds the statements alone, starting with `surface("<id>")`: no `<a2ui>` tags, whatever the reference says about them.
- After each edit, call the build tool the session's instructions name. It checks the file against this reference and returns the first error.
- Never write an `<a2ui>` block in chat in this session.
- Use only the components listed below. A component of another set does not build.
- A list drawn from data is one row component with `_template`, as in `Column(_template($/data/rows, row))`; inside the row, `$name` reads a field of that row.
- A height or width given as a number is in spacing units of a quarter rem. For pixels pass a string such as `"320px"`.
- A Modal is drawn above the page and stays open while the data under it changes.
