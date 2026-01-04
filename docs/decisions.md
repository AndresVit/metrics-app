# Design Decisions

Key architectural decisions to avoid redesign and ambiguity.

## 1. Definitions are user-scoped
All Definitions (metrics and attributes) belong to a user.

Rationale:
- Full personalization
- No schema collisions
- Easier future import/export of definitions

## 2. Formulas live in Fields, not Definitions
Formulas are attached to Fields instead of Definitions.

Rationale:
- The same Definition can appear in different metrics with different logic
- Formula behavior is context-dependent

## 3. Fields have explicit names
Each Field has a mandatory name.

Rationale:
- Prevents ambiguity when the same Definition appears multiple times
- Enables clear and readable formula expressions
- Auto-generated names are allowed but must be unique

## 4. HierarchyString stored as text
HierarchyString is stored as plain text in the database.

Rationale:
- Simplicity
- Easy indexing and querying
- Can be evolved later if needed

## 5. Typed value columns for AttributeEntry
Attribute values are stored in typed columns instead of JSON.

Rationale:
- Better performance
- Easier aggregation and analytics
- Avoids runtime casting errors

## 6. Deterministic pipeline
Entry creation follows a strict ordered pipeline: parseInput → convertToInstances → applyFormulas → validateCardinalities → persist.

Note: There is no special "populateFromSubdivision" step. Values derived from subdivision are handled via normal formulas (e.g., `formula = subdivision[1]`).

Rationale:
- Predictability
- Clear separation of responsibilities
- Easier debugging and testing

## 7. No hidden side effects
Each pipeline step:
- Reads only what previous steps produced
- Does not mutate global state
- Can be unit tested independently

## 8. Primary identifier field for instance resolution
Each MetricDefinition has a single, explicit primary identifier field.

Requirements:
- Must be a Field of the MetricDefinition
- Must have input_mode = input
- Must have datatype = string or int
- Must have cardinality exactly 1

`convertToInstances` resolves textual references by equality lookup on the primary identifier field value. Errors if no match or multiple matches found.

## 9. Division vs subdivision
- `division`: hierarchy derived from Definition code and parent_definition chain (schema-level)
- `subdivision`: hierarchy provided by user in Entry input (data-level)
- `path`: division + subdivision concatenated
- `category` is separate and NOT part of path

Note: `parent_definition_id` defines Definition inheritance, distinct from Entry parent-child (`parent_entry_id`).

## 10. Formula fields produce one instance
Fields with input_mode = formula must have max_instances = 1. Formulas may aggregate lists internally, but the result is always a single instance.

## 11. Formula evaluation order
TODO (Future): Dependency-based evaluation using topological sorting.

MVP: Formulas may only reference input fields or fields evaluated before them in declaration order. No topological sorting implemented yet.

## 12. Tags are modeled as Fields
Tags are implemented using the existing Field mechanism. There is exactly one TagDefinition, which is an AttributeDefinition (datatype = hierarchyString). MetricDefinitions include one Field named `tag` with base_definition = TagDefinition, input_mode = input, min_instances = 0, and max_instances = unlimited. Each concrete tag is an AttributeEntry where subdivision = tag key (e.g., "place") and value = tag value (e.g., "library/upstairs"). Tags do not require schema changes per tag, participate in the normal Entry pipeline, and can be used in formulas and analytics like any other AttributeEntry.

## 13. Atomic entry creation
Entry creation is atomic. Any error in the pipeline causes the entire entry to be rejected. No partial persistence. Preview mode runs the full pipeline without persisting.

## 14. HierarchyString delimiter
The delimiter for HierarchyString is `/`.

## 15. Definition.id vs Definition.code
- `id` is the stable primary key (does not change)
- `code` is a human-readable semantic identifier (may change)

## 16. Field.name auto-generation
Default Field.name is derived from base_definition.display_name:
- Lowercase
- Replace spaces with underscores
- Strip non-alphanumeric characters (except underscores)
- On collision, append _1, _2, etc.

Example: "Words per Page" → "words_per_page"

## 17. Subdivision per Entry
Each Entry (root and child) has its own subdivision. No implicit inheritance from parent Entry.

## 18. Category is UI-only
Definition.category is used for UI grouping only. It is not part of path and not accessible from the formula DSL.

## 19. Structured input for MVP
Textual input grammar is out of scope for MVP. parseInput accepts structured input (JSON or equivalent).

## 20. Timing modeled as a metric (TIM)
Timing data is represented as a normal MetricDefinition (TIM) rather than a special construct.

Rationale:
- Consistency with the rest of the domain model
- TIM entries can be queried and analyzed like any other metric
- Formulas can reference TIM fields (duration, time_type) normally
- No special-case handling in the pipeline

## 21. One parent entry per timing line
Each timing line generates one TIM entry and one parent metric entry (e.g., EST). A timing block with 3 lines produces 6 entries (3 TIM + 3 parent).

Rationale:
- Each timing line represents a distinct time interval
- Enables per-line attribute overrides (e.g., different `adv` values)
- Allows fine-grained tracking and filtering
- Matches the natural interpretation: each line = one logged activity

## 22. Inline metric entries instead of children[]
Metric references use inline embedding via `metricEntry` in AttributeValueInput, not the `children[]` array.

Rationale:
- Fields with metric references behave consistently (all references go through fields)
- Cardinality validation works naturally (counts children tagged with fieldId)
- Clear ownership: TIM is the value of the timing field, not an orphan child
- Eliminates ambiguity about what children[] means in the domain model

The `children[]` array exists only for internal pipeline use and must not appear in parser output.

## 23. Each EST entry has exactly one TIM
The `timing` field on EST has cardinality (1,1): exactly one TIM per EST entry.

Rationale:
- Simplifies the data model: one timing line = one TIM + one EST
- Multiple timing lines produce multiple EST entries, not one EST with multiple TIMs
- Enables attribute overrides per timing line
- Matches user mental model: "this time block had these attributes"

## 24. Timing parsing before pipeline validation
The timing parser (TimingParser) runs before the main pipeline. It transforms the timing DSL into structured MetricEntryInput objects.

Rationale:
- Separation of concerns: parsing vs. domain logic
- Parser can reject invalid blocks early (overlapping times, invalid tokens)
- Pipeline receives valid, structured input
- Allows multiple parser implementations (timing, default) via a registry

## 25. time() helper instead of generic filtering
Productivity formulas use an explicit `self.time(base)` helper instead of generic SQL-like filtering syntax.

Rationale:
- Simple and explicit: `self.time("t")` is clearer than `sum(self.time_type.where(subdivision in "t"))`
- Domain-specific: encapsulates the aggregation-by-subdivision pattern for timing data
- Constrained: only valid bases (t, m, p, n) are allowed, preventing errors
- Returns 0 for missing categories, simplifying formula logic

The helper aggregates by base prefix, so `self.time("m")` includes "m", "m/thk", "m/sw", etc.