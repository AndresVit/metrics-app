# Timing DSL Specification

## 1. Purpose

### 1.1 What TIM Represents

TIM (Timing) is a MetricDefinition that captures a single time interval with categorized time allocation. Each TIM entry represents one contiguous block of time with:
- Start and end times
- Duration
- Breakdown of how time was spent across categories (productive, meetings, planning, neutral)

### 1.2 Why Timing Blocks Exist

Timing blocks provide a compact DSL for logging multiple time intervals in a single input. Instead of creating entries one at a time, users can log an entire work session:

```
EST:TFG/coding;adv:10,project:thesis
1230-1310 t30m10
1310-1350 t35m5
1400-1430 t25m5
```

This creates three TIM entries and three parent (EST) entries, each with its own timing data.

### 1.3 Relation Between Parent Metric and TIM

Parent metrics (EST, READ, etc.) reference TIM via a required field:

```
METRIC EST
  timing: TIM
  adv?: int
  project?: string
END
```

The `?` suffix marks fields as optional (cardinality 0..1). Optional fields may be omitted from input without causing validation errors. See Section 9 for details on optional field syntax.

Each timing line produces:
1. One TIM MetricEntry (timing data)
2. One parent MetricEntry (EST) with its `timing` field referencing that TIM

The TIM entry stores `parent_entry_id` pointing to the parent, enabling reverse navigation.

## 2. Block Structure

A timing block consists of a header line followed by one or more timing lines.

**Important:** The date for entries is NOT part of the DSL. The Data Entry View uses the **anchor date from the Temporal Context Bar** as the date for all entries:
- Entry `timestamp` is set to the anchor date at 00:00
- `time_init` and `time_end` specify hours/minutes within that day
- To enter data for a different date, navigate using the Temporal Context Bar

### 2.1 Header Line Format

```
DEF_CODE:subdivision;attr:value,attr:value[;tag:value,tag:value]
```

Components:
| Component | Required | Description |
|-----------|----------|-------------|
| `DEF_CODE` | Yes | Parent metric definition code (e.g., EST, READ) |
| `:subdivision` | No | Hierarchical context (e.g., TFG/coding) |
| `;attr:value,...` | Yes | Attribute values for the parent metric |
| `;tag:value,...` | No | Tags applied to all entries in the block |

Example:
```
EST:TFG/coding;adv:10,project:thesis;place:library,mood:focused
```

### 2.2 Timing Line Format

```
HHMM-HHMM <tokens> [| attr_overrides] [| tags]
```

Components:
| Component | Required | Description |
|-----------|----------|-------------|
| `HHMM-HHMM` | Yes | Time range in 24-hour format |
| `<tokens>` | Yes | Timing tokens (e.g., t30m10n5) |
| `\| attr_overrides` | No | Override header attributes for this line |
| `\| tags` | No | Additional tags for this line |

Example:
```
1230-1310 t30m10 | adv:8 | place:cafe
```

## 3. Time Rules

### 3.1 Time Format

Format: `HHMM-HHMM`

- HH: hours (00-23, or higher for next-day times)
- MM: minutes (00-59)
- No separator between hours and minutes
- Hyphen separates start and end times

### 3.2 Time Calculations

```
time_init = start_hour × 60 + start_minutes
time_end = end_hour × 60 + end_minutes
duration = time_end - time_init
```

### 3.3 Validation Rules

| Rule | Constraint |
|------|------------|
| Minutes range | 0-59 |
| Duration | Must be > 0 |
| Ordering | Lines must be chronologically ordered |
| Overlap | Time ranges must not overlap within a block |

### 3.4 Crossing Midnight

Times may exceed 24:00 to represent next-day times:

```
2315-2430    # 23:15 to 00:30 next day
```

Calculations:
- time_init = 23 × 60 + 15 = 1395
- time_end = 24 × 60 + 30 = 1470
- duration = 75 minutes

## 4. Timing Tokens

### 4.1 Token Syntax

Tokens encode time allocation across categories.

