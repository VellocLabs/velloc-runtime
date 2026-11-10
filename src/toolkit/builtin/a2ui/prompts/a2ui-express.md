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
• AddCard(label, action (static), weight? (static))
  - label: What a click does, shown as the tooltip and read by screen readers, e.g. "Add alert".
  - action: Sent when the card is clicked, as a Button press is.
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• AudioPlayer(url, description?, weight? (static))
  - url: The URL of the audio to be played.
  - description: A description of the audio, such as a title or summary.
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Badge(text, tone?, weight? (static))
  - text: The label, literal or a data binding.
  - tone: Its colour by meaning: "neutral", "info", "success", "warning", "danger"; literal or a data binding; default "neutral".
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• BarChart(title?, data, xKey (static), series (static), stacked? (static), height? (static), valuePrefix? (static), valueSuffix? (static), weight? (static))
  - title: Heading drawn above the chart.
  - data: Row objects, literal or a data binding, e.g. [{month: "Jan", sales: 120}].
  - xKey: The field of each row used as the category axis.
  - series: One entry per line or bar group.
    List of maps keys:
    * key - The numeric field of each row this series draws.
    * label - Legend label; defaults to the key.
    * color - CSS color; leave out to use the theme palette.
  - stacked: Stack the series in one bar per row.
  - height: Chart height in pixels; default 240.
  - valuePrefix: Text before each value on the value axis and in the tooltip, e.g. "$".
  - valueSuffix: Text after each value on the value axis and in the tooltip, e.g. "K".
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• Button(child (static), variant? (static), action (static), weight? (static), checks? (static))
  - child: The ID of the child component. Use a 'Text' component for a labeled button. Only use an 'Icon' if the requirements explicitly ask for an icon-only button.
  - variant: A hint for the button style. If omitted, a default button style is used. 'primary' indicates this is the main call-to-action button. 'borderless' means the button has no visual border or background, making its child content appear like a clickable link. Must be one of: 'default', 'primary', 'borderless'
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Card(child (static), weight? (static))
  - child: The ID of the single child component to be rendered inside the card. To display multiple elements, you MUST wrap them in a layout component (like Column or Row) and pass that container's ID here. Do NOT pass multiple IDs or a non-existent ID.
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• CheckBox(label, value, weight? (static), checks? (static))
  - label: The text to display next to the checkbox.
  - value: The current state of the checkbox (true for checked, false for unchecked).
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• ChoicePicker(label?, variant? (static), options (static), value, displayStyle? (static), filterable? (static), weight? (static), checks? (static))
  - Description: A component that allows selecting one or more options from a list.
  - label: The label for the group of options.
  - variant: A hint for how the choice picker should be displayed and behave. Must be one of: 'multipleSelection', 'mutuallyExclusive'
  - options: The list of available options to choose from.
    List of maps keys:
    * label - The text to display for this option.
    * value - The stable value associated with this option.
  - value: The list of currently selected values. This should be bound to a string array in the data model.
  - displayStyle: The display style of the component. Must be one of: 'checkbox', 'chips'
  - filterable: If true, displays a search input to filter the options.
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Column(children, justify? (static), align? (static), weight? (static))
  - Description: A layout component that arranges its children vertically. To create a grid layout, nest Rows within this Column.
  - children: Defines the children. Use an array of strings for a fixed set of children, or a template object to generate children from a data list. Children cannot be defined inline, they must be referred to by ID.
  - justify: Defines the arrangement of children along the main axis (vertically). Use 'spaceBetween' to push items to the edges (e.g. header at top, footer at bottom), or 'start'/'end'/'center' to pack them together. Must be one of: 'start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'
  - align: Defines the alignment of children along the cross axis (horizontally). This is similar to the CSS 'align-items' property. Must be one of: 'center', 'end', 'start', 'stretch'
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• DataTable(columns (static), rows, weight? (static))
  - columns: Columns in order: key names the row field, label the header.
    List of maps keys:
    * key - The row field this column shows.
    * label - The header.
    * align - "end" right-aligns the column, e.g. for amounts.
    * badge - Draw each cell as a badge, toned by its value, e.g. {Paid: "success", Failed: "danger"}; other values are neutral.
  - rows: Row objects keyed by the column keys, literal or a data binding.
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• DateTimeInput(value, enableDate? (static), enableTime? (static), min?, max?, label?, weight? (static), checks? (static))
  - value: The selected date and/or time value in ISO 8601 format. If not yet set, initialize with an empty string.
  - enableDate: If true, allows the user to select a date.
  - enableTime: If true, allows the user to select a time.
  - min: The minimum allowed date/time in ISO 8601 format.
  - max: The maximum allowed date/time in ISO 8601 format.
  - label: The text label for the input field.
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Divider(axis? (static), weight? (static))
  - axis: The orientation of the divider. Must be one of: 'horizontal', 'vertical'
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Grid(children, minWidth? (static), after? (component ID), weight? (static))
  - children: The cells: an array of ids, or a template over a data list, e.g. one Card per row of the list.
  - minWidth: The narrowest a column may get, in pixels; default 280, kept within 120-800. A child narrower than the pane never overflows it.
  - after: One more cell after the children, by id, e.g. an AddCard that adds to the list.
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• Heading(text, level? (static), subtitle?, action? (static), actionLabel?, weight? (static))
  - text: The title text, literal or a data binding.
  - level: 1, 2 or 3; default 2.
  - subtitle: A short line under the title in small muted text.
  - action: Optional: leave it out when there is nothing to ask. With actionLabel, a small ask button after the subtitle (or the title) sends this action when clicked, as a Button press does.
  - actionLabel: The ask button's label, literal or a data binding; it shows while the pointer is over the heading. Without it there is no button.
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• HoverBar(children, weight? (static))
  - children: The buttons, by id, e.g. [editButton, deleteButton]; borderless Buttons with an Icon and a short Text read best.
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• Icon(name, weight? (static))
  - name: The name of the icon to display. Must be one of: 'accountCircle', 'add', 'arrowBack', 'arrowForward', 'attachFile', 'calendarToday', 'call', 'camera', 'check', 'close', 'delete', 'download', 'edit', 'event', 'error', 'fastForward', 'favorite', 'favoriteOff', 'folder', 'help', 'home', 'info', 'locationOn', 'lock', 'lockOpen', 'mail', 'menu', 'moreVert', 'moreHoriz', 'notificationsOff', 'notifications', 'pause', 'payment', 'person', 'phone', 'photo', 'play', 'print', 'refresh', 'rewind', 'search', 'send', 'settings', 'share', 'shoppingCart', 'skipNext', 'skipPrevious', 'star', 'starHalf', 'starOff', 'stop', 'upload', 'visibility', 'visibilityOff', 'volumeDown', 'volumeMute', 'volumeOff', 'volumeUp', 'warning'
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Image(url, description?, fit? (static), variant? (static), weight? (static))
  - url: The URL of the image to display.
  - description: Accessibility text for the image.
  - fit: Specifies how the image should be resized to fit its container. This corresponds to the CSS 'object-fit' property. Must be one of: 'contain', 'cover', 'fill', 'none', 'scaleDown'
  - variant: A hint for the image size and style. Must be one of: 'icon', 'avatar', 'smallFeature', 'mediumFeature', 'largeFeature', 'header'
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• LineChart(title?, data, xKey (static), series (static), curved? (static), height? (static), valuePrefix? (static), valueSuffix? (static), weight? (static))
  - title: Heading drawn above the chart.
  - data: Row objects, literal or a data binding, e.g. [{month: "Jan", sales: 120}].
  - xKey: The field of each row used as the category axis.
  - series: One entry per line or bar group.
    List of maps keys:
    * key - The numeric field of each row this series draws.
    * label - Legend label; defaults to the key.
    * color - CSS color; leave out to use the theme palette.
  - curved: Smooth the lines.
  - height: Chart height in pixels; default 240.
  - valuePrefix: Text before each value on the value axis and in the tooltip, e.g. "$".
  - valueSuffix: Text after each value on the value axis and in the tooltip, e.g. "K".
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• List(children, direction? (static), align? (static), weight? (static))
  - children: Defines the children. Use an array of strings for a fixed set of children, or a template object to generate children from a data list.
  - direction: The direction in which the list items are laid out. Must be one of: 'vertical', 'horizontal'
  - align: Defines the alignment of children along the cross axis. Must be one of: 'start', 'center', 'end', 'stretch'
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Menu(label, children, weight? (static))
  - label: The button's accessible name and tooltip, e.g. "More".
  - children: The menu items, by id, top to bottom, e.g. [undoButton, deleteButton]; borderless Buttons with a short Text read best.
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• Metric(label, value, delta?, trend?, caption?, better?, action? (static), actionLabel?, weight? (static))
  - label: What the figure measures.
  - value: The figure, already formatted (e.g. "$980K").
  - delta: Change versus the previous period, e.g. "+12%".
  - trend: Direction of the change, "up", "down" or "flat" ("neutral" reads as "flat"), literal or a data binding; colours the delta.
  - caption: A short note under the figure.
  - better: Which direction is good, "up" (default) or "down", literal or a data binding. With "down" a rise is coloured as bad and a fall as good, e.g. for a refund rate; the arrow still follows trend.
  - action: Optional, unlike a Button's action: leave it out when there is nothing to ask. With actionLabel, a small ask button sends this action when clicked, as a Button press does, e.g. Event("explain_metric", {metric: "Refund rate"}). When it is the only Metric with an action in its Card it sits in the card's top-right corner; otherwise after the delta.
  - actionLabel: The ask button's label, e.g. "Ask why", literal or a data binding; it shows while the pointer is over the figure, or over its Card when it takes the corner. Without it there is no button.
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• Modal(trigger (static), content (static), weight? (static))
  - trigger: The ID of the component that opens the modal when interacted with (e.g., a button).
  - content: The ID of the component to be displayed inside the modal.
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• PieChart(title?, data, donut? (static), height? (static), valuePrefix? (static), valueSuffix? (static), weight? (static))
  - title: Heading drawn above the chart.
  - data: Slices: [{label, value, color?}], literal or a data binding.
  - donut: Draw as a ring instead of a full pie.
  - height: Chart height in pixels; default 240.
  - valuePrefix: Text before each value in the legend and the tooltip, e.g. "$".
  - valueSuffix: Text after each value in the legend and the tooltip, e.g. "%".
  - weight: Flex share inside a Row or Column; only on a direct child of one.
