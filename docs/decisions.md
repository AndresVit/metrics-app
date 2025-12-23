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