Basic format: `<letter><number>[<letter><number>...]`

```
t30m10n5     # t:30, m:10, n:5
t45          # t:45
t20m10p5n5   # t:20, m:10, p:5, n:5
```

With subcategories: `<letter>/<subcategory><number>`

```
t12m/thk5m3  # t:12, m/thk:5, m:3 (m/thk and m are separate values)
```

### 4.2 Token Base Categories

| Base | Meaning | Included in Productivity KPIs |
|------|---------|------------------------------|
| `t` | Task / productive work | Yes |
| `m` | Meeting / collaborative work | Yes |
| `p` | Planning / preparation | Yes |
| `n` | Neutral / breaks | No (excluded) |

These are the only valid base categories. Using other letters produces a FORMULA_ERROR when computing KPIs.

### 4.3 Subcategories

Subcategories provide finer granularity:

```
m/thk    # meeting/thinking
m/sw     # meeting/software discussion
t/deep   # task/deep work
t/admin  # task/administrative
```

Subcategories are aggregated under their base when using `time()`:
- `self.time("m")` sums all m, m/thk, m/sw values

### 4.4 Token Validation

| Rule | Constraint |
|------|------------|
| Sum limit | Sum of token values ≤ duration |
| Minimum | At least one token required |
| Base validity | Only t, m, p, n are valid for KPI formulas |

## 5. Data Model Mapping

### 5.1 TIM MetricEntry Structure

Each timing line produces one TIM MetricEntry with:

**Input Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `time_init` | int | Start time in minutes from midnight |
| `time_end` | int | End time in minutes from midnight |
| `duration` | int | Duration in minutes |
| `time_type` | int (1,n) | Multi-valued field for timing tokens |

**Computed KPI Fields:**
| Field | Formula |
|-------|---------|
| `gross_productivity` | `self.time("t") / self.duration` |
| `net_productivity` | `self.time("t") / (self.time("t") + self.time("m") + self.time("p"))` |
| `internal_productivity` | `self.time("t") / (self.time("t") + self.time("m"))` |
| `external_productivity` | `(self.time("t") + self.time("m")) / (self.time("t") + self.time("m") + self.time("p"))` |

### 5.2 time_type Field Values

Each token becomes a separate AttributeEntry on the `time_type` field:

| Token | Entry.subdivision | AttributeEntry.valueInt |
|-------|-------------------|------------------------|
| t30 | "t" | 30 |
| m10 | "m" | 10 |
| m/thk5 | "m/thk" | 5 |
| n5 | "n" | 5 |

### 5.3 Parent Entry Structure

The parent entry (EST, READ, etc.) contains:
- All attributes from the header line
- Override attributes from the timing line (if any)
- Tags from header and/or timing line
- `timing` field referencing the TIM entry (via inline metric entry)

## 6. Error Handling

### 6.1 Atomic Block Processing

If ANY error occurs during parsing or validation:
- The entire block is rejected
- No entries are created
- Error includes line number and reason

### 6.2 Error Types

| Error | Cause |
|-------|-------|
| Invalid time format | Malformed HHMM-HHMM |
| Invalid minutes | Minutes outside 0-59 |
| Zero/negative duration | End time ≤ start time |
| Time overlap | Ranges overlap within block |
| Time ordering | Lines not chronologically ordered |
| Token sum exceeded | Sum of tokens > duration |
| Missing tokens | No tokens on timing line |
| Unknown definition | DEF_CODE not found |
| Missing required field | Required attribute not provided |

### 6.3 Error Format

```
Line N: <reason>
```

Example:
```
Line 3: Token sum (55) exceeds duration (40)
```

## 7. Examples

### 7.1 Minimal Example

Input:
```
EST:TFG;adv:5,project:thesis
1400-1430 t25m5
```

Produces:
- 1 TIM entry: time_init=840, time_end=870, duration=30, time_type=[t:25, m:5]
- 1 EST entry: adv=5, project="thesis", timing→TIM

