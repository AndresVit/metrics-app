# Formula Language Specification (DSL)

This document defines the formula DSL used to compute formula-based Fields in a `MetricDefinition`. Formulas are stored in Fields (not in Definitions) and are evaluated during the pipeline step `applyFormulas()`.

Important:
- This is a specification; implementation may be staged.
- If a feature is listed as an "Extension", do not implement it in the MVP unless explicitly requested.

## 1. Scope
### 1.1 MVP Scope (must implement first)
- Context variables: `self`, `parent`, `root`, `path`, `division`, `subdivision`
- Field navigation: `self.field`, `self.field.subfield`
- Arithmetic operators: `+`, `-`, `*`, `/`, `//`, `%`, `^`
- Aggregation functions: `sum`, `avg`, `min`, `max`, `count`
- List broadcasting rules for arithmetic between lists and scalars
- Filtering with `where()` on lists using: `subdivision in "X"` and equality checks
- Hierarchy indexing: `path[i]`, `division[i]`, `subdivision[i]`
- Basic error handling (missing fields, division by zero, invalid indexes)

### 1.2 Planned Extensions (not MVP unless explicitly requested)
- More advanced predicates in `where()`
- String functions (`contains`, `startsWith`, `regex`)
- Cross-entry queries beyond `convertToInstances()` resolution
- Circular dependency detection between formula fields
- User-defined functions/macros

## 2. Context Variables
Available identifiers in formulas:
- `self`: the current `MetricEntry` being evaluated
- `parent`: the parent `MetricEntry` (if any)
- `root`: the root `MetricEntry` of the current input pipeline
- `path`: full `HierarchyString` (Definition.code path + subdivision)
- `division`: alias of the definition part of the path (definition hierarchy tokens)
- `subdivision`: the user-provided hierarchical tokens for the Entry

Examples:
- `path[2]`
- `division[1]`
- `subdivision[0]`

Illustrative example (conceptual):
Input (user): `EST/TFG/Documentación 1700-1745 b30m10n5`

Interpretation:
- MetricName: Estudio (division)
- Asignatura: TFG (subdivision or derived token)
- Subtarea: Documentación
- Path: Estudio/TFG/Documentación
- Timings: 17:00-17:45 => duration 45; 30 productive, 10 unproductive, 5 neutral
- KPI (optional): 7.5

Note: Exact parsing rules live in the parser spec; this example is only to illustrate variable roles.

## 3. Field Navigation
Fields are accessed by name:
- `self.exercise`
- `self.exercise.weight`
- `self.book.pages`
- `parent.timing.duration`

If a field has multiplicity > 1, navigation yields a list:
- `self.exercise.weight` → list of numbers
- `self.exercise.reps` → list of numbers

## 4. Operators
Supported arithmetic operators:
- `+`
- `-`
- `*`
- `/`
- `//`
- `%`
- `^`

Examples:
- `(self.pages * self.book.words_per_page) / self.duration`
- `self.weight * self.reps`

## 5. Built-in Functions
Functions:
- `sum(list)`
- `avg(list)`
- `min(list)`
- `max(list)`
- `count(list)`

Examples:
- `sum(self.exercise.weight)`
- `avg(self.exercise.reps * self.exercise.weight)`

## 6. Filtering (`where`)
Lists can be filtered using `where()`.

Syntax:
- `list.where(condition)`

Minimum supported conditions (MVP):
- `subdivision in "m"`
	- Meaning: matches the token "m" and any subcategory such as "m/thk", "m/light", etc.
- Equality checks (`scalar == scalar`)

Example:
- `sum(self.exercise.where(subdivision in "m").weight)`

Notes:
- `in` is hierarchical prefix-match on `HierarchyString` tokens (e.g., `subdivision in "m"` matches "m", "m/thk", "m/sw", etc.)
- `subdivision` in `where()` refers to the subdivision of the list element being filtered
- Each Entry has its own subdivision (no inheritance from parent)

## 7. Hierarchy Access
Access hierarchy tokens by index:
- `path[i]`
- `division[i]`
- `subdivision[i]`

Example:
- Definition "TFG" has parent_definition "EST"
- Definition hierarchy (schema-level): EST → TFG
- User subdivision input (data-level): "documentation/formatting"
- division = ["EST", "TFG"]
- subdivision = ["documentation", "formatting"]
- path = ["EST", "TFG", "documentation", "formatting"]

Note: `parent_definition_id` defines Definition inheritance, not Entry traversal. This is distinct from Entry parent-child relationships (`parent_entry_id`).

Access:
- `path[0]` → "EST"
- `path[2]` → "documentation"
- `division[1]` → "TFG"
- `subdivision[0]` → "documentation"
- `parent.subdivision[1]` (if parent exists)

Note: `division.contains("GAL")` is an Extension, not MVP.

## 8. List Broadcasting
If a field returns a list, arithmetic can broadcast.

Example:
- `self.exercise.weight` → `[40, 35, 50]`
- `self.exercise.reps` → `[8, 10, 6]`

Then:
- `self.exercise.weight * self.exercise.reps` → `[320, 350, 300]`
- `sum(self.exercise.weight * self.exercise.reps)` → `970`

