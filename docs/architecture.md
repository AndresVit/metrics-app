# Architecture

## 1. Objective
The goal of this project is to build a web application where each user can define their own metrics (Definitions) and register instances (Entries). Each metric is composed of Fields with cardinality constraints and optional formulas. The system supports nested metrics (metrics containing other metrics) and tags. Automatic calculations are performed through a custom formula language evaluated by an internal engine.

Architecture priorities:
- Full user-level customization
- Deterministic data processing
- Extensibility
- Fast iteration during development

### 1.5. Conceptual Overview: Definitions and Entries
The system is built around two core concepts: Definitions and Entries.

Definitions describe what can be measured. They define the schema of a metric, including its structure, fields, and calculation rules. For example, a user may define a Reading metric with fields such as:
- Book (a metric with its own attributes)
- Pages read (integer)
- Time spent reading (integer)
- Words per minute (computed field)

Definitions are user-specific and describe structure only; they do not contain data.

Fields are contextual appearances of Definitions inside a metric. A Field may represent:
- an attribute (e.g. pages read, duration)
- or another metric (e.g. Book), which itself has attributes

Fields define:
- cardinality (how many instances are allowed)
- whether the value is user-provided or computed via a formula

Entries represent actual logged data. Each Entry is an instance of a Definition created by the user at a specific time. A MetricEntry may contain multiple subentries (attributes or submetrics), forming a tree structure.

In summary:
- Definitions define structure
- Fields define how Definitions are used inside a metric
- Entries store concrete user data following those Definitions

#### One compact example: Reading Session

Definition:
- MetricDefinition: Reading
- Fields:
  - book (Metric, 1)
  - pages (Attribute, int, input)
  - duration (Attribute, int, input)
  - wpm (Attribute, formula = (pages * book.words_per_page) / duration)

Entry:
- User logs: Reading / Dune / chapter_1
  - pages = 20
  - duration = 30
  - book = "Dune"
  - wpm is computed automatically


## 2. Core Concepts
### 2.1 HierarchyString
A HierarchyString represents a hierarchical path-like structure.

Fields:
- plain_text: string (example: "EST/BUS/reading")
- categories: ordered list of strings (example: ["EST", "BUS", "reading"])

HierarchyString is used for:
- Definition categories
- Entry subdivisions
- Path-based formula resolution

The delimiter for HierarchyString is `/`.

Path composition:
- `division`: hierarchy derived from the Definition's code and its parent_definition chain. This is a property of the Definition itself (schema-level), not Entry traversal.
- `subdivision`: hierarchy provided by the user when creating an Entry (data-level)
- `path`: concatenation of division + subdivision
- `category` is separate and NOT part of path

Note: `parent_definition_id` defines Definition inheritance (e.g., "EST/UNI" inherits from "EST"), which determines the `division` tokens. This is distinct from Entry parent-child relationships (`parent_entry_id`).

Example:
- Definition "TFG" has parent_definition "EST"
- Definition hierarchy: EST → TFG
- User subdivision input: "documentation/formatting"
- division = ["EST", "TFG"]
- subdivision = ["documentation", "formatting"]
- path = ["EST", "TFG", "documentation", "formatting"]

## 3. Definitions (User Schema)
Each user owns their own set of Definitions. Definitions describe structure, not data.

### 3.1 Definition (abstract)
Common base for all definitions.

Fields:
- id: string (stable primary key)
- user_id: UUID
- type: metric | attribute
- code: string (human-readable semantic identifier, may change; example: EST, TMG, SUB)
- display_name: string
- category: HierarchyString (example: productive/study; used for UI grouping only, not part of path or DSL)
- parent_definition_id: optional string (used for subdefinitions, example: EST/THE).

### 3.2 AttributeDefinition
Extends Definition when type = attribute.

Additional fields:
- datatype: int | float | string | bool | timestamp | hierarchyString

### 3.3 MetricDefinition
Extends Definition when type = metric.

Additional fields:
- fields: list of Field objects
- primary_identifier_field_id: string (references a Field that serves as the unique identifier for instances)

The primary identifier field must:
- have input_mode = input
- have datatype = string or int
- have cardinality exactly 1 (min_instances = 1, max_instances = 1)

MetricDefinitions define the structure of a metric but do not store formulas directly.

## 4. Fields
A Field represents a concrete appearance of a Definition inside a MetricDefinition. Fields are contextual and not reusable across metrics. Each Field belongs to exactly one MetricDefinition.

### 4.1 Field
Fields:
- id: string
- user_id: UUID
- metric_definition_id: string
- name: string (logical identifier used in formulas; must be unique within a MetricDefinition; auto-generated from base_definition.display_name if not provided: lowercase, spaces to underscores, strip non-alphanumeric; on collision append _1, _2, etc.)
- base_definition_id: string (references a Definition)
- min_instances: integer
- max_instances: integer or null (null means unlimited)
- input_mode: input | formula
- formula: string (optional, only if input_mode = formula)

Constraints:
- Fields with input_mode = formula must have max_instances = 1 (formulas always produce exactly one instance)

Rationale:
- The same Definition may appear multiple times in a metric with different meanings.
- Formulas are attached to Fields, not Definitions, because logic is context-dependent.