### 7.2 Multiple Lines with Overrides

Input:
```
EST:Work/sprint;adv:5,project:main
0900-0930 t20m10
0930-1000 t25m5 | adv:8
1000-1030 t30 | adv:10 | mood:focused
```

Produces:
- Line 1: EST(adv=5), TIM(t:20, m:10)
- Line 2: EST(adv=8), TIM(t:25, m:5)
- Line 3: EST(adv=10, tags=[mood:focused]), TIM(t:30)

### 7.3 With Subcategories

Input:
```
EST:TFG/research;adv:7,project:paper
1400-1500 t30m/thk15m5n10
```

Produces:
- TIM entry with time_type values:
  - subdivision="t", valueInt=30
  - subdivision="m/thk", valueInt=15
  - subdivision="m", valueInt=5
  - subdivision="n", valueInt=10
- KPI calculations:
  - gross_productivity = 30/60 = 0.5
  - net_productivity = 30/(30+20+0) = 0.6 (m/thk+m = 20)
  - internal_productivity = 30/(30+20) = 0.6
  - external_productivity = (30+20)/(30+20+0) = 1.0

### 7.4 Crossing Midnight

Input:
```
EST:Personal;adv:3,project:side
2300-2430 t60m30
```

Produces:
- TIM entry: time_init=1380, time_end=1470, duration=90
- time_type: [t:60, m:30]

## 8. Extended Syntax

This section describes optional extended features for the timing DSL.

### 8.1 Inferred Timing Lines

Timing lines can omit explicit time ranges by using the `--` prefix. The start time is inferred from the previous timing's end time, and the duration is calculated from the sum of token values.

**Syntax:**
```
--<tokens> [| attr_overrides] [| tags]
```

**Example:**
```
EST:Work/sprint;adv:5,project:main
0900-0930 t20m10
0930-1000 t25m5 | adv:8
--t5m5
1010-1030 t20 | adv:10 | mood:focused
```

In this example:
- Line 3 (`--t5m5`) starts at 1000 (previous end time) and ends at 1010 (1000 + 10 minutes)
- The duration (10) is calculated from t5 + m5

**Rules:**
| Rule | Description |
|------|-------------|
| Previous required | `--` cannot be the first timing line in a block |
| Start time | Start = previous timing's end time |
| Duration | Sum of all token values (e.g., t5m5 = 10 minutes) |
| Positive duration | Total token sum must be > 0 |

**Error Examples:**
```
EST:Work;adv:5,project:main
--t5m5                      # Error: -- cannot be first timing line
```

### 8.2 Inline Date Headers

Date headers allow specifying the date directly in the DSL, overriding the anchor date from the Temporal Context.

**Syntax:**
```
[WEEKDAY]DAY/MONTH
```

**Formats:**
| Format | Example | Description |
|--------|---------|-------------|
| `D/M` | `15/1` | Day 15, Month 1 (January) |
| `WD/M` | `J15/1` | Thursday (Jueves), Day 15, Month 1 |
| `WDD/M` | `V16/1` | Friday (Viernes), Day 16, Month 1 |

**Weekday Prefixes (Spanish):**
| Prefix | Day | Spanish |
|--------|-----|---------|
| L | Monday | Lunes |
| M | Tuesday | Martes |
| X | Wednesday | Miércoles |
| J | Thursday | Jueves |
| V | Friday | Viernes |
| S | Saturday | Sábado |
| D | Sunday | Domingo |

**Example:**
```
J15/1
EST:Work/sprint;adv:5,project:main
0900-0930 t20m/thk10
0930-1000 t25m5 | adv:8
--t5m5
1010-1030 t20 | adv:10 | mood:focused
```

All entries in this block will have their timestamp set to January 15th of the anchor year.

**Rules:**
| Rule | Description |
|------|-------------|
| Year source | Year is taken from the global anchor date (never written in DSL) |
| Date scope | Date applies to all following timing lines in the block |
| No year in DSL | Writing the year (e.g., `15/1/2026`) is not supported |
| Weekday validation | If weekday prefix is provided, it's validated against the actual date |
| Weekday mismatch | Mismatches generate a **warning** (non-blocking), NOT an error |