• Row(children, justify? (static), align? (static), weight? (static))
  - Description: A layout component that arranges its children horizontally. To create a grid layout, nest Columns within this Row.
  - children: Defines the children. Use an array of strings for a fixed set of children, or a template object to generate children from a data list. Children cannot be defined inline, they must be referred to by ID.
  - justify: Defines the arrangement of children along the main axis (horizontally). Use 'spaceBetween' to push items to the edges, or 'start'/'end'/'center' to pack them together. Must be one of: 'center', 'end', 'spaceAround', 'spaceBetween', 'spaceEvenly', 'start', 'stretch'
  - align: Defines the alignment of children along the cross axis (vertically). This is similar to the CSS 'align-items' property, but uses camelCase values (e.g., 'start'). Must be one of: 'start', 'center', 'end', 'stretch'
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Slider(label?, min? (static), max (static), value, steps? (static), weight? (static), checks? (static))
  - label: The label for the slider.
  - min: The minimum value of the slider.
  - max: The maximum value of the slider.
  - value: The current value of the slider.
  - steps: The number of discrete divisions in the slider range. If specified, the slider will snap to discrete values.
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Tabs(tabs (static), open?, weight? (static))
  - tabs: An array of objects, where each object defines a tab with a title, a child component and an optional badge.
    List of maps keys:
    * title - The tab title.
    * child - The ID of the child component.
    * badge - A count drawn as a small red pill after the title, e.g. open items; literal or a data binding. Hidden when missing, 0 or empty.
  - open: The zero-based index of the tab shown first, literal or a data binding; default 0, out of range is 0. Only its first value is applied; a later change does not move the view.
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Text(text, variant? (static), weight? (static))
  - text: The text content to display. While simple Markdown formatting is supported (i.e. without HTML, images, or links), utilizing dedicated UI components is generally preferred for a richer and more structured presentation.
  - variant: A hint for the base text style. Must be one of: 'caption', 'body'
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• TextField(label, value?, placeholder?, variant? (static), weight? (static), checks? (static))
  - label: The text label for the input field.
  - value: The value of the text field.
  - placeholder: The placeholder text for the input field.
  - variant: The type of input field to display. Must be one of: 'longText', 'number', 'shortText', 'obscured'
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.
• Video(url, posterUrl?, weight? (static))
  - url: The URL of the video to display.
  - posterUrl: The URL of the poster image to display before the video plays.
  - weight: The relative weight of this component within a Row or Column. This is similar to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column.