## 5. Entries (User Data)
Entries are concrete instances of Definitions created by the user.

### 5.1 Entry (abstract)
Fields:
- id: integer
- user_id: UUID
- definition_id: string
- parent_entry_id: optional integer (used to form entry trees)
- timestamp: datetime (when the logged event occurred)
- subdivision: HierarchyString (user-defined hierarchical context; each Entry has its own subdivision, no inheritance from parent)
- comments: string

### 5.2 MetricEntry
Extends Entry when the instance represents a metric.

Characteristics:
- May contain multiple subentries
- Subentries are linked via parent_entry_id
- Subentries can be MetricEntry or AttributeEntry
- MetricEntry does not explicitly store children; hierarchy is inferred from the database

### 5.3 AttributeEntry
Extends Entry when the instance represents an attribute value.

Additional fields:
- field_id: string (references the Field within the parent metric)
- value: stored in a typed column depending on datatype (only one typed value column is populated per AttributeEntry)

### 5.4 Tags
Tags are implemented using the existing Field mechanism.

There is exactly one TagDefinition, which is an AttributeDefinition (datatype = hierarchyString).

MetricDefinitions include one Field named `tag`:
- base_definition = TagDefinition
- input_mode = input
- min_instances = 0
- max_instances = unlimited (null)

Each concrete tag is an AttributeEntry:
- field = tag
- subdivision = tag key (e.g., "place", "mood")
- value = tag value (e.g., "library/upstairs")

Example:
- tag (subdivision = "place", value = "library/upstairs")
- tag (subdivision = "mood", value = "focused")

Tags:
- are not declared individually as Fields
- do not require schema changes per tag
- participate in the normal Entry pipeline
- can be used in formulas and analytics like any other AttributeEntry

## 6. Entry Creation Pipeline
Creating a MetricEntry follows a strict deterministic pipeline.

1. parseInput
	- Accept structured input (JSON or equivalent); textual grammar is out of scope for MVP
	- Identify target MetricDefinition
	- Create initial MetricEntry
	- Create child entries for explicit input fields
	- Extract path and subdivision
2. convertToInstances
	- Resolve textual identifiers into existing MetricEntry instances
	- Each MetricDefinition has a primary identifier field used for lookup
	- Lookup is done by equality on the primary identifier field value
	- If no match is found → error
	- If more than one match is found → error (ambiguous reference)
	- Example: book code "Dune" → BookEntry instance with primary identifier "Dune"
	- Enables formulas to access attributes of referenced metrics
3. applyFormulas
	- Evaluate all formula-based Fields
	- Supported operations: arithmetic, field navigation, aggregation over multiple instances
	- Uses the formula language defined in docs/formulas.md
	- Formula fields always produce exactly one instance
	- TODO: MVP assumes formulas only reference input fields or already-evaluated fields; future improvement will use topological sorting for dependency-based evaluation
4. validateCardinalities
	- Validate min_instances and max_instances constraints per Field
	- Detect missing or excessive values
	- Reject invalid entries
5. persist
	- Persist MetricEntry and all subentries
	- Maintain parent_entry_id relationships
	- Ensure user_id consistency

Entry creation is atomic: any error in the pipeline causes the entire entry to be rejected. No partial persistence occurs. A preview mode can run the full pipeline without persisting to validate entries before committing.

### 6.1 Formula Engine

The formula engine (`src/pipeline/formulaEngine.ts`) is a generic expression evaluator that powers the `applyFormulas` step. It is designed to be domain-agnostic.

**Core capabilities:**
- Arithmetic operators: `+`, `-`, `*`, `/`, `//`, `%`, `^`
- Aggregation functions: `sum`, `avg`, `min`, `max`, `count`
- Field navigation: `self.field`, `parent.field`, `root.field`
- Context variables: `self`, `parent`, `root`, `path`, `division`, `subdivision`
- List operations and broadcasting
- Filtering with `where()` clauses

**Domain-specific extensions:**

The engine supports domain-specific helpers that extend its capabilities for particular metric types. These are currently hardcoded but should eventually be registered by domain modules.

Current extensions:
- `time(base)`: TIM timing aggregation helper (see Section 8)

Domain helpers are invoked as method calls (e.g., `self.time("t")`) and provide semantic operations specific to their domain's data model.

## 7. Design Guarantees
- Each user operates on an isolated schema
- Definitions are immutable during entry evaluation
- Pipeline stages are independent and deterministic
- No hidden side effects between stages

## 8. Timing System

The timing system allows users to log time-based activities with fine-grained categorization of how time was spent.

For the complete Timing DSL specification, see [docs/dsl.md](dsl.md).

### 8.1 TIM Metric Definition

TIM (Timing) is a normal MetricDefinition with the following fields:

**Input fields:**
- `time_init`: int (minutes from midnight, e.g., 750 = 12:30)
- `time_end`: int (minutes from midnight, e.g., 790 = 13:10)
- `duration`: int (time_end - time_init, in minutes)
- `time_type`: int with cardinality (1,n) - multi-valued field for timing tokens

**Computed KPI fields:**
- `gross_productivity`: number = self.time("t") / self.duration
- `net_productivity`: number = self.time("t") / (self.time("t") + self.time("m") + self.time("p"))
- `internal_productivity`: number = self.time("t") / (self.time("t") + self.time("m"))
- `external_productivity`: number = (self.time("t") + self.time("m")) / (self.time("t") + self.time("m") + self.time("p"))