**Weekday Validation:**
```
L15/1                        # Warning if Jan 15 is not a Monday
```

If the weekday prefix doesn't match the actual day of the week, a warning is logged but parsing continues. This allows typos to be flagged without blocking data entry.

### 8.3 Combined Example

Using all extended features together:

```
V17/1
EST:Work/sprint;adv:7,project:docs
0900-0930 t20m/thk10
0930-1000 t25m5 | adv:8
--t5n5
1010-1100 t/deep40m10 | mood:focused

L20/1
EST:Work/sprint;adv:6,project:main
1400-1500 t45p15
--t15m5
```

This example:
- Uses inline date headers (`V17/1`, `L20/1`) to set dates
- Uses hierarchical time types (`m/thk`, `t/deep`)
- Uses inferred timing (`--t5n5`, `--t15m5`)
- Combines all features with attribute overrides and tags

---

# Widget DSL Specification

## 1. Purpose

Widgets are read-only aggregation views over persisted entries. They query data, compute aggregations, and return flat JSON objects for visualization.

Key characteristics:
- Widgets are persisted in the database (per dashboard)
- Widgets are created, edited, and deleted directly from the UI
- Widget results are computed on-demand
- Widgets operate on collections, not single entries

## 2. Syntax

```
WIDGET "<name>"

<alias> = <DEF> FROM <PERIOD>

"<label>": <type> = <expression>
"<label>": <type> = <expression>
...
END
```

### 2.1 WIDGET Header

```
WIDGET "<name>"
```

- `<name>`: Human-readable widget name (quoted string)
- Required as the first non-empty line

### 2.2 Dataset Declaration

```
<alias> = <DEF> FROM <PERIOD>
```

- `<alias>`: Variable name to reference the dataset in expressions
- `<DEF>`: Definition code (e.g., TIM, READ, EST)
- `<PERIOD>`: Time period filter

**MVP Periods:**
- `TODAY`: Entries from the current calendar day

**Future Periods (not MVP):**
- `YESTERDAY`, `THIS_WEEK`, `THIS_MONTH`, `LAST_N_DAYS(n)`

### 2.3 Computed Fields

```
"<label>": <type> = <expression>
```

- `<label>`: Output field name (quoted string)
- `<type>`: `int` or `float`
- `<expression>`: Aggregation expression

### 2.4 END Keyword

The widget definition must end with `END` on its own line.

## 3. Expressions

### 3.1 Dataset Reference

Reference the dataset by its alias:
```
tims        # The collection of TIM entries
reads       # The collection of READ entries
```

### 3.2 Field Access

Access fields on the collection:
```
tims.duration     # Array of duration values
reads.pages_read  # Array of pages_read values
```

### 3.3 Aggregation Functions

| Function | Description |
|----------|-------------|
| `sum(values)` | Sum of all values |
| `avg(values)` | Average of all values |
| `count(collection)` | Number of entries |

Examples:
```
sum(tims.duration)
avg(reads.pages_read)
count(tims)
```

### 3.4 time() Method (TIM only)

For TIM collections, aggregate time by base category:
```
tims.time("t")   # Array of productive time per entry
tims.time("m")   # Array of meeting time per entry
```

Combined with aggregation:
```
sum(tims.time("t"))   # Total productive time
```

### 3.5 Arithmetic

Standard arithmetic operators:
```
sum(tims.time("t")) + sum(tims.time("m"))
sum(tims.time("t")) / sum(tims.duration)
```

**Important:** Arithmetic requires scalar values. Aggregate collections first.

### 3.6 Parentheses

Group expressions with parentheses:
```
sum(tims.time("t")) / (sum(tims.time("t")) + sum(tims.time("m")))
```

## 4. Output

Widget evaluation returns a flat JSON object:
```json
{
  "label1": value1,
  "label2": value2,
  ...
}
```

