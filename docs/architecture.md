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
  adv: int
  project: string
END
```

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