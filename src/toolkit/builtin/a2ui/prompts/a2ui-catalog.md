## A2UI tools
- **a2ui_create_surface** — create/replace a surface (components + dataModel).
- **a2ui_update_components** — upsert/replace components in place.
- **a2ui_update_data_model** — patch data values (re-renders bound widgets).
- **a2ui_delete_surface** — remove a surface when it's done.
Reuse the SAME surfaceId across calls to evolve one surface; use a new id for a
separate surface.

## Canonical component shape (A2UI v1.0 — properties are FLAT)
`components` is a flat adjacency list. Exactly one component has id "root".
- Containers: `Card` (single `child`), `Column`/`Row`/`List` (`children`: a
  string[] of ids, OR a {"componentId":"<tmplId>","path":"/array"} template
  rendered once per array element).
- Leaves & inputs (type-specific props are flat on the object):
  - `Text` { text, variant? }  (variant: caption | body). `text` takes simple
    Markdown: write a heading as "## Title" and emphasis as "**bold**".
  - `Button` { child: "<id of a Text>", action: { event: { name, context?, userMessage? } }, variant? }
    — `userMessage` is a short line describing the action in the user's words.
    — the Button has NO `label`; its visible label is a CHILD `Text` (or `Icon`)
    referenced by id (variant: default | primary | borderless).
  - `TextField` { value: {"path":"/p"}, label, placeholder?, variant?, checks? }
    (variant: shortText | longText | number | obscured)
  - `CheckBox` { value: {"path":"/p"}, label } — `value` binds to a BOOLEAN.
  - `ChoicePicker` { value: {"path":"/p"}, options: [{label,value}], label?, variant?, displayStyle?, filterable? }
    — `value` binds to a STRING ARRAY of selected values
    (variant: mutuallyExclusive | multipleSelection; displayStyle: checkbox | chips).
  - `Slider` { value: {"path":"/p"}, max, min?, steps?, label? } — `max` is required;
    `steps` is the number of stops between min and max (there is no `step`).
  - `DateTimeInput` { value: {"path":"/p"}, enableDate?, enableTime?, min?, max?, label? }
    — `value` is an ISO-8601 string; initialise the bound pointer to "".
  - `Tabs` { tabs: [ { title, child: "<id>" } ] } — each tab body is a child by id.
  - `Image` { url, description?, fit?, variant? } — `description` is the alt text.
  - `Divider` { axis? }, `Modal` { trigger: "<id>", content: "<id>" },
    `List` { children, direction?: vertical | horizontal }
  - `Icon` { name } — name MUST be a camelCase value from the catalog's fixed
    icon set (e.g. settings, search, send, check, close, add, edit, delete,
    person, mail, phone, home, info, warning, star, favorite, calendarToday,
    shoppingCart, play, pause, refresh, lock, visibility) OR {"path":"<svg>"}.
    Kebab-case like "check-circle" is INVALID (renders as text).
- Charts and data (draw numbers as charts, not as prose):
  - `PieChart` { data: [{label, value, color?}] | {"path":"/p"}, donut?, title?, height? }
  - `LineChart` { data: rows | {"path":"/p"}, xKey, series: [{key, label?, color?}], curved?, title?, height? }
  - `BarChart` { data: rows | {"path":"/p"}, xKey, series: [{key, label?, color?}], stacked?, title?, height? }
    — `rows` is an array of objects; `xKey` names the category field and each
    series `key` a numeric field, e.g. data:[{month:"Jan",sales:120}], xKey:"month",
    series:[{key:"sales",label:"Sales"}]. Leave `color` out to use the theme palette.
  - `Metric` { label, value, delta?, trend?: up | down | flat, caption? } — one key figure.
  - `DataTable` { columns: [{key, label}], rows: rows | {"path":"/p"} }
  - Group them in `Card`s inside a `Row`/`Column` for a dashboard.
- Dynamic values: a binding `{"path":"/json/pointer"}` or a function
  `{"call":"<fn>","args":{...}}`. Any component also takes `weight` (its flex
  share inside a Row or Column). Validation: `checks: [{ "condition":
  {"call":"required","args":{"value":{"path":"/p"}}}, "message":"..." }]`.
- Initial state goes in `dataModel` (JSON addressed by the pointers above).

## Example
a2ui_create_surface with:
- surfaceId: "contact"
- components: [
    {id:"root", component:"Card", child:"col"},
    {id:"col", component:"Column", children:["title","name","save"]},
    {id:"title", component:"Text", text:"What is your name?"},
    {id:"name", component:"TextField", value:{path:"/form/name"}, label:"Name"},
    {id:"save", component:"Button", child:"saveLabel", action:{event:{name:"save_name"}}},
    {id:"saveLabel", component:"Text", text:"Save"}
  ]
- dataModel: { form: { name: "" } }

When the user clicks "Save", you receive a new turn naming the action and the
current data — respond, or update the surface.

## Common mistakes to avoid
- Do NOT nest properties under a "props" object — properties are FLAT on each
  component (text, value, label, action, checks, name, …).
- For a List, do NOT inline the template object. Define the row as its own
  component and reference it: children:{"componentId":"<rowId>","path":"/arr"}.
  Inside that row, bind to each item with a RELATIVE pointer, e.g. {"path":"title"}.
- Two-way bindings are {"path":"/pointer"} objects, never bare strings.
- A Button has NO "label": give it a child Text (child:"<id>") for its visible
  label. A Slider has NO "step". Don't add a property a component doesn't define
  — the catalog validates STRICTLY, so an unknown property drops the component.