Types are coerced according to field declarations:
- `int`: Values are floored to integers
- `float`: Values remain as floating-point

## 5. Examples

### 5.1 Daily Productivity

```
WIDGET "Daily Productivity"

tims = TIM

"productive_time": int = sum(tims.time("t"))
"total_duration": int = sum(tims.duration)
"productivity": float = sum(tims.time("t")) / sum(tims.duration)
END
```

Note: The time period (day/week/month/year) comes from the temporal context, not from the DSL.

Output:
```json
{
  "productive_time": 165,
  "total_duration": 240,
  "productivity": 0.6875
}
```

### 5.2 Daily Reading

```
WIDGET "Daily Reading"

reads = READ

"pages": int = sum(reads.pages_read)
"duration": int = sum(reads.duration)
"sessions": int = count(reads)
END
```

Output:
```json
{
  "pages": 55,
  "duration": 95,
  "sessions": 2
}
```

### 5.3 Productivity Breakdown

```
WIDGET "Time Breakdown"

tims = TIM

"good": int = sum(tims.time("t"))
"meeting": int = sum(tims.time("m"))
"planning": int = sum(tims.time("p"))
"neutral": int = sum(tims.time("n"))
"net_productivity": float = sum(tims.time("t")) / (sum(tims.time("t")) + sum(tims.time("m")) + sum(tims.time("p")))
END
```

## 6. Error Handling

| Error | Cause |
|-------|-------|
| Parse error | Invalid syntax |
| Unknown definition | DEF code not found |
| Unknown field | Field name not in definition |
| Division by zero | Denominator evaluates to 0 |
| Type mismatch | Arithmetic on non-numeric values |

## 7. MVP Limitations

The following features are NOT part of MVP:

| Feature | Status |
|---------|--------|
| WHERE clauses | Deferred |
| Multiple datasets | Deferred |
| Joins across definitions | Deferred |
| Periods other than TODAY | Deferred |
| min(), max() aggregations | Deferred |
| String operations | Deferred |

---

## 8. GROUP BY Clause (v1)

### 8.1 Overview

GroupBy allows evaluating the same set of formulas across multiple groups. GroupBy is a core engine feature, not tied to a specific widget type.

**Important constraints:**
- GroupBy v1 supports only **ONE dataset per widget**
- GroupBy uses the **Global Temporal Context** for smallPeriod values
- The DSL clause is declarative only - it never specifies parameter values

### 8.2 Syntax

GroupBy appears immediately after the dataset declaration:

```
group by <source>
```

Valid sources:
- `attribute:<attribute_name>` - Group by a string attribute value
- `smallPeriod` - Group by temporal sub-periods from Global Temporal Context

Keywords are case-insensitive (`group by`, `GROUP BY`, `Group By` all work).

### 8.3 KPI Widget with GROUP BY

```
WIDGET "Study by Subject" TYPE KPI

tims = TIM
group by attribute:subject

PRIMARY:
  "productivity": float = sum(tims.time("t")) / sum(tims.duration)

SECONDARY:
  "total_time": int = sum(tims.duration)

END
```

Result structure:
```json
{
  "groups": [
    { "key": "math", "label": "math", "values": { "productivity": 0.85, "total_time": 120 } },
    { "key": "physics", "label": "physics", "values": { "productivity": 0.72, "total_time": 90 } },
    { "key": "unknown", "label": "Unknown", "values": { "productivity": 0.50, "total_time": 30 } }
  ]
}
```

### 8.4 Temporal Grouping Example

```
WIDGET "Weekly Overview" TYPE KPI

tims = TIM
group by smallPeriod

PRIMARY:
  "hours": float = sum(tims.duration) / 60

END
```

With Global Temporal Context: bigPeriod=WEEK, smallPeriod=day