## Positional Function Signatures

Use these exact positional signatures to instantiate check rules or logic functions:
• and(values)
  - Description: Performs a logical AND operation on a list of boolean values.
  - values: The list of boolean values to evaluate.
• email(value)
  - Description: Checks that the value is a valid email address.
• formatCurrency(value, currency, decimals?, grouping?)
  - Description: Formats a number as a currency string.
  - value: The monetary amount.
  - currency: The ISO 4217 currency code (e.g., 'USD', 'EUR').
  - decimals: Optional. The number of decimal places to show. Defaults to 0 or 2 depending on locale.
  - grouping: Optional. If true, uses locale-specific grouping separators (e.g. '1,000'). If false, returns raw digits (e.g. '1000'). Defaults to true.
• formatDate(value, format)
  - Description: Formats a timestamp into a string using a pattern.
  - value: The date to format.
  - format: A Unicode TR35 date pattern string.

Token Reference:
- Year: 'yy' (26), 'yyyy' (2026)
- Month: 'M' (1), 'MM' (01), 'MMM' (Jan), 'MMMM' (January)
- Day: 'd' (1), 'dd' (01), 'E' (Tue), 'EEEE' (Tuesday)
- Hour (12h): 'h' (1-12), 'hh' (01-12) - requires 'a' for AM/PM
- Hour (24h): 'H' (0-23), 'HH' (00-23) - Military Time
- Minute: 'mm' (00-59)
- Second: 'ss' (00-59)
- Period: 'a' (AM/PM)

