# A2UI Express DSL Output Contract

You must output the user interface using A2UI Express.

IMPORTANT: You MUST always surround the entire A2UI Express block with the literal sentinel tags `<a2ui>` and `</a2ui>` (always include both the opening and closing tags; do NOT wrap the tags in backticks or replace the opening tag with a markdown code fence such as ```a2ui).

The host compiler will compile your A2UI Express output into the correct JSON envelopes automatically.

## Grammar Rules

1. Component constructors can be assigned to variables or nested inline inside parent component arguments:
   header = ComponentA(prop1="val1")
   root = ComponentB([header, ComponentC("Click", action=Event("submit"))])

   Keyword arguments (`param=value`) and positional arguments with `_` placeholders are supported.

   Variable names MUST start with a letter or underscore, and only contain letters, digits, and underscores.

2. The interface tree must have a single entry point assigned to the reserved variable 'root'.

3. Primitives:
   - Strings: Quoted with `"` or `"""`. Support for `\n`, `\t`, `\\`, and `\"` escapes.
     Raw Strings: Prefaced by `r` (e.g., `r"..."` or `r"""..."""`), with no escape processing.
   - Numbers: write as integers or decimals, e.g., 42
   - Booleans: write true or false
   - Null values: write null
   - Dates & Times: Values for date-time inputs (e.g. in DateTimeInput) must strictly use RFC 3339 format with a timezone offset (e.g. "2026-03-14T00:00:00Z").

4. Lists: represent as arrays, e.g., [child1, child2].

5. Maps: represent as key-value blocks, e.g., {title: "Overview", child: contentCol}. Map keys are always literal strings (dynamic variable resolution is not supported for keys).

6. Data bindings: prefix absolute paths in the data model with '$', e.g., $/user/firstName.
   Prefix relative list scopes with '$', e.g., $firstName.
   A lone '$' represents an empty relative path which resolves to the root of the current context (e.g. inside a template, representing the entire item itself).

7. Logic and validation: prefix client check rules with '?', e.g., ?required or ?regex("^[0-9]{5}$"). To specify a custom error message for validation failures, append it as an extra string argument, e.g. ?regex("^[0-9]{5}$", "Postal code must be 5 digits").

8. Action events: represent server-side actions using the Event helper:
   Event("save_deal", {rep: $/form/rep})

9. Nested functions: call client functions directly using catalog signatures, for example myFunction("value").

10. Data model population: Assign a value directly to an absolute data path (e.g. $/path/to/key = "value") to populate or initialize values inside the shared dataModel. The value can be a primitive, array, or map.

11. Dynamic list templates: If a component expects a template child list, represent it using the _template helper:
    _template($/path/to/list, itemTemplate)
    And define the template component variable on another line, utilizing relative path references prefixed with $:
    itemTemplate = Image($url)

12. To delete a user interface surface, output the standalone `deleteSurface(surfaceId)` command (no variable assignment):
    deleteSurface("dashboard-surface-1")

13. Static properties: Arguments annotated with '(static)' in the signatures below MUST be defined as literal values or arrays inline. You CANNOT use a dynamic data binding path (prefixed by $) for these arguments.

14. Required actions: Parameters named 'action' (or annotated in component signatures) are strictly required. You must pass a valid Event (e.g. Event("click")) or function call. If no specific action is described in the user request, you must provide a dummy click event like Event("click") instead of passing null or omitting the parameter.

15. Surface targeting: Output `surface(surfaceId)` to specify or target a user interface surface:
    surface("dashboard-surface-1")
    root = Card(...)

## Positional Component Signatures

Use these exact positional signatures to instantiate components. Do not output property keys:
• Accordion(items, multiple?)
  - Description: Collapsible items (FAQs, details, per-file notes); each has a title and either text or a child id.
• Agenda(title?, days)
  - Description: Calendar agenda: days with timed events (conference, week plan, schedule). Prefer over Timeline for clock times.
• Alert(title, message?, tone?)
  - Description: Inline alert with icon, title and message.
  - tone: Must be one of: 'info', 'success', 'warning', 'error'
• AreaChart(title?, subtitle?, height?, format?, unit?, data, stacked?, highlight?)
  - Description: Filled trend for volumes or cumulative totals (traffic, signups); series stack. data [{x,y,series?}].
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• AudioPlayer(url, description?, weight?)
  - Description: An audio player for an audio file URL, with the description above it.
  - url: The URL of the audio file
  - description: A title or summary of the audio, shown above the player
  - weight: flex-grow in a Row or Column
• Avatar(name, image?, subtitle?, size?, status?)
  - Description: Person avatar (initials if no image) with name and subtitle: authors, owners, reviewers.
  - size: Must be one of: 'sm', 'md', 'lg'
  - status: Must be one of: 'online', 'away', 'offline'
• AvatarGroup(people, max?, label?)
  - Description: Overlapping avatar stack with +N overflow: attendees, team members, reviewers.
• Badge(label, variant?, color?, size?, pill?, fontWeight?, maxWidth?, padding?)
  - Description: A small status pill. Use the colors success, danger and warning only to show a status, not for decoration.
  - label: Badge text
  - variant: Default "soft" Must be one of: 'soft', 'solid', 'outline'
  - color: Default "secondary" Must be one of: 'secondary', 'success', 'danger', 'warning', 'info', 'discovery'
  - size: Default "md" Must be one of: 'sm', 'md', 'lg'
  - pill: Default true
  - fontWeight: Default "medium" Must be one of: 'normal', 'medium', 'semibold', 'bold'
• BarChart(title?, subtitle?, height?, format?, unit?, data, stacked?, horizontal?, highlight?)
  - Description: Compare categories. data [{x,y,series?}]; series grouped side by side, or stacked:true. horizontal for long labels.
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• Blockquote(text)
  - Description: A block quotation with a line on the left. `text` can have inline markdown.
  - text: The quoted text, with inline markdown
• Bold(text, fontWeight?)
  - Description: Bold inline text.
  - fontWeight: Must be one of: 'normal', 'medium', 'semibold', 'bold'
• Box(children?, direction?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?)
  - Description: A flex container. It stacks its children in a column (direction "row" puts them in a row). Use it to group children with gap, padding, border, radius or background.
  - direction: Default "col" Must be one of: 'col', 'row'
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
• Button(label?, onClick? (static), checks?, text?, variant?, block?, disabled?, loading?, submit?, icon?, uniform?, href?, copy?, child? (component ID), children?, color?, size?, weight?, pill?)
  - Description: Sends its onClick event; with href it opens the URL, with copy it copies the text. Variant "primary" for the one main Button in a Row. submit true submits the Form around it. Its children render instead of the label. With checks it is disabled while a check fails.
  - label: The button text
  - onClick: Sent when the user clicks the button.
  - checks: Validation rules. The control shows the first failed one
  - text: Same as label. Used when label is not set
  - variant: Default "default": outlined. "primary" is filled, for the one main action. "borderless" has no box, like a link Must be one of: 'default', 'primary', 'soft', 'borderless'
  - block: Full width
  - submit: Submits the Form around it. The Form sends its onSubmit event
  - icon: Lucide icon name
  - uniform: A square button, for an icon
  - href: Opens this URL in a new tab on click, instead of onClick
  - copy: Copies this text to the clipboard on click and shows a check mark, instead of onClick
  - color: Default "primary" Must be one of: 'primary', 'secondary', 'danger'
  - size: Default "lg" Must be one of: 'sm', 'md', 'lg'
  - weight: flex-grow in a Row or Column
  - pill: Default true
• ButtonGroup(label?, value?, options, onChange? (static))
  - Description: Segmented single-choice control; value bound to a path.
  - onChange: Sent when the person changes the value, after it is written to the bound path. The args carry the new value.
• Callout(title?, text, icon?, actionLabel?, onAction? (static))
  - Description: Highlighted tip or note with optional emoji/icon and a call to action.
  - onAction: Fires when the call-to-action button is clicked.
• CandlestickChart(title?, subtitle?, height?, format?, unit?, data)
  - Description: OHLC price candles. data [{date,open,high,low,close}].
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• Caption(text, color?, size?, fontWeight?, textAlign?, truncate?, maxLines?)
  - Description: Small secondary text: a hint under a control, or a label in a Row. `text` can have inline markdown.
  - text: Caption text
  - color: One of default|prose|primary|emphasis|secondary|tertiary|success|info|warning|caution|danger|discovery or a CSS color
  - size: Default "lg" Must be one of: 'sm', 'md', 'lg'
  - fontWeight: Default "normal" Must be one of: 'normal', 'medium', 'semibold', 'bold'
  - textAlign: Must be one of: 'start', 'center', 'end'
• Card(children?, child? (component ID), variant?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?, shadowStyle?, size?)
  - Description: A bordered panel, only for an interactive panel (controls, a form, a configurator); tables, charts and text need none. Give it a Title and a Caption. Separate groups with a Divider or the gap, never a nested Card or bordered Box. Variant "section": no box; "outline": always a box. In markdown mode, without controls it renders as "section" unless variant or border is set.
  - variant: Must be one of: 'default', 'outline', 'section', 'soft', 'elevated', 'transparent'
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
  - shadowStyle: Overrides the shadow of the variant Must be one of: 'none', 'sm', 'md'
  - size: The padding preset: 8, 16 or 24px. Default "md" Must be one of: 'sm', 'md', 'lg'
• Carousel(children?, activeIndex?, label?, visibleItems?, showArrows?, previousLabel?, nextLabel?, snap?, snapAlign?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?)
  - Description: A horizontally scrolling row that snaps to its CarouselItem or CarouselMediaItem children, with arrows. Bind activeIndex to read or set the slide in view.
  - activeIndex: The index of the slide in view. Bind it with { "@path": "/x" } to read or set it
  - label: A short name of the carousel for screen readers
  - showArrows: Default true
  - previousLabel: Default "Previous"
  - nextLabel: Default "Next"
  - snap: Must be one of: 'none', 'proximity', 'mandatory'
  - snapAlign: Must be one of: 'start', 'center', 'end'
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
• CarouselItem(children?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?)
  - Description: A slide of a Carousel.
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
• CarouselMediaItem(url, children?, onClick? (static), description?, href?, lightbox?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?, size?)
  - Description: A Carousel slide: an image with its children (a Caption, a Text) under it. size "sm" 160px, "md" 240px (default), "lg" 320px wide. A click opens all slides full-screen, unless href or onClick is set.
  - url: Image URL
  - onClick: Sent when the user clicks the image. It replaces the full-screen view.
  - description: What the image shows, for screen readers
  - href: Opens this URL in a new tab
  - lightbox: Default true: a click opens all slides full-screen
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - aspectRatio: Default "4 / 3"
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
  - size: The width: "sm" 160px, "md" 240px, "lg" 320px. Default "md" Must be one of: 'sm', 'md', 'lg'
• Chart(data?, xKey?, series?, chartType?, stacked?, layout?, yAxis?, showDots?, barRadius?, innerRadius?, outerRadius?, startAngle?, endAngle?, cornerRadius?, paddingAngle?, showLabelLines?, showLegend?, showGrid?, showTooltip?, showValueLabels?, format?, currency?, title?, height?)
  - Description: A bar, line, area, scatter, pie or donut chart. "data" is a list of objects. "xKey" is the field of the category. "series" are the value fields.
  - xKey: The field of the category axis
  - series: Default: every number field except xKey
  - chartType: Default "bar" Must be one of: 'bar', 'line', 'area', 'scatter', 'pie', 'donut'
  - layout: "horizontal" draws the bars from left to right. Default "vertical" Must be one of: 'vertical', 'horizontal'
  - yAxis: Example: {label: "Revenue (USD)", min: 0, max: 100}. In a horizontal chart it is the horizontal axis, and width sets the category axis width
  - showDots: Point markers on a line or area
  - barRadius: The corner radius of a bar, in pixels
  - innerRadius: Pie and donut
  - outerRadius: Pie and donut
  - startAngle: Pie and donut. Default 90
  - endAngle: Pie and donut. Default -270
  - cornerRadius: The corners of a slice
  - paddingAngle: The gap between slices
  - showLabelLines: Leader lines of the slice labels. Default true
  - showLegend: Default true
  - showGrid: Default true
  - showTooltip: Default true
  - format: With "percent", data values and axis min/max are fractions: 0.4 shows as 40%; for 0% to 10%, use min: 0 and max: 0.1. Must be one of: 'number', 'currency', 'percent'
  - currency: ISO code. Default "USD"
  - height: Pixels. Default 240
• CheckBox(label?, value?, checks?, name?, disabled?, required?, shape?, weight?, lineThrough?)
  - Description: A checkbox with a label. Bind value with { "@path": "/x" } to read its state, true or false.
  - label: The label text. Always set it
  - value: True when checked. Bind it with { "@path": "/x" } to read the state of the box
  - checks: Validation rules. The control shows the first failed one
  - shape: Default "round" Must be one of: 'round', 'square'
  - weight: flex-grow in a Row or Column
  - lineThrough: Default false. Strikes the label when the box is checked
• ChipSelect(label?, value?, options, onChange? (static))
  - Description: Multi-select chips bound to a string-list path: extras, interests, dietary needs.
  - onChange: Sent when the person changes the value, after it is written to the bound path. The args carry the new value.
• ChoicePicker(label?, options?, value?, checks?, variant?, displayStyle?, filterable?, disabled?, required?, weight?)
  - Description: Options as checkboxes or chips: pick one, or several with variant "multipleSelection". Its value is the list of chosen values. Give it a label.
  - label: The visible label of the field. Always set it
  - value: The chosen option values. Bind it with { "@path": "/x" } to a string list
  - checks: Validation rules. The control shows the first failed one
  - variant: Default "mutuallyExclusive": the user picks one option Must be one of: 'multipleSelection', 'mutuallyExclusive'
  - displayStyle: Default "checkbox". "chips" shows the options as pills Must be one of: 'checkbox', 'chips'
  - filterable: Default false. Shows a field that filters the options
  - weight: flex-grow in a Row or Column
• Citation(index?, title?, url?, label?, snippet?, source?)
  - Description: An inline source marker ([1]) showing title, snippet and link on hover or click. Put it right after the sentence it supports, as a child of a Text or in a Row.
  - index: The marker number. Default 1
  - title: The source title
  - url: The source URL (http, https)
  - label: Marker text instead of the number, for example a domain
  - snippet: The quoted passage, one or two lines
  - source: The publisher or domain. Default: the host of url
• Code(text, language?)
  - Description: A block of code in a monospace font.
  - text: Source code
• CodeBlock(code, language?, filename?)
  - Description: Syntax-colored code with language label and copy button. Use for any code, config, command or diff snippet.
• Column(children?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?)
  - Description: A vertical flex container. Its default gap already separates sections, so do not add padding, background or a Spacer for space.
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
• Combobox(label?, value?, options, placeholder?)
  - Description: Searchable dropdown for long option lists (countries, cities, timezones).
• ComparisonTable(title?, options, rows, highlight?)
  - Description: Feature matrix comparing options side by side. options are the option names as strings; rows [{feature, values}] with one value per option, in the same order, each true/false/text; highlight is the recommended option's index in options (0 is the first).
• DataTable(title?, columns, rows, searchable?, pageSize?, selectKey?, value?, onRowClick? (static), onChange? (static))
  - Description: Sortable, filterable table (TanStack Table). columns [{key,label,format?}], rows are objects keyed by column key.
  - selectKey: Turns on row selection: the row field that identifies a row. A checkbox column comes first; the header box selects or clears the rows the search and filters show.
  - value: With selectKey: the selected rows' selectKey values, written back as the person checks rows.
  - onRowClick: Sent when the person clicks a row. The args carry the whole row object as "row", fields not shown in a column included. With selectKey and no onRowClick, a row click checks or clears the row.
  - onChange: Sent when the person changes the value, after it is written to the bound path. The args carry the new value.
• DatePicker(label?, value?, placeholder?)
  - Description: Date picker with calendar popover; value ISO date bound to a path.
• DateTimeInput(label?, value?, checks?, enableDate?, enableTime?, timeStep?, min?, max?, placeholder?, disabled?, required?, clearable?, block?, weight?)
  - Description: A date picker, a time picker with enableTime, or both. timeStep (minutes) offers fixed times, e.g. 30 for a booking. The value is ISO 8601. Give it a label.
  - label: The visible label of the field. Always set it
  - value: ISO 8601: "YYYY-MM-DD", "HH:MM" or "YYYY-MM-DDTHH:MM". Bind it with { "@path": "/x" }
  - checks: Validation rules. The control shows the first failed one
  - enableDate: The user picks a date. Default true unless only enableTime is set
  - enableTime: The user picks a time
  - timeStep: Minutes between the times the user can pick, e.g. 15 or 30. Shows the time as a list
  - min: The earliest value, ISO 8601
  - max: The latest value, ISO 8601
  - block: Full width
  - weight: flex-grow in a Row or Column
• Divider(axis?, spacing?, weight?, color?, size?, flush?)
  - Description: A line between two groups: horizontal, or vertical with axis "vertical" in a Row.
  - axis: Default "horizontal" Must be one of: 'horizontal', 'vertical'
  - weight: flex-grow in a Row or Column
  - color: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
• EmptyState(title, description?, icon?, actionLabel?, onAction? (static))
  - Description: Empty or zero-results state with icon, title, hint and optional action: no matches, nothing scheduled, inbox zero.
  - onAction: Fires when the action button is clicked.
• EntityCard(title, actions?, onAction? (static), onClick? (static), subtitle?, description?, image?, imageAspectRatio?, meta?, badge?, rating?, ratingCount?, href?, layout?, width?)
  - Description: A card for one product, place, person or listing: image, title, subtitle, description, a price or meta line, badge, rating and up to three buttons. href opens a page; onClick is sent when bound. Use a Grid of them for several things.
  - title: The name
  - actions: Up to three buttons. A button without href sends onAction with its label
  - onAction: Sent when the user clicks a button without href. The args carry the label of the button.
  - onClick: Sent when the user clicks the card and it has no href.
  - subtitle: A second line, for example the brand or category
  - description: Up to three lines
  - image: An image URL
  - imageAspectRatio: Default "4 / 3"
  - meta: A short fact line, for example "$29 / month" or "Open until 22:00"
  - rating: 0 to 5, shown as stars
  - ratingCount: The number of ratings
  - href: Opens this URL in a new tab when the user clicks the card
  - layout: Default "vertical". "horizontal" puts the image on the left Must be one of: 'vertical', 'horizontal'
• EventCard(title, date, time?, venue?, host?, description?, attendees?, image?, tags?, actionLabel?, onAction? (static))
  - Description: Event: date block, title, time, venue, host, attendees count, tags, RSVP action. Lead an event or conference with it.
  - onAction: Fires when the RSVP button is clicked.
• Favicon(url, alt?, frame?, size?, inline?)
  - Description: The favicon of the site at a URL.
  - frame: Default false
  - size: Pixels. Default 16
  - inline: Default false
• FlashcardFlip(front?, back?, hint?)
  - Description: A card that shows the front text. A click or the Enter key flips it to the back text, and again to the front.
  - front: The text on the front
  - back: The text on the back
  - hint: A small line under the front, for example "Click to flip"
• Flow(children?, columns?, rows?, layout?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?)
  - Description: A masonry-like grid that packs cells of different sizes. Put FlowItem children in it.
  - layout: Default "pack" Must be one of: 'pack', 'fixed'
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
• FlowItem(children?, span?, rowSpan?, aspectMode?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?)
  - Description: A cell of a Flow, with an optional span.
  - aspectMode: Must be one of: 'soft', 'fixed'
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - aspectRatio: Default "1 / 1"
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
• FollowUp(items?, onFollowUp? (static), title?)
  - Description: Suggested next prompts as pills; a click sends the pill's message as the user's next turn, no event needed. At the end of a surface, two to four short items.
  - onFollowUp: Sent when the user clicks a pill. The args carry the message of the pill.
  - title: A caption above the pills
• Form(children?, onSubmit? (static), label?, align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?)
  - Description: A layout container that is a form. It sends onSubmit when the user submits (a Button with submit true, or Enter in a field). Put its field values in the event context with { "@path": "/x" }.
  - onSubmit: Sent when the user submits the form.
  - label: A short name of the form for screen readers
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
• Gauge(title?, value, min?, max?, label?, format?)
  - Description: Half-ring gauge for a single value within min..max (score, utilization).
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• Grid(children?, columns?, minChildWidth?, rows?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?)
  - Description: A CSS grid container. On a narrow screen, its columns collapse towards one column.
  - columns: Column count or CSS template. Default 2
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
• GridItem(children?, span?, rowSpan?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?)
  - Description: A cell of a Grid, with an optional span. A span that covers all rendered columns fills the row.
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
• Heading(text, eyebrow?, subtitle?, level?)
  - Description: Surface title with optional eyebrow and subtitle. Start most surfaces with one.
  - level: Must be one of: '1', '2', '3'
• Heatmap(title?, subtitle?, height?, format?, unit?, data)
  - Description: Matrix of values, e.g. day x hour. data [{x,y,value}] with x,y categories.
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• HtmlView(html, title?, height?, width?)
  - Description: Raw HTML in a fully sandboxed iframe: no scripts, no same-origin access. Set title to name the content.
  - height: Pixels when a number. Default 360
  - width: Default "100%"
• Icon(name, label?, size?, color?, inline?, strokeWeight?, weight?)
  - Description: A Lucide icon by kebab-case name (for example "arrow-right"), or an A2UI icon name (for example "arrowBack"). Set label when no text next to the icon says what it means.
  - name: A Lucide icon name in kebab-case ("arrow-right"), an A2UI icon name ("arrowBack"), or { "svgPath" } on a 24px grid
  - label: What the icon means, for screen readers. Leave it unset when text next to the icon says the same
  - size: Default "md" Must be one of: 'sm', 'md', 'lg', 'xl'
  - inline: Default false
  - strokeWeight: The stroke width Must be one of: 'normal', 'medium', 'semibold', 'bold'
  - weight: flex-grow in a Row or Column
• Image(url, description?, onOverlayClick? (static), variant?, fit?, frame?, position?, hideOnFailure?, fallback?, hoverZoom?, lightbox?, actionOverlay?, weight?, aspectRatio?, radius?, width?, height?, maxWidth?, maxHeight?, minWidth?, minHeight?, background?)
  - Description: An image from a URL. A click opens it full-screen. Set description to say what the image shows, unless it is only decoration.
  - url: Image URL
  - description: What the image shows, for screen readers. Leave it unset only for a decorative image
  - onOverlayClick: Sent when the user clicks the actionOverlay button and it has no href.
  - variant: The size: "icon" 24px, "avatar" 40px round, "smallFeature" 160px wide, "largeFeature" and "header" full width. Default "mediumFeature": the natural size Must be one of: 'icon', 'avatar', 'smallFeature', 'mediumFeature', 'largeFeature', 'header'
  - fit: CSS object-fit. Default "cover" Must be one of: 'cover', 'contain', 'fill', 'none', 'scaleDown'
  - position: CSS object-position, for example "top" or "50% 20%"
  - hideOnFailure: Default false
  - fallback: Text shown in place of the image when it does not load
  - hoverZoom: A slight zoom on hover
  - lightbox: Default true: a click opens the image full-screen
  - actionOverlay: A button over the bottom-right corner of the image. Without href, it sends onOverlayClick
  - weight: flex-grow in a Row or Column
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
• ImageGallery(images, columns?)
  - Description: Grid of images with captions.
• ImageGrid(images?, columns?, layout?, aspectRatio?, gap?)
  - Description: A gallery of images in a grid. A click opens the image full-screen, with arrows to the other images. layout "bento" makes the first image twice as large.
  - columns: Default 3
  - layout: Default "grid". "bento" makes the first image twice as large Must be one of: 'grid', 'bento'
  - aspectRatio: Default "1 / 1"
  - gap: Default 2
• Italic(text)
  - Description: Italic inline text.
• Kbd(keys, label?)
  - Description: Keyboard shortcut chips, e.g. keys ['Cmd','K'] with a label. Use for shortcuts and how-to steps.
• KeyValueList(title?, items, columns?)
  - Description: Label/value rows, e.g. specs or order details.
• Label(text, htmlFor?, color?, size?, fontWeight?, textAlign?, truncate?, width?)
  - Description: The label of a form field.
  - text: Label text
  - color: One of default|prose|primary|emphasis|secondary|tertiary|success|info|warning|caution|danger|discovery or a CSS color
  - size: Default "sm" Must be one of: '3xs', '2xs', 'xs', 'sm', 'md', 'lg'
  - fontWeight: Default "medium" Must be one of: 'normal', 'medium', 'semibold', 'bold'
  - textAlign: Must be one of: 'start', 'center', 'end'
• LineChart(title?, subtitle?, height?, format?, unit?, data, curve?, highlight?)
  - Description: Trend over ordered x. data [{x,y,series?}]; one line per series.
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• Link(text, href, title?)
  - Description: A link. Only http, https and mailto URLs work. It opens in a new tab.
  - text: Link text
  - href: URL
• LinkCard(href, title, onClick? (static), description?, image?, domain?, favicon?)
  - Description: A preview of a URL: favicon and domain, title, description, thumbnail. A click opens it in a new tab, or sends onClick when bound. For sources, articles and products with a page.
  - href: The URL (http, https)
  - title: The page title
  - onClick: Sent when the user clicks the card, instead of the link.
  - description: One or two lines
  - image: A thumbnail URL
  - domain: Shown next to the favicon. Default: the host of href
  - favicon: Default true
• List(items?, children?, action? (static), direction?, marker?, connector?, start?, maxMarkerSize?, align?, weight?, gap?)
  - Description: A list in a Card or next to another component; a plain list of text is markdown. Give "items": an item with a value and no action is a key-value row (Price: $1,599). Or give "children": ListItem ids or a template. With "action" the user picks an item; the event context gets its index, label and value.
  - action: Runs when the user picks an item. The args are the index, label and value of the item.
  - direction: Default "vertical". "horizontal" scrolls sideways Must be one of: 'vertical', 'horizontal'
  - marker: Default "bullet" Must be one of: 'bullet', 'number', 'rich', 'none'
  - connector: Default "none" Must be one of: 'none', 'solid'
  - start: The first number of marker "number"
  - maxMarkerSize: The width of the marker column in pixels
  - align: Must be one of: 'start', 'center', 'end', 'stretch'
  - weight: flex-grow in a Row or Column
• ListItem(label?, value?, action? (static), children?, description?, icon?, marker?, markerSize?, disabled?)
  - Description: An item of a List, with a label, a value on the right, a description, an icon and children. With an "action", the user can pick it.
  - value: Without an action: shown on the right of the label, for a key and value fact
  - action: Runs when the user picks the item.
  - icon: Lucide icon name
  - marker: Shows this text as the marker
  - markerSize: The width of the marker column in pixels
  - disabled: Greys the item out and ignores its action
• Map(markers?, selected?, route?, zoom?, center?, height?)
  - Description: A map with markers; with "route" a line connects them in order. Bind "selected" to get the label of the marker the user picks. Without maps it shows a list of the places.
  - selected: The label of the selected marker. Bind it with { "@path": "/x" } to read the choice of the user
  - route: Draws a line through the markers in order
  - zoom: With two or more markers, only the highest zoom of the fit
  - height: Pixels. Default 240
• Markdown(text, streaming?)
  - Description: A block of GitHub-flavored markdown. Use it only next to other components, for example in a table cell or next to a chart. Markdown alone goes outside the fence.
  - text: Markdown source
  - streaming: Default false
• Math(value, block?)
  - Description: A TeX math formula, typeset with KaTeX. Set block to true for a centered formula on its own line.
  - value: TeX source
  - block: Default false
• Modal(trigger? (component ID), content? (component ID), title?, open?, closeOnBackdrop?, maxWidth?, weight?)
  - Description: A dialog over the page. A click on the trigger (a Button or a Text) opens the content in the dialog. Escape, the close button or a click on the backdrop closes it; closeOnBackdrop false keeps it open on a backdrop click.
  - title: The heading of the dialog
  - open: Default false. Bind it with { "@path": "/x" } to read it
  - closeOnBackdrop: Default true. False keeps the dialog open on a click on the backdrop; Escape and the close button still close it
  - maxWidth: Default 480
  - weight: flex-grow in a Row or Column
• PieChart(title?, subtitle?, height?, format?, unit?, data, donut?, centerLabel?)
  - Description: Part-to-whole. data [{label,value}]; donut:true for a ring with center total.
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• Popover(children?, open?, showOnHover?, hoverOpenDelay?)
  - Description: A small overlay: exactly two children, one PopoverTrigger then one PopoverContent. A click on the trigger toggles it; Escape or a click outside closes it.
  - open: Default false
  - hoverOpenDelay: Milliseconds before a hover opens it. Default 0
• PopoverContent(children?, side?, sideOffset?, align?, width?)
  - Description: The body of a Popover. It shows only when the Popover is open.
  - side: Default "bottom" Must be one of: 'top', 'bottom', 'left', 'right'
  - sideOffset: Pixels between the trigger and the content. Default 6
  - align: Default "center" Must be one of: 'start', 'center', 'end'
  - width: 4px steps when a number
• PopoverTrigger(children?, block?)
  - Description: The trigger of a Popover. Its children are the label of the trigger: a Text or an Icon. Do not put a Button in it, because the trigger is already a button.
  - block: Full width
• Pressable(children?, onClick? (static), href?, disabled?, tooltip?, ariaPressed?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?, hoverBackground?, insetBorder?)
  - Description: A layout container that the user can click or press with Enter or Space. It sends its onClick event, or opens href. A control inside it sends only its own event.
  - onClick: Sent when the user clicks or presses the container.
  - href: Opens this URL in a new tab on click, instead of onClick
  - tooltip: Shown on hover
  - ariaPressed: For a toggle
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
  - insetBorder: A 1px border inside the box
• ProfileCard(name, role?, company?, avatar?, location?, bio?, email?, phone?, website?, tags?, stats?)
  - Description: Person card: avatar, name, role, company, location, bio, contacts, tags, stats. Use for team members, speakers, candidates.
• Progress(label?, value, caption?, tone?)
  - Description: Labelled progress bar, value 0-100: goals, budgets used, completion, coverage.
  - tone: Must be one of: 'default', 'positive', 'negative', 'warning', 'info', 'accent'
• PulseIndicator(label?, pulseColor?, duration?, endScale?, startOpacity?, color?, size?)
  - Description: A small dot that pulses, for example next to the text "Live". Set label when no text next to the dot says what it means.
  - label: What the dot means, for screen readers. Leave it unset when text next to the dot says the same
  - duration: Milliseconds. Default 1500
  - endScale: Default 2.4
  - startOpacity: Default 0.6
  - color: Text color token. Default "success"
  - size: Pixels. Default 12
• Quote(text, author?, role?)
  - Description: Pull quote with attribution: testimonial, review, reviewer comment.
• RadarChart(title?, subtitle?, height?, format?, unit?, data, max?)
  - Description: Multi-axis profile (scores per criterion for 2-3 options or people). data [{axis,value,series?}], values on a shared scale.
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• RadialProgress(label?, value, display?, tone?)
  - Description: Ring with centered value, value 0-100: a single score or percent complete.
  - tone: Must be one of: 'default', 'positive', 'negative', 'warning', 'info', 'accent'
• Radio(label?, value?, disabled?, required?)
  - Description: One radio button. Use RadioGroup instead, because it keeps the chosen value.
• RadioGroup(label?, options?, value?, checks?, name?, direction?, variant?, disabled?, required?)
  - Description: A group of radio buttons. The user chooses one option. Bind value with { "@path": "/x" } to read it. Give it a label.
  - label: The visible label of the field. Always set it
  - value: Bind it with { "@path": "/x" } to read what the user entered
  - checks: Validation rules. The control shows the first failed one
  - direction: Default "row" Must be one of: 'row', 'col'
  - variant: Must be one of: 'list', 'pills', 'cards'
• Rating(value, count?, label?)
  - Description: Star rating (0-5) with optional review count: products, places, reviews.
• ReceiptCard(merchant, orderId?, date?, status?, items, currency?, tax?, shipping?, discount?, payment?)
  - Description: Order receipt: merchant, order id, date, line items with qty and price, subtotal/tax/total, status.
• RecipeCard(title, image?, time?, servings?, difficulty?, ingredients, steps, tags?)
  - Description: Recipe: title, time/servings/difficulty, ingredient checklist and numbered steps. Use for any recipe or cooking how-to.
• Row(children?, onVisible? (static), align?, justify?, wrap?, gap?, rowGap?, columnGap?, padding?, background?, border?, borderColor?, radius?, width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, flex?, weight?, aspectRatio?, scrollable?, clip?, shadow?, inline?, role?, flush?, minSize?, maxSize?, disableAutoSpacing?)
  - Description: A horizontal flex container. Label and value pair: justify "spaceBetween", a Caption left and a Text with fontWeight "medium" right. Buttons go in a Row at the bottom of a Card: one variant "primary", the others default or "borderless".
  - onVisible: Sent once, the first time the container scrolls into view. Use it to load more content lazily.
  - align: Must be one of: 'start', 'center', 'end', 'baseline', 'stretch'
  - justify: Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - wrap: Must be one of: 'nowrap', 'wrap', 'wrap-reverse'
  - gap: 4px steps when a number
  - padding: 4px steps when a number
  - background: Leave it unset. A surface token such as surface, surface-secondary, info, success, warning, danger, discovery, or one with -solid, or a CSS color. Only one summary panel in a Card uses "surface-secondary"
  - borderColor: Must be one of: 'default', 'subtle', 'strong', 'info', 'warning', 'caution', 'success', 'danger', 'discovery'
  - radius: Must be one of: '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'
  - weight: flex-grow in a Row or Column
  - role: ARIA role
  - flush: No padding
  - minSize: Minimum width and height
  - maxSize: Maximum width and height
  - disableAutoSpacing: No default gap between children
• SankeyChart(title?, subtitle?, height?, format?, unit?, links)
  - Description: Flows between stages, e.g. budget or funnel paths. links [{source,target,value}].
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• ScatterChart(title?, subtitle?, height?, format?, unit?, data, xLabel?, yLabel?)
  - Description: Relationship between two numbers (price vs rating, effort vs impact). data [{x,y,label?,size?,series?}].
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• Section(eyebrow?, title, description?, children)
  - Description: Titled group with eyebrow, title, description, and children.
• SegmentedControl(label?, options?, value?, checks?, block?, variant?, disabled?, size?, pill?)
  - Description: A row of segments. The user chooses one option. Use it for 2 to 5 short options. Bind value with { "@path": "/x" } to read it.
  - label: The visible label of the field. Always set it
  - value: Bind it with { "@path": "/x" } to read what the user entered
  - checks: Validation rules. The control shows the first failed one
  - block: Full width
  - variant: Default "ghost" Must be one of: 'solid', 'soft', 'outline', 'ghost'
  - size: Default "lg" Must be one of: 'sm', 'md', 'lg', 'xl'
  - pill: Default true
• Select(label?, options?, value?, checks?, placeholder?, name?, required?, disabled?, clearable?, clearLabel?, searchable?, icon?, block?, size?, pill?)
  - Description: A dropdown list of options. Bind value with { "@path": "/x" } to read the chosen option. Give it a label.
  - label: The visible label of the field. Always set it
  - value: Bind it with { "@path": "/x" } to read what the user entered
  - checks: Validation rules. The control shows the first failed one
  - clearLabel: The label of the empty option
  - icon: Lucide icon shown before the value
  - block: Full width
  - size: Default "xl" Must be one of: 'sm', 'md', 'lg', 'xl'
  - pill: Default true
• ShimmerText(text, color?, fontWeight?, textAlign?, italic?, truncate?, maxLines?, tabularNums?, width?, size?, lineThrough?)
  - Description: Text with a moving shimmer. It shows that something is loading or pending.
  - color: One of default|prose|primary|emphasis|secondary|tertiary|success|info|warning|caution|danger|discovery or a CSS color
  - fontWeight: Must be one of: 'normal', 'medium', 'semibold', 'bold'
  - textAlign: Must be one of: 'start', 'center', 'end'
  - size: Default "md" Must be one of: '3xs', '2xs', 'xs', 'sm', 'md', 'lg'
• Skeleton(lines?, variant?)
  - Description: Loading placeholder lines/blocks.
  - variant: Must be one of: 'text', 'card', 'chart'
• Slider(label?, value?, min?, max?, checks?, step?, steps?, unit?, marks?, sliderStyle?, disabled?, name?, weight?)
  - Description: A range slider for a number between min and max. Bind value with { "@path": "/x" } to read the number. Give it a label.
  - label: The visible label of the field. Always set it
  - value: Bind it with { "@path": "/x" } to read the number
  - min: Default 0
  - max: Default 100
  - checks: Validation rules. The control shows the first failed one
  - step: Default 1
  - steps: The number of equal divisions between min and max, instead of step
  - unit: Unit after the value, for example "%"
  - sliderStyle: Default "continuous" Must be one of: 'continuous', 'discrete'
  - weight: flex-grow in a Row or Column
• Spacer(minSize?)
  - Description: Flexible empty space. You almost never need it: use the default gap.
• Sparkline(label?, values, value?, delta?, tone?)
  - Description: Tiny trend with label and latest value; a compact KPI with history, fits in a Grid instead of Stat. values: numbers.
  - tone: Must be one of: 'positive', 'negative', 'default'
• Stat(label, value, delta?, trend?, caption?, tone?, icon?)
  - Description: One numeric KPI: label, short value (number or <10 chars like '$84k'), optional delta (e.g. '+4.2%'), caption. Not for sentences.
  - trend: Must be one of: 'up', 'down', 'flat'
  - tone: Must be one of: 'default', 'positive', 'negative', 'warning', 'info', 'accent'
• StatGroup(items)
  - Description: Compact strip of several KPIs in one card.
• StockTicker(symbol, name?, price, change?, changePct?, currency?, series?, stats?, sample?)
  - Description: Stock quote header: symbol, name, price, change and % change, sparkline, key stats. sample:true labels illustrative data.
• Strikethrough(text)
  - Description: Struck-through inline text.
• Svg(paths?, viewBox?, label?, fill?, stroke?, strokeWidth?, strokeLinecap?, strokeLinejoin?, preserveAspectRatio?, circles?, rects?, lines?, texts?, width?, height?, size?, color?)
  - Description: A vector drawing from primitive shapes (paths, circles, rects, lines, texts). Colors take text color tokens or CSS colors.
  - label: What the drawing shows, for screen readers. Leave it unset for a decorative drawing
  - fill: Default "currentColor"
  - strokeLinecap: Must be one of: 'butt', 'round', 'square'
  - strokeLinejoin: Must be one of: 'miter', 'round', 'bevel'
  - color: Default "prose"
• Switch(label, value?, description?)
  - Description: On/off toggle with label and description.
• Table(columns?, rows?, children?, caption?, columnSizing?, dividers?, stickyHeader?, emptyLabel?, cellComponents?)
  - Description: A data table, in a plain Column, not a Card. Give "columns" and "rows", or "children": TableSection or TableRow ids, or a template { "componentId", "path" } repeating a TableRow per item. A component in a cell or header (Badge, Button, Icon, Text): { "componentId": "<id>" }, with the id in "cellComponents".
  - columns: Default []
  - rows: A list of row lists. A cell is a string, a number, or { "componentId": "<id>" } to show a component. Default []
  - caption: A short name of the table for screen readers. It is not shown
  - columnSizing: Default "auto" Must be one of: 'auto', 'equal'
  - dividers: Default true
  - stickyHeader: Default false
  - emptyLabel: Default "No rows"
• TableCell(text?, children?, header?, vAlign?, colSpan?, rowSpan?, align?, width?, padding?)
  - Description: A cell of a TableRow. It shows "text", or its children. With header true, it is a header cell.
  - vAlign: Default "start" Must be one of: 'start', 'center', 'end'
  - align: Must be one of: 'start', 'center', 'end'
• TableRow(children?, label?, header?, labelColSpan?)
  - Description: A row of a Table. Its children are TableCell ids, or a template. With label, a header cell with that text starts the row.
  - label: The text of a header cell at the start of the row
  - labelColSpan: Columns the label cell spans
• TableSection(children?, header?, rowDivider?)
  - Description: A group of TableRow children in a Table. With header true, it is the header of the table.
  - header: Renders the rows as the header
• Tabs(tabs, selectedIndex?, weight?)
  - Description: Tabs that show one panel at a time. Each tab has a title and the id of its panel component: "tabs":[{"title":"Specs","child":"specs"}].
  - tabs: One entry per tab
  - selectedIndex: The open tab. Default 0. Bind it with { "@path": "/x" } to read it
  - weight: flex-grow in a Row or Column
• TagList(tags, tone?)
  - Description: Wrapping list of tags/chips.
  - tone: Must be one of: 'default', 'positive', 'negative', 'warning', 'info', 'accent'
• Text(text?, children?, color?, fontWeight?, textAlign?, italic?, truncate?, maxLines?, tabularNums?, width?, weight?, size?, fontSize?, lineHeight?, minLines?, strong?, underline?, lineThrough?, inline?, preserveWhitespace?, highlight?)
  - Description: Body text in a Card or next to another component; a paragraph alone is markdown outside the fence. Color "default" or "secondary". `text` takes inline markdown (**bold**, *italic*, ~~strike~~, ++underline++, `code`, [link](url)). `children` ids render inline after it, e.g. a Badge.
  - text: Text with inline markdown. A bound number shows as text
  - color: One of default|prose|primary|emphasis|secondary|tertiary|success|info|warning|caution|danger|discovery or a CSS color
  - fontWeight: Must be one of: 'normal', 'medium', 'semibold', 'bold'
  - textAlign: Must be one of: 'start', 'center', 'end'
  - weight: flex-grow in a Row or Column
  - size: Default "md" Must be one of: '3xs', '2xs', 'xs', 'sm', 'md', 'lg'
  - fontSize: Pixels when a number. Wins over size
  - lineHeight: A unitless ratio, or CSS
  - minLines: Reserves the height of this many lines
  - strong: Default false
  - highlight: Must be one of: 'green', 'orange', 'pink'
• TextArea(label?, value?, checks?, placeholder?, rows?, maxRows?, autoResize?, name?, required?, disabled?, invalid?, weight?, size?)
  - Description: A multi-line text input. Bind value with { "@path": "/x" } to read what the user typed. Give it a label.
  - label: The visible label of the field. Always set it
  - value: Bind it with { "@path": "/x" } to read what the user entered
  - checks: Validation rules. The control shows the first failed one
  - rows: Default 3
  - weight: flex-grow in a Row or Column
  - size: Default "xl" Must be one of: 'sm', 'md', 'lg', 'xl'
• TextField(label?, value?, checks?, placeholder?, variant?, name?, required?, disabled?, invalid?, autoSelect?, mask?, weight?, size?, pill?)
  - Description: A text input, single-line unless variant is "longText". Bind value with { "@path": "/x" } to read what the user typed. Give it a label.
  - label: The visible label of the field. Always set it
  - value: Bind it with { "@path": "/x" } to read what the user typed
  - checks: Validation rules. The control shows the first failed one
  - variant: Default "shortText". "longText" is a multi-line field, "obscured" a password Must be one of: 'shortText', 'longText', 'number', 'obscured', 'email', 'url', 'tel'
  - weight: flex-grow in a Row or Column
  - size: Default "xl" Must be one of: 'sm', 'md', 'lg', 'xl'
  - pill: Default true
• Timeline(items)
  - Description: Vertical timeline of dated events or steps with status.
• Title(text, color?, fontWeight?, textAlign?, italic?, truncate?, maxLines?, tabularNums?, width?, size?, strong?)
  - Description: A heading in a Card or next to another component; a heading alone is markdown. Size "2xl" at most once per surface, "lg" for sections. "sm" is an h4, "md"/"lg" an h3 (default "md"), "xl" and up an h2. Bold unless strong is false.
  - text: Heading text
  - color: One of default|prose|primary|emphasis|secondary|tertiary|success|info|warning|caution|danger|discovery or a CSS color
  - fontWeight: Must be one of: 'normal', 'medium', 'semibold', 'bold'
  - textAlign: Must be one of: 'start', 'center', 'end'
  - size: Default "md" Must be one of: 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'
  - strong: Default true
• Tooltip(trigger? (component ID), content? (component ID))
  - Description: Shows `content` when the user points at or focuses `trigger`. `trigger`: one child id, a Text, Icon or Badge (not a Button or Link). `content`: one child id of short text, no links or buttons.
• Treemap(title?, subtitle?, height?, format?, unit?, data)
  - Description: Nested part-to-whole as rectangles. data [{name,value,group?}].
  - format: Must be one of: 'number', 'currency', 'percent', 'compact'
• Underline(text)
  - Description: Underlined inline text.
• Video(url, title?, captions?, posterUrl?, aspectRatio?, width?, maxWidth?, weight?)
  - Description: A video file URL (optional captions) or a YouTube link, privacy-enhanced: the poster shows until play. Other video sites show as a link. Set title.
  - url: The URL of a video file, or of a YouTube video or short. A page on another video site shows as a link
  - title: Names the video for screen readers
  - captions: Caption tracks of a video file
  - posterUrl: The image shown before the video plays
  - aspectRatio: Default "16 / 9"
  - width: Default "100%"
  - maxWidth: Default "100%"
  - weight: flex-grow in a Row or Column
• VideoEmbed(url, title?)
  - Description: Embedded YouTube/Vimeo video by URL.
• WeatherCard(location, temp, condition, icon?, high?, low?, feels?, humidity?, wind?, unit?, hourly?, daily?)
  - Description: Current weather hero with condition icon, temp, high/low, details, an hourly strip and daily forecast. icon: sun|cloud-sun|cloud|fog|drizzle|rain|snow|storm.
  - unit: Must be one of: 'C', 'F'

## Positional Function Signatures

Use these exact positional signatures to instantiate check rules or logic functions:
• and(values)
  - Description: True when every value is true
• calc(expression)
  - Description: The value of an arithmetic expression over the other args, by name: + - * / % ( ), x ^ y (power), comparisons, && || !, cond ? a : b, min max round floor ceil abs pow sqrt exp ln log10, the constants pi and e, 'text' + name
• email(value)
  - Description: Valid when the value is an email address
• formatCurrency(value, currency, decimals?, grouping?)
  - Description: The amount as money, with an ISO 4217 currency code
• formatDate(value, format)
  - Description: A date or ISO string in a TR35 pattern, for example "MMM d, yyyy" or "HH:mm"
• formatNumber(value, decimals?, grouping?)
  - Description: The number in the locale of the user
• formatString(value)
  - Description: Interpolates ${/path}, ${relative/path} and ${fn(arg: value)} in the value; \${ is a literal
• length(value, min?, max?)
  - Description: Valid when the length of the value is within min and max
• not(value)
  - Description: The negated value
• numeric(value, min?, max?)
  - Description: Valid when the value is a number within min and max
• openUrl(url)
  - Description: Opens an http(s) URL in a new tab. Only from an event
• or(values)
  - Description: True when any value is true
• pluralize(value, zero?, one?, two?, few?, many?, other)
  - Description: The string of the plural category of the value
• regex(value, pattern)
  - Description: Valid when the value matches the pattern
• required(value)
  - Description: Valid when the value is not empty
• series(count, item, variable?, start?)
  - Description: A list of count copies of item, for chart data and template lists. Put arithmetic in ${expression} strings in item, using the loop variable (default i, counting from start, default 1) and other named args. A whole-expression string retains the result type, so "${i * monthlyCost}" yields a number. Arguments, including nested calc or formatString calls in item, resolve before the series loop; those calls cannot use the loop variable. Example: {"@call":"series","args":{"count":6,"item":{"month":"${i}","cost":"${i * monthlyCost}"},"monthlyCost":{"@path":"/monthlyCost"}}}. Omit variable to use i.