Result structure:
```json
{
  "groups": [
    { "key": "2026-01-06", "label": "Mon", "values": { "hours": 5.5 } },
    { "key": "2026-01-07", "label": "Tue", "values": { "hours": 4.0 } },
    { "key": "2026-01-08", "label": "Wed", "values": { "hours": 6.2 } },
    { "key": "2026-01-09", "label": "Thu", "values": { "hours": 3.0 } },
    { "key": "2026-01-10", "label": "Fri", "values": { "hours": 0 } },
    { "key": "2026-01-11", "label": "Sat", "values": { "hours": 0 } },
    { "key": "2026-01-12", "label": "Sun", "values": { "hours": 0 } }
  ]
}
```

Note: Empty periods (with no entries) are included in the result with zero values.

### 8.5 Table Widget with GROUP BY (Minimal Support)

```
WIDGET "Weekly Breakdown" TYPE TABLE

tims = TIM
group by smallPeriod

COLUMNS: "Productive", "Meetings"

ROWS:
  "Time":
    sum(tims.time("t"))
    sum(tims.time("m"))

END
```

One group produces one logical block of rows. Result structure includes columns and groups array.

### 8.6 Rules and Limitations

| Rule | Description |
|------|-------------|
| One dataset only | GroupBy v1 supports only one dataset per widget |
| Affects all formulas | GroupBy applies uniformly to all expressions in the widget |
| Missing attributes | Entries with null/missing attribute go to "unknown" group |
| Temporal context | smallPeriod value comes from Global Temporal Context |
| Group ordering | Attributes: alphabetical (unknown last). Temporal: chronological |
| Empty groups | Temporal grouping includes all buckets even if empty |

### 8.7 SmallPeriod Labels

Labels are human-readable and depend on context:

| smallPeriod | bigPeriod | Label Examples |
|-------------|-----------|----------------|
| hour | DAY | "08:00", "09:00", ... |
| day | WEEK | "Mon", "Tue", "Wed", ... |
| day | MONTH | "Jan 1", "Jan 2", ... |
| week | MONTH | "Week 1", "Week 2", ... |
| week | YEAR | "Week 1", "Week 2", ... |
| month | YEAR | "Jan", "Feb", "Mar", ... |

### 8.8 Future Extensions (Not Implemented)

- Nullable attribute handling options
- Multiple groupBy dimensions
- Cross-dataset grouping
- Sorting customization
- Nested grouping

---

## 9. Optional Fields and Null Values

### 9.1 Optional Field Syntax

Fields can be marked as optional using either syntax:

**Suffix syntax (preferred):**
```
METRIC EST
  timing: TIM
  adv?: int
  project?: string
END
```

**Explicit cardinality syntax:**
```
METRIC EST
  timing: TIM
  adv: int (0,1)
  project: string (0,1)
END
```

Both syntaxes set `minInstances = 0`, meaning the field may be omitted from input without validation errors.

### 9.2 Null Values vs Missing Fields

The system distinguishes between **null values** and **missing fields**:

| Concept | Definition | Cardinality | Example |
|---------|------------|-------------|---------|
| **Null value** | AttributeEntry exists but all typed columns are null | Counts as 1 instance | Formula returns null due to division by zero |
| **Missing field** | No AttributeEntry created for the field | Counts as 0 instances | User omits optional field from input |

**Key distinction:**
- A field with a **null value** satisfies cardinality 1..1 (one instance exists)
- A **missing field** fails cardinality 1..1 (zero instances) but passes 0..1 (optional)

### 9.3 When Null Values Occur

Null values are created when:

1. **Formula evaluates to null:** Division by zero, modulo by zero, or operations on null operands
2. **Aggregation on empty set:** Some aggregations return null when the input is empty

Example:
```
# TIM productivity formulas
net_productivity: float = self.time("t") / (self.time("t") + self.time("m") + self.time("p"))
```

If all time tokens are neutral (`n` only), the denominator is 0, and `net_productivity` evaluates to null. The AttributeEntry is still created (cardinality satisfied), but its value is null.

### 9.4 Widget Rendering of Null

Widgets render null values as `"—"` (em-dash), providing visual feedback that the value could not be computed rather than displaying 0 or an error.