Examples:
- 'MMM dd, yyyy' -> 'Jan 16, 2026'
- 'HH:mm' -> '14:30' (Military)
- 'h:mm a' -> '2:30 PM'
- 'EEEE, d MMMM' -> 'Friday, 16 January'
• formatNumber(value, decimals?, grouping?)
  - Description: Formats a number with the specified grouping and decimal precision.
  - value: The number to format.
  - decimals: Optional. The number of decimal places to show. Defaults to 0 or 2 depending on locale.
  - grouping: Optional. If true, uses locale-specific grouping separators (e.g. '1,000'). If false, returns raw digits (e.g. '1000'). Defaults to true.
• formatString(value)
  - Description: Performs string interpolation of data model values and other functions in the catalog functions list and returns the resulting string. The value string can contain interpolated expressions in the `${expression}` format. Supported expression types include: JSON Pointer paths to the data model (e.g., `${/absolute/path}` or `${relative/path}`), and renderer-side function calls (e.g., `${now()}`). Function arguments must be named (e.g., `${formatDate(value:${/currentDate}, format:'MM-dd')}`). To include a literal `${` sequence, escape it as `\${`.
• length(value, min?, max?)
  - Description: Checks string length constraints.
  - min: The minimum allowed length.
  - max: The maximum allowed length.
• not(value)
  - Description: Performs a logical NOT operation on a boolean value.
  - value: The boolean value to negate.
• numeric(value, min?, max?)
  - Description: Checks numeric range constraints.
  - min: The minimum allowed value.
  - max: The maximum allowed value.
• openUrl(url)
  - Description: Opens the specified URL in a browser or handler (requires user activation). This function has no return value.
  - url: The URL to open.
• or(values)
  - Description: Performs a logical OR operation on a list of boolean values.
  - values: The list of boolean values to evaluate.
• pluralize(value, zero?, one?, two?, few?, many?, other)
  - Description: Returns a localized string based on the Common Locale Data Repository (CLDR) plural category of the count (zero, one, two, few, many, other). Requires an 'other' fallback. For English, just use 'one' and 'other'.
  - value: The numeric value used to determine the plural category.
  - zero: String for the 'zero' category (e.g., 0 items).
  - one: String for the 'one' category (e.g., 1 item).
  - two: String for the 'two' category (used in Arabic, Welsh, etc.).
  - few: String for the 'few' category (e.g., small groups in Slavic languages).
  - many: String for the 'many' category (e.g., large groups in various languages).
  - other: The default/fallback string (used for general plural cases).
• regex(value, pattern)
  - Description: Checks that the value matches a regular expression string.
  - pattern: The regex pattern to match against.
• required(value)
  - Description: Checks that the value is not null, undefined, or empty.
  - value: The value to check.

## Catalog Instructions

For layout, use the Row and Column components to organize other components.

## Catalog Guidelines

1. String Concatenation & Formatting: A2UI does not support binary operators like '+' or formatting symbols. To concatenate strings or dynamically inject data bindings into text, you must use the catalog function `formatString(value)` where the value string contains placeholders formatted as `${expression}`:
   formatString("Hello ${/user/name}")

2. Strict Hierarchy: You must strictly adhere to the requested component nesting and hierarchy. If the prompt specifies that a component is 'inside' or 'contained in' another component, you MUST place it as a child of that specific component, not as a sibling or in a different container.

