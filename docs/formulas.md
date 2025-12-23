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

---
End of formula specification.