### 9.5 Best Practices

| Scenario | Recommendation |
|----------|----------------|
| User input may be omitted | Use optional field (`?` suffix or `(0,1)`) |
| Formula may produce undefined result | Keep cardinality 1..1; null value satisfies it |
| Field must always have a value | Use required field (no `?`, default cardinality 1..1) |
| Do NOT use sentinel values | Avoid `""`, `0`, `-1` as "missing" indicators |

---

## 10. Search Keys and Reference Resolution

### 10.1 Overview

A **search key** is an optional per-metric declaration that designates a single field (or the subdivision string) as the unique lookup key for that metric. When a metric has a search key:

- Uniqueness is enforced: no two entries of that metric (for the same user) can share the same search key value.
- Reference resolution uses the search key instead of the default primary identifier.

### 10.2 Declaring a Search Key

#### On an attribute field

Use the `@key` annotation after the type:

```
METRIC BOOK
  title: string @key
  total_pages: int
  total_words: int
  words_per_page: float = self.total_words / self.total_pages
END
```

#### On subdivision

Use the `SUBDIVISION @key` directive inside the METRIC block:

```
METRIC PROJECT
  SUBDIVISION @key
  status?: string
END
```

#### Rules

| Rule | Description |
|------|-------------|
| At most one key | A metric can have 0 or 1 search key |
| String only | `@key` on attribute fields is only supported for `string` type |
| No formulas | `@key` cannot be applied to formula fields |
| Mutual exclusion | Cannot have both a `@key` field and `SUBDIVISION @key` |

### 10.3 Reference Resolution

When a field references another metric (e.g., `book: BOOK = subdivision[0]`), the system resolves it as follows:

1. If the target metric has a **search key**: lookup by search key value
2. Otherwise: fallback to primary identifier lookup (first string field)

#### Error cases

| Condition | Error |
|-----------|-------|
| 0 matches | `No matching instance found for metric "BOOK" where search key "Dune"` |
| >1 matches | `Ambiguous match for metric "BOOK" where search key "Dune" (N matches)` |

### 10.4 Duplicate Key Prevention

On insert, if a new entry would duplicate the search key value for the same metric and user, the pipeline rejects it:

```
Duplicate BOOK search key="Dune" (existing entry id=42)
```

This check runs as a pipeline step (`checkSearchKeyUniqueness`) after instance resolution and before formula evaluation.

### 10.5 Parser Syntax for Metric References

When providing values for metric reference fields, you can use:

- **Bare value**: `book:Dune` (parsed as string, used for search key lookup)
- **Quoted value**: `book:"Dune"` (explicit string, quotes stripped)
- **METRIC="value" syntax**: `book:BOOK="Dune"` (explicit metric + search key value)

For fields with formula `subdivision[0]`, the value is extracted automatically from the subdivision hierarchy:

```
READ:Dune/ch3;pages_read:12,duration:30
```

Here `Dune` is extracted from `subdivision[0]` and used to look up the BOOK entry by its search key.

### 10.6 Database Storage

Search key values are stored in the `search_key_value` column on the `entries` table. A partial unique index on `(user_id, definition_id, search_key_value)` enforces uniqueness at the database level.

### 10.7 Examples

#### Full workflow

Definitions:
```
METRIC BOOK
  title: string @key
  total_pages: int
  total_words: int
  words_per_page: float = self.total_words / self.total_pages
END

METRIC READ
  pages_read: int
  duration: int
  book: BOOK = subdivision[0]
  wpm: float = self.pages_read * self.book.words_per_page / self.duration
END
```

Entries:
```
BOOK;title:Dune,total_pages:240,total_words:60000
READ:Dune/ch3;pages_read:12,duration:30
```

- BOOK entry is created with `search_key_value = "Dune"`.
- READ entry resolves `book` by looking up BOOK where `title = "Dune"`.
- A second `BOOK;title:Dune,...` would be rejected as a duplicate.