Broadcasting rules (MVP):
- list op scalar → list
- scalar op list → list
- list op list → element-wise, requires same length (else error)

## 8.1 Formula Field Output
Fields with `input_mode = formula` must always produce exactly one single (non-collection) value. Formulas may internally work with lists and aggregations, but the final result must be a single value. This is enforced by requiring `max_instances = 1` for all formula fields.

## 9. Engine Errors (MVP)
The engine must raise errors for:
- Referencing non-existent fields
- Invalid hierarchy index access
- Division by zero
- `list op list` with different lengths
- Requesting a scalar where a list is returned without aggregation (implementation-dependent but recommended)

Any error during formula evaluation causes the entire entry to be rejected (atomic entry creation).

## 10. Formula Evaluation Order
TODO (Future Improvement): The intended final design is dependency-based evaluation using topological sorting, allowing formula fields to reference other formula fields.

MVP Limitation: For the MVP, formulas may only reference input fields or fields that are evaluated before them in declaration order. No topological sorting is implemented. This limitation will be removed in a future version.

## 11. Formulas on Timing Metrics

TIM (Timing) entries use a multi-valued field `time_type` to store timing tokens. Each token value has its own subdivision representing the token letter.

### 11.1 Value-Level Subdivision

The `time_type` field stores multiple values, each with a subdivision:

| Token   | subdivision | valueInt |
|---------|-------------|----------|
| t15     | "t"         | 15       |
| m10     | "m"         | 10       |
| m/thk5  | "m/thk"     | 5        |
| n5      | "n"         | 5        |

Subdivisions support hierarchies (e.g., "m/thk" is a subcategory of "m").

### 11.2 The time() Helper

TIM entries have a built-in `time(base)` method for aggregating time by category:

```
self.time("t")   # Sum of all t and t/* values
self.time("m")   # Sum of all m and m/* values
self.time("p")   # Sum of all p and p/* values
self.time("n")   # Sum of all n and n/* values
```

Valid bases: `t`, `m`, `p`, `n`

Behavior:
- Returns the SUM of all `time_type` values whose subdivision starts with the base
- Matches exact base ("t") and subcategories ("t/deep", "t/shallow")
- Returns 0 if no matching values exist
- Returns FORMULA_ERROR for invalid bases

Example with tokens `t15m10m/thk5`:
- `self.time("t")` → 15
- `self.time("m")` → 15 (10 + 5, includes m and m/thk)
- `self.time("p")` → 0

### 11.3 Productivity KPIs

TIM defines four computed productivity metrics:

**gross_productivity** - Productive time as fraction of total duration:
```
self.time("t") / self.duration
```

**net_productivity** - Productive time as fraction of tracked time (excluding neutral):
```
self.time("t") / (self.time("t") + self.time("m") + self.time("p"))
```

**internal_productivity** - Productive time within focused work (t + m):
```
self.time("t") / (self.time("t") + self.time("m"))
```

**external_productivity** - Focused work as fraction of all tracked time:
```
(self.time("t") + self.time("m")) / (self.time("t") + self.time("m") + self.time("p"))
```

### 11.4 Token Semantics

By convention:
- `t` = task / productive work
- `m` = meeting / collaborative work
- `p` = planning / preparation
- `n` = neutral / breaks (excluded from productivity calculations)

Token subcategories (e.g., `m/thk` for thinking, `m/sw` for software) are aggregated under their base category.

### 11.5 Division by Zero

If the denominator is zero (e.g., no t, m, or p tokens), the formula returns a FORMULA_ERROR. This is existing behavior for all division operations.

## 12. Widget Aggregations

Widgets use a different evaluation context than entry formulas. While entry formulas operate on a single entry (`self.field`), widget expressions operate on collections of entries.

### 12.1 Collection Context

In widgets, expressions reference a dataset alias that represents all entries matching the query:

```
tims = TIM

"total": int = sum(tims.duration)
```

Here `tims` is a collection of all TIM entries matching the current temporal context (day/week/month/year).

### 12.2 Aggregation Functions (Widget Context)

| Function | Description | Example |
|----------|-------------|---------|
| `sum(collection.field)` | Sum of field values | `sum(tims.duration)` |
| `avg(collection.field)` | Average of field values | `avg(reads.pages_read)` |
| `count(collection)` | Count of entries | `count(tims)` |

### 12.3 time() in Widget Context

The `time()` helper works on TIM collections to aggregate time values across all entries:

```
sum(tims.time("t"))   # Total productive time across all TIM entries
sum(tims.time("m"))   # Total meeting time across all TIM entries
```

This differs from entry-level `self.time("t")` which operates on a single entry.

### 12.4 Arithmetic in Widgets

Widget expressions require scalar values for arithmetic. Use aggregations first:

```
# Correct: aggregate then divide
"productivity": float = sum(tims.time("t")) / sum(tims.duration)

# Error: cannot divide collections
"wrong": float = tims.time("t") / tims.duration
```

### 12.5 Empty Collections

If no entries match the query:
- `sum()` returns 0
- `avg()` returns 0
- `count()` returns 0

This prevents division-by-zero in common patterns when checking for data presence.

---
End of formula specification.