3. Validation Checks: When components support validation checks, specify any custom error messages directly as the 'message' inside the check. Do NOT create separate text-display components to display validation errors.

## Examples

Example 1: Dynamic text form
```json
[
  {
    "version": "1.0",
    "createSurface": {
      "surfaceId": "main",
      "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
      "components": [
        {
          "id": "root",
          "component": "Column",
          "children": ["repField", "valueField"]
        },
        {
          "id": "repField",
          "component": "TextField",
          "label": "Representative",
          "value": {"@path": "/form/rep"},
          "placeholder": "Enter name"
        },
        {
          "id": "valueField",
          "component": "TextField",
          "label": "Deal Value",
          "value": {"@path": "/form/value"},
          "placeholder": "0.00",
          "variant": "number",
          "checks": [
            {
              "condition": {
                "@call": "required",
                "args": {"value": {"@path": "/form/value"}}
              },
              "message": "Deal value is required."
            }
          ]
        }
      ],
      "dataModel": {
        "form": {
          "rep": "John Doe",
          "value": 1500.00
        }
      }
    }
  }
]
```

Example 2: Dynamic list with templates
```json
[
  {
    "version": "1.0",
    "createSurface": {
      "surfaceId": "main",
      "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
      "components": [
        {
          "id": "root",
          "component": "Card",
          "child": "breedList"
        },
        {
          "id": "breedList",
          "component": "List",
          "children": {
            "path": "/breeds",
            "componentId": "breedTemplate"
          },
          "direction": "horizontal"
        },
        {
          "id": "breedTemplate",
          "component": "Image",
          "url": {"@path": "url"}
        }
      ],
      "dataModel": {
        "breeds": [
          {
            "url": "https://example.com/poodle.jpg"
          },
          {
            "url": "https://example.com/lab.jpg"
          }
        ]
      }
    }
  }
]
```

## Charts and data

Draw numbers as charts, not prose: PieChart for shares, LineChart for a trend over time, BarChart to compare categories, Metric for one key figure, DataTable for rows. Put the rows in the data model and bind them, so a later update can change the data alone. Group charts in Cards inside a Row or Column for a dashboard. Leave colors out to use the theme palette. For a list of like cards (one per alert, product or account), use a Grid with a template child: Grid(_template($/alerts, alertCard)); the cards wrap into equal columns instead of stretching across the pane. To offer per-card actions without crowding the card, put one HoverBar of borderless Buttons anywhere in it: it shows in the cell's top-right corner while the pointer is over the card (every HoverBar in a cell takes that corner, so give each card one). To let the user add to the list, end the Grid with an AddCard rather than a separate button: Grid(_template($/alerts, alertCard), after=addAlert), addAlert = AddCard("Add alert", Event("add_alert")). Put actions a card needs rarely (undo, delete) in a Menu, so they stay out of the way: Menu("More", [undoButton, deleteButton]).

Title a dashboard with Heading (level 1 for the page, 3 for a card); its subtitle is the small line under it. Show a status with Badge, or give a DataTable column a badge map so each cell is one. Put a chart's unit (its value axis, a pie's legend, the tooltip) in valuePrefix / valueSuffix rather than in the numbers.

Give a Metric better: "down" when a rise is bad (refund rate, churn, latency), so its delta is coloured by meaning. To let the user ask about a change where it is shown, give the Metric an action and an actionLabel, e.g. action=Event("explain_metric", {metric: "Refund rate"}), actionLabel="Ask why"; the action comes back to you like a Button press. A Metric's action is optional: leave both out on a plain figure, and never give it a placeholder Event("click"). A Heading takes the same action and actionLabel, to ask about everything under it.

Example 3: Sales dashboard
```
<a2ui>
surface("sales")
$/months = [{month: "Jan", sales: 120}, {month: "Feb", sales: 150}]
$/regions = [{label: "North", value: 45}, {label: "South", value: 30}]
$/total = "$980K"
root = Column([total, charts])
total = Metric("Revenue", $/total, "+12%", "up")
charts = Row([shareCard, trendCard])
shareCard = Card(share, 1)
share = PieChart("By region", $/regions, true)
trendCard = Card(trend, 1)
trend = LineChart("Monthly", $/months, "month", [{key: "sales", label: "Sales"}])
</a2ui>
```

Give a tab a badge for a count that needs attention, e.g. {title: "Inbox", child: inbox, badge: $/inbox/count}; a badge of 0 or no value is hidden, so bind it rather than leaving it out. Use open=1 (zero-based) to show a tab other than the first when the surface is drawn.