The `time_type` field stores timing token values (e.g., t15, m10, n5) where:
- Each token becomes a separate AttributeEntry
- The token letter is stored as the Entry's subdivision (e.g., "t", "m", "n", "m/thk")
- The token value is stored as valueInt (e.g., 15, 10, 5)

The `time(base)` helper aggregates values by base category (t, m, p, n), including subcategories.

### 8.2 Parent Metrics Referencing TIM

Metrics like EST (Study) reference TIM via a required field:

```
METRIC EST
  timing: TIM
  adv?: int
  project?: string
END
```

The `?` suffix marks `adv` and `project` as optional (cardinality 0..1). Optional fields may be omitted from user input without causing validation errors. See [docs/dsl.md](dsl.md#9-optional-fields-and-null-values) for details on optional field syntax and the distinction between null values and missing fields.

The `timing` field:
- Has baseDefinitionId = TIM (a metric reference)
- Is required (minInstances = 1)
- Uses inline metric entry embedding (not identifier lookup)

### 8.3 Entry Structure

Each timing line produces two entries:
1. One TIM MetricEntry containing time data and tokens
2. One parent MetricEntry (EST) referencing that TIM via the timing field

The TIM entry has `parent_entry_id` set to the parent entry's ID for reverse navigation.

### 8.4 Inline Metric Entries

When a field references another metric, the value can be provided as an inline MetricEntryInput:

```typescript
{
  fieldId: "field-est-timing",
  values: [{ metricEntry: timEntryInput }]
}
```

The pipeline processes inline entries by:
1. Recursively building the nested entry with correct parent_entry_id
2. Tagging the result with the field's ID for cardinality validation
3. Adding it to the parent entry's children

Important: The `children[]` array in MetricEntryInput is NOT part of the domain model. Parsers must use field-based inline entries instead.

### 8.5 Validation

- Token values must not exceed duration
- Time ranges must be ordered and non-overlapping within a block
- If any timing line is invalid, the entire block is rejected (atomic creation)

## 9. TIM Aggregations (Design)

This section describes the architectural approach for aggregating data across multiple TIM entries. This is design guidance only; implementation is not part of MVP.

### 9.1 Aggregation Concepts

**Atomic unit:** The TIM entry is the fundamental unit of time tracking. Each TIM represents a single, indivisible time interval with its categorized breakdown.

**Aggregation scopes:**

| Scope | Description | Filter Criteria |
|-------|-------------|-----------------|
| Session | Consecutive TIM entries with no time gaps | Computed from time adjacency |
| Day | All TIM entries within a calendar day | timestamp date |
| Project | All TIM entries for a specific project | parent.project field |
| Metric | All TIM entries under a specific parent metric type | parent definition (EST, READ, etc.) |
| Category | All TIM entries within a subdivision hierarchy | subdivision prefix match |

### 9.2 Sessions

A **session** is a sequence of consecutive TIM entries with no time gaps between them.

**Definition:**
- TIM entries A and B are adjacent if A.time_end == B.time_init
- A session is a maximal sequence of adjacent TIM entries
- Session boundaries occur where there is a time gap

**Properties:**
- Sessions are **derived**, not stored
- Session boundaries are **computed at query time**
- A single timing block typically produces one session (no gaps)
- Multiple timing blocks may form one session if times are continuous

**Example:**
```
Block 1: 0900-0930, 0930-1000  → Session 1
         (gap: 1000-1030)
Block 2: 1030-1100, 1100-1130  → Session 2
```

### 9.3 Aggregation Model

Aggregations operate on **sets of TIM entries** filtered by scope criteria.

**Primitive operations:**
```
sum(time("t"))     # Total productive time
sum(time("m"))     # Total meeting time
sum(time("p"))     # Total planning time
sum(time("n"))     # Total neutral time
sum(duration)      # Total time span
count()            # Number of TIM entries
```

**Derived ratios (computed from primitives):**
```
gross_productivity_agg = sum(time("t")) / sum(duration)
net_productivity_agg = sum(time("t")) / (sum(time("t")) + sum(time("m")) + sum(time("p")))
internal_productivity_agg = sum(time("t")) / (sum(time("t")) + sum(time("m")))
external_productivity_agg = (sum(time("t")) + sum(time("m"))) / (sum(time("t")) + sum(time("m")) + sum(time("p")))
```

**Note:** Aggregate ratios are NOT averages of per-TIM ratios. They are ratios of sums, which gives correct weighted results.

### 9.4 Formula Reuse

**TIM-level formulas** (gross_productivity, net_productivity, etc.) remain local to each TIM entry. They represent the productivity of that specific time interval.

**Aggregate-level KPIs** reuse the same semantic primitives (`time(base)`, `duration`) but operate on aggregated data:

| Level | Formula | Interpretation |
|-------|---------|----------------|
| TIM | `self.time("t") / self.duration` | Productivity of one interval |
| Session | `sum(time("t")) / sum(duration)` | Productivity of continuous work |
| Day | `sum(time("t")) / sum(duration)` | Daily productivity |
| Project | `sum(time("t")) / sum(duration)` | Project-level productivity |

The formula structure is identical; only the input set changes.

### 9.5 Visualization Implications

**Widget queries** filter TIM entries by:
- Time range (start/end timestamps)
- Project (parent.project value)
- Definition (parent metric type: EST, READ, etc.)
- Category (subdivision hierarchy prefix)

**Aggregations are computed dynamically** at query time:
1. Query returns filtered set of TIM entries
2. Client or API computes aggregations from the set
3. No precomputed aggregates are stored

**Typical widget patterns:**
- Daily summary: filter by date, aggregate by day
- Project dashboard: filter by project, aggregate totals
- Session view: compute session boundaries, show per-session stats
- Trend chart: filter by date range, aggregate by day/week

### 9.6 MVP Exclusions

The following are explicitly **NOT part of MVP**:

| Feature | Reason |
|---------|--------|
| Persisted sessions | Sessions are derived; storing them adds complexity and staleness risk |
| Precomputed aggregates | Dynamic computation is sufficient for expected data volumes |
| Materialized views | No query performance optimization needed yet |
| Background jobs | No scheduled aggregation or rollup tasks |
| Caching layer | Queries run against live data |

**MVP approach:** All aggregations are computed on-demand from the raw TIM entries. This keeps the system simple and ensures data consistency. Optimization can be added later if query performance becomes an issue.

## 10. Widget System

Widgets provide read-only aggregation views over persisted entries. They are computed on-demand and not persisted themselves.

### 10.1 Widget System

#### Overview

v2 follows a strict three-stage pipeline: **query → intermediate table → chart projection**.

```
Widget DSL source
        ↓
  parseWidgetDef()      → WidgetDef AST
        ↓
  analyzeWidget()       → ExecutionPlan
        ↓
  executeWidget()       → IntermediateTable
        ↓
  mapToChart()          → ChartOutput (per plot type)
```

Each stage is independently testable and has a single responsibility:
- **Parser** — text → canonical AST. Reports `line`/`col` on error.
- **Analyzer** — semantic validation, topological measure ordering, field resolution.
- **Executor** — DB queries, in-memory grouping, empty-bucket filling, measure computation, topk.
- **Chart mapper** — pure projection from `IntermediateTable` to typed chart output. Zero aggregation.

#### v2 DSL Syntax

```
widget "<name>" {
  data {
    source: <DEF> as <alias>
    [where: <expr>]
    group { [<dim>: <dim-expr>]* }
    [measure <name> = <agg-expr>]*
  }
  plot {
    type: bar | stacked_bar | line | donut | table | kpi
    [x: <dim-or-measure>]
    [y: <dim-or-measure>]
    [series: <dim>]
    [value: <measure>]
    [label: <dim>]
  }
}
```

**Group dimensions:**
```
x: period(day)           // temporal bucket (day | week | month | year)
x: period(week)
cat: alias.attr          // attribute dimension
top: topk(5, by: measure_name)  // top-k by a named measure
```

**Measure expressions:**
```
measure total = sum(alias.time("t"))         // sum of TIM label "t"
measure ratio = total / sum(alias.time("base"))
measure count = count(alias)
measure avg   = avg(alias.field)
```

**WHERE expressions:**
```
where: alias.parent.code in ["A", "B"]       // set membership
where: alias.parent.code not in ["X"]
where: alias.parent.code under "EST"         // hierarchical prefix (/)
where: alias.field > 5
where: expr1 and expr2
where: not expr
```

**Path expressions:**
- `alias.field` — direct attribute
- `alias.parent.code` — parent definition code (pseudo-property)
- `alias.time("label")` — sum of TIM time entries matching label exactly
- `alias.timeUnder("prefix")` — sum of TIM time entries under prefix (inclusive)

#### IntermediateTable

The executor produces:

```typescript
interface IntermediateTable {
  dimColumns: string[];      // dimension column names
  measureColumns: string[];  // measure column names
  rows: Record<string, string | number | null>[];
}
```

The chart mapper receives this and performs **projection only** — no re-aggregation.

#### Empty-group semantics

Period buckets are filled **before** measure computation using `addEmptyPeriodGroups()`. This ensures every expected bucket appears in the output even with no matching entries.

Aggregate semantics on empty groups:
- `sum(...)` → `0`
- `count(...)` → `0`
- `avg(...)`, `min(...)`, `max(...)` → `null`
- Arithmetic involving `null` → `null`

#### DSL versioning

Widgets stored in the DB have an explicit `dsl_version TEXT` column (`'v1'` or `'v2'`). Routing code always reads `widget.dslVersion` — it never parses the DSL text to determine routing.

#### Source files

| File | Role |
|------|------|
| `src/widget/ast.ts` | AST type definitions |
| `src/widget/lexer.ts` | Tokenizer with line/col tracking |
| `src/widget/parser.ts` | Recursive descent parser |
| `src/widget/analyzer.ts` | Semantic validation, ExecutionPlan |
| `src/widget/executor.ts` | DB queries, in-memory execution |
| `src/widget/chartMapper.ts` | Pure IntermediateTable → ChartOutput |
| `src/widget/runWidgetV2.ts` | Combined runner (parse → analyze → execute → map) |
| `src/widget/WidgetRepository.ts` | DB persistence (CRUD, versioning) |

#### Chart types

| Type | Plot fields |
|------|-------------|
| `kpi` | `value`, optional `comparison` |
| `bar` | `x` (dim), `y` (measure) |
| `stacked_bar` | `x` (dim), `y` (measure), `series` (dim) |
| `line` | `x` (dim), `y` (measure) |
| `donut` | `label` (dim), `value` (measure) |
| `table` | `x` (dim), `y` (measure), optional `series` |

#### API endpoints

- `POST /api/v2/run-widget` — run DSL ad-hoc (editor preview)
- `POST /api/widgets` — persist widget (`dslVersion: 'v2'`)
- `PATCH /api/widgets/:id` — update widget
- `GET /api/dashboards/:id/widgets` — load dashboard widgets (routes v1/v2 by `dsl_version`)

## 11. UI Layer

The UI layer provides a minimal web interface for running widgets.

### 11.1 Architecture

```
┌─────────────────┐     HTTP      ┌─────────────────┐
│  React Frontend │  ─────────>  │   API Server    │
│   (Vite, :5173) │  <─────────  │  (Express,:3001)│
└─────────────────┘     JSON     └─────────────────┘
                                         │
                                         ▼
                                  ┌─────────────────┐
                                  │  Widget System  │
                                  │  (runWidget)    │
                                  └─────────────────┘
                                         │
                                         ▼
                                  ┌─────────────────┐
                                  │    Supabase     │
                                  └─────────────────┘
```

### 11.2 Backend API

**Location:** `server/api.ts`

Primary endpoints:

| Method | Path | Input | Output |
|--------|------|-------|--------|
| GET | `/api/dashboard` | - | `{ widgets: [{ name, values }] }` |
| POST | `/api/run-widget` | `{ widgetSource: string }` | `{ success, name?, result?, error? }` |
| GET | `/api/widgets` | - | `{ success, widgets: [...] }` |
| GET | `/api/health` | - | `{ status: "ok", userId }` |
| GET | `/api/definitions` | - | `{ success, definitions: [...] }` |

**Primary entry point:** `GET /api/dashboard` is the main endpoint for frontend dashboard data. It returns pre-computed widget results as JSON.

**Features:**
- Uses fixed userId from `DEV_CONFIG` (no auth for MVP)
- CORS enabled for local development
- Structured error responses
- Vite dev server proxies `/api/*` to Express (port 3001)

### 11.3 Frontend

**Location:** `web/`

Single-page React application with multiple views:
- **Dashboard view:** Widget grid with KPI, Table, and Chart widgets
- **Data Entry view:** Simple mode (form) or Advanced mode (DSL textarea) with calendar preview
- **Calendar view:** Full-screen week visualization of TIM entries
- **Widget Runner:** Dev-only ad-hoc DSL testing view

**Component structure:**
- `web/src/App.tsx` — Main app, views, contexts, layout
- `web/src/components/ModeToggle.tsx` — Simple/Advanced toggle
- `web/src/components/dataEntry/` — Simple mode form components
- `web/src/widgets/` — Chart widget components

**Stack:**
- Vite (dev server, build)
- React + TypeScript
- Minimal CSS (no framework)
- Recharts (for chart widgets)

### 11.4 Running the UI

```bash
# Terminal 1: Start API server
npm run server

# Terminal 2: Start frontend
npm run web
```

Then open http://localhost:5173

### 11.5 MVP Scope

| Feature | Status |
|---------|--------|
| Widget DSL input | MVP |
| Run and display results | MVP |
| Error display | MVP |
| Widget persistence | MVP |
| Dashboard view (KPI, Table, Chart widgets) | MVP |
| Widget creation from UI | MVP |
| Widget editing from UI | MVP |
| Widget deletion with confirmation | MVP |
| Data Entry view (Simple + Advanced modes) | MVP |
| Calendar view (week) | MVP |
| Temporal context bar | MVP |
| Sidebar navigation | MVP |
| User authentication | Deferred |
| Simple mode for widget editing | Deferred |

## 12. Widget Persistence

Widgets can be persisted to the database and managed directly through the UI.

### 12.1 Lifecycle

```
Dashboard UI (create/edit/delete)
       ↓
  Widget API (POST/PATCH/DELETE)
       ↓
  widgets table (Supabase)
       ↓
  WidgetRepository
       ↓
  runWidget() execution
       ↓
  Dashboard UI (display results)
```

### 12.2 Storage

Widgets are stored in the `widgets` table:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | Owner |
| dashboard_id | UUID | Parent dashboard |
| name | TEXT | Widget name |
| dsl | TEXT | Full widget DSL source |
| type | TEXT | Widget type (KPI, TABLE, CHART) |
| order_index | INT | Display order within dashboard |
| created_at | TIMESTAMP | Creation time |

### 12.3 Widget Management

Widgets are created, edited, and deleted directly from the UI:

**Creating a widget:**
1. Click "+ Widget" button in dashboard header
2. Enter widget name
3. Select type (KPI only for now)
4. Enter widget DSL
5. Save to persist and execute

**Editing a widget:**
1. Click "E" (Edit) button on widget card
2. Modify name or DSL
3. Save to update and re-execute

**Deleting a widget:**
1. Click "×" (Delete) button on widget card
2. Confirm deletion
3. Widget is removed from dashboard and database

### 12.4 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/widgets` | List stored widgets |
| POST | `/api/widgets` | Create widget |
| PATCH | `/api/widgets/:id` | Update widget (name, dsl, reorder) |
| DELETE | `/api/widgets/:id` | Delete widget |
| GET | `/api/dashboards/:id/widgets` | Execute all widgets for dashboard |
| POST | `/api/run-widget` | Run ad-hoc widget DSL |

### 12.5 Dashboard

The dashboard UI:
1. Loads all widgets for the selected dashboard
2. Executes each widget with current temporal context
3. Renders results in a 2-column grid layout
4. Shows errors for failed widgets (DSL errors render inside widget card)
5. Provides controls for widget management (create, edit, delete, reorder)

## 13. Temporal Context

The Temporal Context provides a global state that controls the time range and aggregation granularity for all dashboard views.

### 13.1 State Model

```typescript
TemporalContext {
  bigPeriod: 'day' | 'week' | 'month' | 'year'  // Total time range
  smallPeriod: 'hour' | 'day' | 'week' | 'month' // Aggregation subdivision
  anchorDate: Date                               // Position of the range
}
```

**Rules:**
- `bigPeriod` defines the total time range displayed
- `smallPeriod` defines how data is grouped/aggregated within the range
- `anchorDate` defines where the range is positioned in time
- Navigation arrows shift `anchorDate` by one `bigPeriod` unit

### 13.2 UI Components

The Temporal Bar is a global top bar visible in all main views:

| Component | Description |
|-----------|-------------|
| Range selector | Segmented control for bigPeriod (Day/Week/Month/Year) |
| Group by selector | Dropdown for smallPeriod (Hour/Day/Week/Month) |
| Date navigation | Left/right arrows + clickable date display |
| Filters | Placeholder stub for future filter implementation |

### 13.3 Entry Timestamp Model

All entries use a single `timestamp` field normalized to 00:00:00 (start of day):

```
entry.timestamp = date at 00:00 of the day the entry belongs to
```

**Rules:**
- For entries with timings (TIM): `timestamp` is the day, timing blocks define hours/minutes
- For entries without timing: `timestamp` is sufficient
- No separate date field required
- Pipeline normalizes all timestamps to 00:00 automatically

### 13.4 Integration

**React Context:**
- `TemporalContextProvider` wraps the app at the root level
- `useTemporalContext()` hook provides access to state and actions
- Context changes trigger automatic dashboard refresh

**API Integration:**
- Dashboard fetches include `anchorDate` query parameter
- Backend filters entries by `timestamp` using date range from period
- All periods supported: DAY, WEEK, MONTH, YEAR (plus TODAY)

**Date Range Calculation:**
- DAY: `startOfDay(anchorDate)` to `startOfDay(anchorDate + 1)`
- WEEK: Monday 00:00 to following Monday 00:00
- MONTH: First of month to first of next month
- YEAR: Jan 1 to Jan 1 next year

### 13.5 MVP Scope

| Feature | Status |
|---------|--------|
| Global temporal context state | MVP |
| Temporal bar UI | MVP |
| Date navigation (arrows) | MVP |
| Date picker for anchorDate | MVP |
| Dashboard refresh on context change | MVP |
| All periods (DAY/WEEK/MONTH/YEAR) | MVP |
| Timestamp normalization to 00:00 | MVP |
| Division by zero → null | MVP |
| Filters | Deferred (stub only) |
| State persistence | Deferred (in-memory only)

## 14. Error Handling

### 14.1 Division by Zero

Division by zero returns `null` in both widgets and formula fields:

**Widget expressions:**
```typescript
// If sum(tims.duration) = 0
sum(tims.time("t")) / sum(tims.duration)  // Returns null, not error
```

**Formula fields in entries:**
```typescript
// If self.time("t") + self.time("m") + self.time("p") = 0
net_productivity: float = self.time("t") / (self.time("t") + self.time("m") + self.time("p"))
// Returns null, AttributeEntry is still created
```

**Behavior:**
- Division or modulo by zero returns `null`
- `null` propagates through subsequent arithmetic operations
- Aggregation functions (sum, avg, count) treat `null` as 0
- UI renders `null` values as "—" (em-dash placeholder)

**Cardinality with null values:**
- A formula field that evaluates to null still creates an AttributeEntry (with all typed columns null)
- This null-valued entry counts as 1 instance for cardinality validation
- A field with cardinality 1..1 is satisfied by a null-valued AttributeEntry
- This is distinct from a missing field (no entry created), which fails 1..1 cardinality

This design allows:
- Widgets to gracefully handle empty datasets without breaking the dashboard
- Formula-derived fields to remain in the schema even when undefined for specific entries

## 15. Data Entry View

The Data Entry View provides a dedicated interface for inputting entries and previewing them before persistence. It supports two modes: **Simple** (form-based) and **Advanced** (raw DSL textarea).

### 15.1 Purpose

The Data Entry View separates input from output:
- **Input:** Form-based entry (Simple mode) or raw DSL text (Advanced mode)
- **Output:** Visual calendar preview showing timings

This separation ensures:
- Users see exactly what they're about to insert
- Parse errors are caught before persistence
- Visual feedback aids data validation

### 15.2 Simple / Advanced Mode

A global toggle in the Temporal Bar switches between modes. The toggle only affects the Data Entry view (widget editing remains advanced-only for now).

**Simple mode:**
- Form-based UI: metric selector, subdivision, attributes, optional timing fields
- Generates raw DSL text from form state via `serializeSimpleEntry()`
- Feeds generated DSL into the same Preview/Insert pipeline as Advanced mode
- No new parser required — serialization produces DSL compatible with existing parsers

**Advanced mode:**
- Raw textarea for entering DSL directly (unchanged from original)
- Full flexibility for multi-entry timing blocks and advanced syntax

**Mode switching behavior:**
- Simple → Advanced: regenerates DSL from form state and places it in the textarea
- Advanced → Simple: for single entries, attempts to parse raw text into form state; multi-entry blocks remain advanced-only
- Mode state is lifted to the App component and passed to both TemporalBar and DataEntryView

### 15.3 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Data Entry View                           │
├─────────────────────────┬───────────────────────────────────┤
│                         │                                   │
│  Simple Mode:           │       Preview Panel               │
│  ┌───────────────────┐  │   ┌────────────────────────┐     │
│  │ Metric Typeahead  │  │   │  Day Calendar           │     │
│  │ Subdivision input │  │   │  ┌────┬────────────┐   │     │
│  │ Attributes (rows) │  │   │  │08:00├────────────┤   │     │
│  │ Timing (optional) │  │   │  │09:00├──[timing]──┤   │     │
│  └───────────────────┘  │   │  │10:00├──[timing]──┤   │     │
│  [Clear][Preview]       │   │  │11:00├────────────┤   │     │
│  [Insert]               │   │  └────┴────────────┘   │     │
│                         │   └────────────────────────┘     │
│  Advanced Mode:         │                                   │
│  ┌───────────────────┐  │                                   │
│  │ Textarea          │  │                                   │
│  │ (DSL input)       │  │                                   │
│  └───────────────────┘  │                                   │
│  [Clear][Preview]       │                                   │
│  [Insert]               │                                   │
└─────────────────────────┴───────────────────────────────────┘
```

### 15.4 Simple Mode Form

**Metric selector:** Searchable typeahead dropdown that filters MetricDefinitions by code or display name. Shows max 8 results. Click to select.

**Subdivision:** Text input for hierarchical context (e.g., "project/task").

**Attributes:** After selecting a metric, one row per field is rendered:
- Left: field name (with `?` indicator for optional fields)
- Right: input control (text for string, number for int/float)
- Optional fields (minInstances=0) can be left empty

**Timing fields:** Shown only for timing-capable metrics:
- Start time / End time (HH:MM inputs)
- t, m, p, n numeric minute fields (integers, default empty = 0)
- No subtype support in Simple mode (no "m/thk" etc.)

### 15.5 DSL Serialization

Simple mode generates raw DSL via `serializeSimpleEntry()` in `web/src/components/dataEntry/serializeSimpleEntry.ts`.

**Non-timing entry format:**
```
DEF_CODE[:subdivision];key:value,key:value
```

**Timing-capable entry format:**
```
DEF_CODE[:subdivision];key:value,key:value
HHMM-HHMM tXmYpZnW
```

The serializer:
- Skips empty attribute values
- Formats HH:MM → HHMM for timing lines
- Only includes non-zero timing tokens
- Supports adding new attribute types via `serializeAttributeValue()` (see section 15.11)

### 15.6 Components

| Component | Location | Purpose |
|-----------|----------|---------|
| DataEntryView | `web/src/App.tsx` | Main container, mode switching, Preview/Insert handlers |
| DayCalendarPreview | `web/src/App.tsx` | Daily timeline visualization |
| ModeToggle | `web/src/components/ModeToggle.tsx` | Simple/Advanced segmented control |
| SimpleEntryForm | `web/src/components/dataEntry/SimpleEntryForm.tsx` | Form-based entry UI |
| MetricTypeahead | `web/src/components/dataEntry/MetricTypeahead.tsx` | Searchable metric dropdown |
| TimingRow | `web/src/components/dataEntry/TimingRow.tsx` | Start/end time + t/m/p/n inputs |
| serializeSimpleEntry | `web/src/components/dataEntry/serializeSimpleEntry.ts` | Form state → DSL string |

### 15.7 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/entries/parse-preview` | Parse DSL without persisting, return timing data |
| POST | `/api/entries/insert` | Parse and persist entries |
| GET | `/api/timings?anchorDate=` | Get existing timings for a day |
| GET | `/api/definitions` | Get metric definitions for Simple mode form |

### 15.8 Definitions Endpoint

`GET /api/definitions` returns metric definitions with their fields for the Simple mode form. Response:

```json
{
  "success": true,
  "definitions": [
    {
      "code": "EST",
      "displayName": "Study",
      "timingCapable": true,
      "fields": [
        { "name": "adv", "type": "int", "optional": true, "inputMode": "input" },
        { "name": "project", "type": "string", "optional": true, "inputMode": "input" }
      ]
    }
  ]
}
```

The endpoint:
- Filters to metric definitions only (excludes attribute definitions like TIM itself)
- Only includes input-mode primitive fields (excludes formulas and metric reference fields)
- Determines timing capability by checking if any field's base definition is TIM

### 15.9 Date Handling

The Data Entry View uses the **anchorDate from the Temporal Context Bar** as the date for all entries:
- Timestamp is normalized to 00:00 of the anchor date
- Timing hours (time_init, time_end) are preserved from the DSL
- No date declarations in the DSL itself

### 15.10 Calendar Visualization

The DayCalendarPreview component:
- Displays 24-hour vertical timeline (00:00 to 24:00)
- Positions timing blocks by time_init and time_end
- Colors blocks by net_productivity (green=high, yellow=medium, orange=low)
- Differentiates persisted vs preview blocks (solid vs dashed border)
- Shows tooltip with time range and productivity on hover

### 15.11 Adding New Attribute Types

To support a new attribute type (e.g., `bool`, `timestamp`) in Simple mode:

1. Add the type to the `MetricField.type` union in `SimpleEntryForm.tsx`
2. Add a formatting case in `serializeAttributeValue()` in `serializeSimpleEntry.ts`
3. Add an appropriate input element in `SimpleEntryForm.tsx`'s attribute row renderer (e.g., checkbox for bool, date picker for timestamp)

Current supported types: `int`, `float`, `string`.

### 15.12 MVP Scope

| Feature | Status |
|---------|--------|
| Simple mode form-based entry | MVP |
| Advanced mode raw DSL textarea | MVP |
| Simple/Advanced mode toggle | MVP |
| Metric typeahead search | MVP |
| Attribute rendering from definitions | MVP |
| Timing fields for timing-capable metrics | MVP |
| DSL serialization from form state | MVP |
| Preview button (parse without persist) | MVP |
| Insert button (parse and persist) | MVP |
| Day calendar preview | MVP |
| Persisted vs preview visual distinction | MVP |
| Productivity-based coloring | MVP |
| Mobile responsive layout | MVP |
| Simple mode for widget creation | Deferred |
| Subtype time tokens in simple mode | Deferred |
| Multi-entry block editing in simple mode | Deferred |
| Week/month calendar view | Deferred |
| Editing existing entries | Deferred |
| Drag/resize timings | Deferred |

## 16. Calendar View

The Calendar View provides a full-screen week visualization of TIM entries. This is an output-only view, independent from the widget system.

### 16.1 Purpose

The Calendar View visualizes time tracking data in a traditional calendar format:
- **Week-based display:** 7 columns (Monday → Sunday)
- **Time-based positioning:** Vertical axis from 00:00 to 24:00
- **TIM entries only:** Shows timing blocks, not widget aggregations

This view is NOT a widget. It is a dedicated visualization that:
- Loads TIM entries directly from the database
- Uses the global Temporal Context Bar for navigation
- Does not support editing or interaction beyond viewing

### 16.2 Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Calendar View                              │
├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┤
│   Mon    │   Tue    │   Wed    │   Thu    │   Fri    │  Sat/Sun │
├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤
│ 00:00    │          │          │          │          │          │
│ ├────────┤          │          │          │          │          │
│ 01:00    │          │          │          │          │          │
│ ...      │ [timing] │          │ [timing] │          │          │
│ 09:00    │ [timing] │ [timing] │ [timing] │          │          │
│ ...      │          │ [timing] │          │          │          │
│ 24:00    │          │          │          │          │          │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
```

### 16.3 Data Flow

```
Temporal Context Bar (anchorDate)
       ↓
 CalendarView Component
       ↓
 GET /api/timings?period=WEEK&anchorDate=...
       ↓
 loadEntriesForWidget('TIM', { period: 'WEEK', ... })
       ↓
 Group timings by date
       ↓
 Render 7 day columns with timing blocks
```

### 16.4 Components

| Component | Location | Purpose |
|-----------|----------|---------|
| CalendarView | `web/src/App.tsx` | Main week calendar container |
| getWeekStart() | `web/src/App.tsx` | Calculate Monday of the week |
| getWeekDates() | `web/src/App.tsx` | Generate array of 7 dates |

### 16.5 Coloring

Timing blocks are colored based on `net_productivity`:

| Productivity | Color |
|--------------|-------|
| ≥ 0.7 (70%) | Green (#28a745) |
| 0.4 - 0.7 | Yellow (#ffc107) |
| < 0.4 | Red (#dc3545) |
| null (neutral) | Gray (#9e9e9e) |

### 16.6 Navigation

- Uses the global Temporal Context Bar
- Week calculation: Find Monday of the week containing `anchorDate`
- Navigation arrows move by `bigPeriod` (day/week/month/year)
- Today's column is highlighted with a blue tint

### 16.7 MVP Scope

| Feature | Status |
|---------|--------|
| 7-day week grid | MVP |
| TIM entry visualization | MVP |
| Productivity-based coloring | MVP |
| Today highlighting | MVP |
| Hover tooltip | MVP |
| Click logging (stub) | MVP |
| Month/year calendar view | Deferred |
| Editing/drag/resize | Deferred |
| Overlap resolution | Deferred |
| Text inside blocks | Deferred |