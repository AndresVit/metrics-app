Status: MVP pipeline complete and tested end-to-end.

## Progress

### Completed

- `docs/` structure created: architecture.md, db-schema.md, formulas.md, decisions.md
- Architecture and domain model frozen
- Formula language (MVP) defined
- Tag model finalized (tags implemented as Fields)
- Supabase database schema finalized
- Documentation updated to reflect final decisions
- TypeScript domain models implemented
- Parsing layer implemented:
  - Definitions parsed from text format (supports formulas)
  - Entries parsed from raw user input
- Sandbox environment created (`dev/`):
  - Text-based definitions and entries
  - End-to-end execution entry point
  - Clear logging and error reporting
- Pipeline fully working for MVP:
  - populateFromSubdivision: hierarchy formulas (subdivision[n], division[n], path[n])
  - convertToInstances: primary identifier resolution
  - applyFormulas: self.field, self.metric.field, arithmetic
  - validateCardinalities: min/max instance validation
- BOOK/READ example runs end-to-end successfully

### Numeric Datatype Model (Frozen)

- `int`: integer values only (validated at input)
- `number`: any numeric value (decimals allowed)
- Internally, all numeric values handled as JavaScript `number`
- DB storage: `value_int` for int, `value_float` for number

### Formula Fields (MVP Rules)

- Formula fields always produce exactly ONE scalar value
- Formula fields always create/update exactly ONE AttributeEntry
- Formula-generated AttributeEntries inherit parent entry subdivision
- Supported: `self.field`, `self.metric.field`, arithmetic (`+ - * /`)
- Hierarchy formulas: `subdivision[n]`, `division[n]`, `path[n]`

### Next steps

- Persist entries to Supabase
- Expose minimal API layer
- Build initial React UI
- Extend formula engine (aggregations, filters) as needed
